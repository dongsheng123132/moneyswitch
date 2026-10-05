import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import {
  createMoneyKey,
  parseUsdcToMicros,
  usedToday,
  usedTotal,
  listHistoryForKey,
  decideApproval,
  getApproval,
  ApprovalRequiredError,
  MoneySwitchError,
  type MoneyKeyRow,
} from "@moneyswitch/core";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import type Database from "better-sqlite3";
import { performPaidFetch, type PaidFetchInput, type SignerSource } from "../src/client.js";
import { createBalanceReader, type KnownBalanceReader } from "../src/balance.js";
import { BASE_SEPOLIA, TESTNET, type NetworkConfig } from "../src/networks.js";

/**
 * SPEC.md §6, "pick the chain the wallet can actually pay on": with several chains the seller accepts, the first one in
 * MONEYSWITCH_NETWORKS order whose USDC balance covers the price is used (not the seller's order); every chain known to be short and
 * nothing is signed (INSUFFICIENT_FUNDS); a chain whose balance cannot be read does not stop a payment. What needs no balance (the
 * per-request limit, max_price, the chain an approval was given for) is decided before one is read, and a wallet replaced while the
 * balance was being read pays nothing. Balances come from a fake reader injected into performPaidFetch: no test here reaches an RPC.
 */

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const PRICE = 10_000n;

interface Offer {
  network: NetworkConfig;
  amount?: string;
  asset?: string;
  extra?: Record<string, unknown>;
}

describe("performPaidFetch picks the chain by balance", () => {
  let tmpDir: string;
  let db: MoneySwitchDb;
  let sqlite: Database.Database;
  let wallet: LocalWalletDriver;
  let server: http.Server;
  let sellerUrl: string;
  let sellerHost: string;
  let key: MoneyKeyRow;

  /** What the seller offers, in ITS order, and whether it answers an unpaid request with the resource itself. */
  let offers: Offer[] = [];
  let free = false;
  let seen: { paid: boolean; paidNetwork: string | null }[] = [];
  /** Runs inside the seller once a SIGNED payment has reached it, before it answers: the time between our signature and the settlement. */
  let whilePaying: (() => Promise<void>) | null = null;
  /** The seller cuts the connection of a signed payment instead of answering: we never learn whether it was settled. */
  let cutPaid = false;

  /** The fake chain: caip2 -> balance, null = the RPC does not answer, no entry = same as null. */
  let balances = new Map<string, bigint | null>();
  let reads: Array<{ address: string; network: string }> = [];
  const reader: KnownBalanceReader = async (address, network) => {
    reads.push({ address, network: network.caip2 });
    return balances.get(network.caip2) ?? null;
  };

  const originalNetworks = process.env.MONEYSWITCH_NETWORKS;
  const enable = (...networks: NetworkConfig[]) => {
    process.env.MONEYSWITCH_NETWORKS = networks.map((n) => n.caip2).join(",");
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-balance-network-"));
    wallet = new LocalWalletDriver(tmpDir, { protect: false });
    await wallet.createWithPhrase();
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", async () => {
        const signature = req.headers["payment-signature"] ?? req.headers["x-payment"];
        const paid = typeof signature === "string";
        seen.push({
          paid,
          paidNetwork: paid ? (decodePaymentSignatureHeader(signature) as { accepted: { network: string } }).accepted.network : null,
        });
        if (paid && whilePaying) await whilePaying();
        if (paid && cutPaid) {
          req.socket.destroy();
          return;
        }
        if (paid || free) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ delivered: true }));
          return;
        }
        const paymentRequired = {
          x402Version: 2,
          error: "Payment required",
          resource: { url: `${sellerUrl}${req.url}`, description: "balance network seller", mimeType: "application/json" },
          accepts: offers.map((o) => ({
            scheme: "exact",
            network: o.network.caip2,
            amount: o.amount ?? PRICE.toString(),
            asset: o.asset ?? o.network.usdcAddress,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: o.network.usdcDomainName, version: o.network.usdcDomainVersion, ...o.extra },
          })),
        };
        res.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired as never),
        });
        res.end(JSON.stringify(paymentRequired));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${port}`;
    sellerHost = `127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const opened = openDb({ filePath: ":memory:" });
    db = opened.db;
    sqlite = opened.sqlite;
    key = newKey();
    offers = [];
    free = false;
    seen = [];
    whilePaying = null;
    cutPaid = false;
    balances = new Map();
    reads = [];
    enable(TESTNET, BASE_SEPOLIA);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
    if (originalNetworks === undefined) delete process.env.MONEYSWITCH_NETWORKS;
    else process.env.MONEYSWITCH_NETWORKS = originalNetworks;
  });

  /** A key for this seller: 10 USDC in all, 5 a day, 1 per request, unless a test says otherwise. */
  const newKey = (overrides: Partial<Parameters<typeof createMoneyKey>[1]> = {}) =>
    createMoneyKey(db, {
      name: "balance-network",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("5"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: [sellerHost],
      ...overrides,
    }).row;
  const fetchPaid = (
    readBalance: KnownBalanceReader | undefined = reader,
    extra: Pick<PaidFetchInput, "maxPrice" | "approvalId" | "url" | "method"> = {},
    source: SignerSource = wallet
  ) =>
    performPaidFetch(db, sqlite, key, source, { url: `${sellerUrl}/item`, host: sellerHost, method: "GET", ...extra }, { balanceReader: readBalance });
  const paidOn = () => seen.filter((r) => r.paid).map((r) => r.paidNetwork);
  const rowNetworks = () => listHistoryForKey(db, key.id, 50).map((r) => r.network);
  const failure = (run: () => Promise<unknown>) =>
    run().then(
      () => null,
      (e: unknown) => e
    );

  /** What must be true when nothing may leave the wallet: no signer lease, no payments row, no budget touched, nothing paid. */
  function expectNothingHappened(leased: { mock: { calls: unknown[] } }) {
    expect(leased.mock.calls, "the wallet's signer was never leased").toHaveLength(0);
    expect(listHistoryForKey(db, key.id, 50), "no payments row was written").toHaveLength(0);
    expect(usedToday(db, key.id), "no budget was reserved today").toBe(0n);
    expect(usedTotal(db, key.id), "no budget was reserved in total").toBe(0n);
    expect(paidOn(), "no signed payment reached the seller").toHaveLength(0);
    expect(wallet.inFlight).toBe(0);
  }

  describe("order: MONEYSWITCH_NETWORKS decides, not the seller", () => {
    it("pays on the first configured chain when both can pay, although the seller lists the other one first", async () => {
      offers = [{ network: BASE_SEPOLIA }, { network: TESTNET }];
      balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([TESTNET.caip2]);
      expect(rowNetworks()).toEqual([TESTNET.caip2]);
    });

    it("follows the configuration when it is the other way round, whatever order the seller uses", async () => {
      enable(BASE_SEPOLIA, TESTNET);
      balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      for (const sellerOrder of [[TESTNET, BASE_SEPOLIA], [BASE_SEPOLIA, TESTNET]]) {
        seen = [];
        offers = sellerOrder.map((network) => ({ network }));
        await fetchPaid();
        expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
      }
    });

    it("without a balance reader the seller's offers are still tried in configuration order (and nothing is refused)", async () => {
      offers = [{ network: BASE_SEPOLIA }, { network: TESTNET }];
      await performPaidFetch(db, sqlite, key, wallet, { url: `${sellerUrl}/item`, host: sellerHost, method: "GET" });
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });

    it("reads the balance of the wallet's own address on each chain the seller accepts, and of no other chain", async () => {
      enable(TESTNET, BASE_SEPOLIA);
      offers = [{ network: TESTNET }]; // the seller does not take Base Sepolia
      balances.set(TESTNET.caip2, 5_000_000n);
      await fetchPaid();
      expect(reads).toEqual([{ address: wallet.getAddress(), network: TESTNET.caip2 }]);
    });
  });

  describe("a chain that is known to be short is skipped", () => {
    it("pays on the second chain when the first holds less than the price", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, PRICE - 1n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
      expect(rowNetworks()).toEqual([BASE_SEPOLIA.caip2]);
    });

    it("counts a balance exactly equal to the price as enough", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, PRICE).set(BASE_SEPOLIA.caip2, 5_000_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });

    it("compares each offer's own price (a chain can cover one price and not another)", async () => {
      offers = [{ network: TESTNET, amount: "50000" }, { network: BASE_SEPOLIA, amount: "10000" }];
      balances.set(TESTNET.caip2, 20_000n).set(BASE_SEPOLIA.caip2, 20_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
    });
  });

  describe("every chain is known to be short: INSUFFICIENT_FUNDS, and nothing happens", () => {
    it("refuses with INSUFFICIENT_FUNDS, no lease, no payments row, no reservation, nothing signed or sent", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, PRICE - 1n);
      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid());
      expect(err).toBeInstanceOf(MoneySwitchError);
      expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
      expectNothingHappened(leased);
    });

    it("does the same with one chain enabled", async () => {
      enable(BASE_SEPOLIA);
      offers = [{ network: BASE_SEPOLIA }];
      balances.set(BASE_SEPOLIA.caip2, 0n);
      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid());
      expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
      expectNothingHappened(leased);
    });

    it("pays with one chain enabled when that chain can cover the price", async () => {
      enable(BASE_SEPOLIA);
      offers = [{ network: BASE_SEPOLIA }];
      balances.set(BASE_SEPOLIA.caip2, PRICE);
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
    });

    it("still pays once the wallet has been topped up (nothing was remembered against it)", async () => {
      offers = [{ network: TESTNET }];
      balances.set(TESTNET.caip2, 0n);
      await failure(() => fetchPaid());
      balances.set(TESTNET.caip2, 5_000_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });
  });

  describe("a chain whose balance cannot be read does not stop the payment", () => {
    it("tries the chain with a known sufficient balance before the one that could not be read", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, null).set(BASE_SEPOLIA.caip2, 5_000_000n); // the first (preferred) chain's RPC is down
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
    });

    it("falls back to the unreadable chain, in configuration order, when the readable one is short", async () => {
      offers = [{ network: BASE_SEPOLIA }, { network: TESTNET }];
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, null);
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
    });

    it("goes by configuration order when no chain can be read (today's behavior), never INSUFFICIENT_FUNDS", async () => {
      offers = [{ network: BASE_SEPOLIA }, { network: TESTNET }];
      await fetchPaid(); // `balances` is empty: every read answers null
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });

    it("treats a reader that throws like one that cannot read", async () => {
      offers = [{ network: TESTNET }];
      await fetchPaid(async () => {
        throw new Error("a reader is meant not to do this");
      });
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });

    it("pays on a real reader whose RPC fails (a rejected raw read is just unknown)", async () => {
      offers = [{ network: TESTNET }];
      await fetchPaid(createBalanceReader(async () => Promise.reject(new Error("connect ECONNREFUSED"))));
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });
  });

  describe("balances are not read when no payment is going to be made", () => {
    it("a free request (no 402) reads no balance", async () => {
      free = true;
      const leased = vi.spyOn(wallet, "leaseSigner");
      const result = await fetchPaid();
      expect(result.httpStatus).toBe(200);
      expect(result.paymentId).toBeNull();
      expect(reads).toHaveLength(0);
      expectNothingHappened(leased);
    });

    it("a 402 with nothing we could pay (a Permit2 request) is UNSUPPORTED_PAYMENT and reads no balance", async () => {
      offers = [{ network: TESTNET, extra: { assetTransferMethod: "permit2" } }];
      const err = await failure(() => fetchPaid());
      expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
      expect(reads).toHaveLength(0);
    });
  });

  describe("the 15 s cache", () => {
    /** The chain, seen through a real createBalanceReader on a clock the test moves. `balances` is the chain itself. */
    function cachedReader(clock: { now: number }) {
      const raw = vi.fn(async (_address: string, network: NetworkConfig) => balances.get(network.caip2) ?? 0n);
      const cached = createBalanceReader(raw, { now: () => clock.now });
      const readNetworks = () => raw.mock.calls.map((call) => call[1].caip2);
      return { raw, cached, readNetworks };
    }

    it("serves requests that pay nothing from the cache for 15 s, and reads again once it has expired", async () => {
      const clock = { now: 5_000_000 };
      const { raw, cached } = cachedReader(clock);
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }]; // both chains empty: nothing is ever signed

      await failure(() => fetchPaid(cached));
      expect(raw).toHaveBeenCalledTimes(2); // one read per chain the seller accepts
      await failure(() => fetchPaid(cached));
      clock.now += 14_999;
      await failure(() => fetchPaid(cached));
      expect(raw, "three requests inside 15 s: still the first two reads").toHaveBeenCalledTimes(2);

      clock.now += 1;
      await failure(() => fetchPaid(cached));
      expect(raw, "15 s after the first read: both chains are asked again").toHaveBeenCalledTimes(4);
    });

    it("a request the policy refuses before anything is signed leaves the cache as it was", async () => {
      const clock = { now: 5_000_000 };
      const { raw, cached } = cachedReader(clock);
      key = newKey({ dailyBudget: parseUsdcToMicros("0.005") }); // the price is within the limit, but not within what is left today
      offers = [{ network: TESTNET }];
      balances.set(TESTNET.caip2, 5_000_000n);

      for (let i = 0; i < 2; i++) {
        const err = await failure(() => fetchPaid(cached));
        expect((err as MoneySwitchError).code).toBe("DAILY_BUDGET_EXCEEDED");
      }
      expect(paidOn()).toHaveLength(0);
      expect(raw, "nothing was signed, so nothing was spent: the second request reuses the first read").toHaveBeenCalledTimes(1);
    });

    it("after a payment is signed on a chain, the next request reads that chain again (and only that chain)", async () => {
      const clock = { now: 5_000_000 };
      const { cached, readNetworks } = cachedReader(clock);
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);

      await fetchPaid(cached);
      expect(paidOn()).toEqual([TESTNET.caip2]);
      expect(readNetworks()).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);

      await fetchPaid(cached); // inside 15 s: Base's read is still good, Testnet's is from before the payment
      expect(readNetworks()).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2, TESTNET.caip2]);
      expect(paidOn()).toEqual([TESTNET.caip2, TESTNET.caip2]);
    });

    it("a chain our own payment emptied is not paid on again inside 15 s: the next request goes to the other chain, then INSUFFICIENT_FUNDS", async () => {
      const clock = { now: 5_000_000 };
      const { cached } = cachedReader(clock);
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, PRICE).set(BASE_SEPOLIA.caip2, PRICE); // each chain can pay exactly once

      await fetchPaid(cached);
      expect(paidOn()).toEqual([TESTNET.caip2]);
      balances.set(TESTNET.caip2, 0n); // the payment settled: the chain now says so

      await fetchPaid(cached); // same instant: a cache that kept "Testnet = PRICE" would sign on Testnet again
      expect(paidOn()).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
      balances.set(BASE_SEPOLIA.caip2, 0n);

      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid(cached));
      expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
      expect(leased.mock.calls, "the third request never leased the signer").toHaveLength(0);
      expect(paidOn(), "and nothing was signed for it").toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
      expect(rowNetworks(), "and no row was written for it").toHaveLength(2);
      expect(usedTotal(db, key.id), "and nothing was reserved for it").toBe(2n * PRICE);
    });

    describe("a balance another request read between our signature and the answer (before the settlement)", () => {
      /** One payment goes out on Testnet; meanwhile another request asks for that balance. Returns what that other request was told. */
      async function payWhileSomeoneElseReads(cached: KnownBalanceReader) {
        let told = null as bigint | null;
        whilePaying = async () => {
          told = await cached(wallet.getAddress()!, TESTNET);
        };
        const result = await fetchPaid(cached);
        whilePaying = null;
        return { told, result };
      }
      /** The payment is settled, so the chain says the wallet is empty now; then the next request arrives, in the same instant. */
      async function nextRequestOnTheEmptiedChain() {
        balances.set(TESTNET.caip2, 0n);
        const leased = vi.spyOn(wallet, "leaseSigner");
        const err = await failure(() => fetchPaid(cachedNow));
        expect(err, "the next request read the chain again and saw it empty").toBeInstanceOf(MoneySwitchError);
        expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
        expect(leased.mock.calls, "so it never leased the signer").toHaveLength(0);
        expect(paidOn(), "and nothing more was signed").toEqual([TESTNET.caip2]);
      }
      let cachedNow: KnownBalanceReader;
      let rawNow: ReturnType<typeof cachedReader>["raw"];
      beforeEach(() => {
        ({ cached: cachedNow, raw: rawNow } = cachedReader({ now: 5_000_000 }));
        offers = [{ network: TESTNET }];
        balances.set(TESTNET.caip2, PRICE); // enough for exactly one payment
      });

      it("is forgotten when the payment is answered: the next request reads the chain again instead of paying on the old number", async () => {
        const { told } = await payWhileSomeoneElseReads(cachedNow);
        expect(told, "the other request saw the balance as it was before the payment").toBe(PRICE);
        expect(rawNow, "ours before signing, the other request's while the payment was on its way").toHaveBeenCalledTimes(2);

        await nextRequestOnTheEmptiedChain();
        expect(rawNow, "the older read was not served from the cache").toHaveBeenCalledTimes(3);
      });

      it("is forgotten also when the payment's outcome is unknown (the seller cut the connection)", async () => {
        cutPaid = true;
        const { told, result } = await payWhileSomeoneElseReads(cachedNow);
        expect(result.paymentUnknown, "the payment was signed and its answer lost").not.toBeNull();
        expect(told).toBe(PRICE);
        expect(rawNow).toHaveBeenCalledTimes(2);

        await nextRequestOnTheEmptiedChain();
        expect(rawNow).toHaveBeenCalledTimes(3);
      });

      it("a forget that throws does not turn the result of a signed payment into an error", async () => {
        let forgets = 0;
        const flaky = Object.assign((address: string, network: NetworkConfig) => cachedNow(address, network), {
          forget: () => {
            if (++forgets === 2) throw new Error("the second forget (after the payment) fails");
          },
        });
        const result = await fetchPaid(flaky);
        expect(forgets, "once at the signature, once after the payment").toBe(2);
        expect(result.paymentId).not.toBeNull();
        expect(paidOn()).toEqual([TESTNET.caip2]);
        expect(wallet.inFlight, "the lease was still given back").toBe(0);
      });
    });
  });

  describe("a refusal that needs no balance comes first, and reads none", () => {
    it("a price over the per-request limit is PER_REQUEST_LIMIT_EXCEEDED, not INSUFFICIENT_FUNDS, though the wallet is empty", async () => {
      offers = [{ network: TESTNET, amount: "2000000" }, { network: BASE_SEPOLIA, amount: "2000000" }]; // this key's limit is 1 USDC
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 0n);
      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid());
      expect(err).toBeInstanceOf(MoneySwitchError);
      expect((err as MoneySwitchError).code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
      expect((err as MoneySwitchError).limit?.scope, "reported against the key's own limit, as the policy engine does").toBe("self");
      expect(reads, "no balance was read").toHaveLength(0);
      expectNothingHappened(leased);
    });

    it("a price over the caller's max_price is MAX_PRICE_EXCEEDED, not INSUFFICIENT_FUNDS, though the wallet is empty", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }]; // PRICE = 10000
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 0n);
      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid(reader, { maxPrice: PRICE - 1n }));
      expect((err as MoneySwitchError).code).toBe("MAX_PRICE_EXCEEDED");
      expect(reads, "no balance was read").toHaveLength(0);
      expectNothingHappened(leased);
    });

    it("over both: the per-request limit is reported first, as the policy engine does", async () => {
      offers = [{ network: TESTNET, amount: "2000000" }];
      const err = await failure(() => fetchPaid(reader, { maxPrice: PRICE }));
      expect((err as MoneySwitchError).code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
      expect(reads).toHaveLength(0);
    });

    it("the same price within both and a wallet that is short is still INSUFFICIENT_FUNDS", async () => {
      offers = [{ network: TESTNET }];
      balances.set(TESTNET.caip2, 0n);
      const err = await failure(() => fetchPaid(reader, { maxPrice: PRICE }));
      expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
      expect(reads).toHaveLength(1);
    });

    it("an offer over the limit is left out when another chain's offer is within it: that one is paid, and only its chain is read", async () => {
      offers = [{ network: TESTNET, amount: "2000000" }, { network: BASE_SEPOLIA }];
      balances.set(TESTNET.caip2, 9_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      await fetchPaid();
      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
      expect(reads.map((r) => r.network)).toEqual([BASE_SEPOLIA.caip2]);
    });
  });

  describe("the wallet is replaced while the balance is being read", () => {
    let dir: string;
    let other: LocalWalletDriver;
    let signed: number;
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-balance-swap-"));
      other = new LocalWalletDriver(dir, { protect: false, scrypt: { N: 2 ** 10, r: 8, p: 1 } });
      await other.createWithPhrase();
      signed = 0;
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    /** `other` with every signature it is asked for counted (the real signer underneath). */
    const countingSignatures = () => {
      const lease = other.leaseSigner.bind(other);
      return vi.spyOn(other, "leaseSigner").mockImplementation(() => {
        const taken = lease();
        if (!taken) return taken;
        const inner = taken.signer;
        return { ...taken, signer: { address: inner.address, signTypedData: (msg) => (signed++, inner.signTypedData(msg)) } };
      });
    };

    it("WALLET_BUSY: no signature, no payments row, no budget reserved, the lease given back", async () => {
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
      const addressRead = other.getAddress();
      let replaced = false;
      const replacingReader: KnownBalanceReader = async (address, network) => {
        reads.push({ address, network: network.caip2 });
        if (!replaced) {
          replaced = true;
          await other.replaceWallet(); // someone replaces the wallet right now: the number below is the OLD wallet's
        }
        return 5_000_000n;
      };
      const leased = countingSignatures();

      const err = await failure(() => fetchPaid(replacingReader, {}, other));

      expect(other.getAddress(), "the wallet really was replaced").not.toBe(addressRead);
      expect(reads[0].address, "and the chain was picked by the old wallet's balance").toBe(addressRead);
      expect(err).toBeInstanceOf(MoneySwitchError);
      expect((err as MoneySwitchError).code).toBe("WALLET_BUSY");
      expect(leased.mock.calls, "the signer of the new wallet was leased - and the address compared").toHaveLength(1);
      expect(signed, "nothing was signed").toBe(0);
      expect(listHistoryForKey(db, key.id, 50), "no payments row was written").toHaveLength(0);
      expect(usedToday(db, key.id), "no budget was reserved today").toBe(0n);
      expect(usedTotal(db, key.id), "no budget was reserved in total").toBe(0n);
      expect(paidOn(), "nothing reached the seller").toHaveLength(0);
      expect(other.inFlight, "the lease was given back").toBe(0);
    });

    it("the retry, now that the wallet is the new one, pays", async () => {
      offers = [{ network: TESTNET }];
      let replaced = false;
      const replacingReader: KnownBalanceReader = async () => {
        if (!replaced) {
          replaced = true;
          await other.replaceWallet();
        }
        return 5_000_000n;
      };
      const err = await failure(() => fetchPaid(replacingReader, {}, other));
      expect((err as MoneySwitchError).code).toBe("WALLET_BUSY");
      await fetchPaid(replacingReader, {}, other);
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });

    it("compares the two addresses without regard to letter case (a lower-cased address is the same wallet)", async () => {
      offers = [{ network: TESTNET }];
      balances.set(TESTNET.caip2, 5_000_000n);
      const lowerCased: SignerSource = { getAddress: () => wallet.getAddress()!.toLowerCase(), leaseSigner: () => wallet.leaseSigner() };
      await fetchPaid(reader, {}, lowerCased);
      expect(reads[0].address, "the balance was read for the lower-cased spelling").toBe(wallet.getAddress()!.toLowerCase());
      expect(paidOn()).toEqual([TESTNET.caip2]);
    });
  });

  describe("a resend with approval_id keeps to the chain the approval was given for", () => {
    beforeEach(() => {
      key = newKey({ approvalThreshold: parseUsdcToMicros("0.001") }); // PRICE (0.01) is above it: needs a person's approval
      offers = [{ network: TESTNET }, { network: BASE_SEPOLIA }];
    });

    /** The first request: Testnet is empty, so the payment (and with it the approval) is for Base Sepolia. Returns the approved id. */
    async function approvedOnBase() {
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      const first = await failure(() => fetchPaid());
      expect(first).toBeInstanceOf(ApprovalRequiredError);
      const approvalId = (first as ApprovalRequiredError).approvalId;
      expect(getApproval(db, approvalId)!.network).toBe(BASE_SEPOLIA.caip2);
      decideApproval(db, approvalId, "approved");
      return approvalId;
    }

    it("pays on the approved chain although another chain, first in the configuration, now holds more", async () => {
      const approvalId = await approvedOnBase();
      balances.set(TESTNET.caip2, 9_000_000n).set(BASE_SEPOLIA.caip2, 20_000n); // topped up since: Testnet would be chosen without the approval
      reads = [];

      await fetchPaid(reader, { approvalId });

      expect(paidOn()).toEqual([BASE_SEPOLIA.caip2]);
      expect(rowNetworks()).toEqual([BASE_SEPOLIA.caip2]);
      expect(getApproval(db, approvalId)!.status).toBe("used");
      expect(reads.map((r) => r.network), "only the approved chain's balance was looked at").toEqual([BASE_SEPOLIA.caip2]);
    });

    it("APPROVAL_INVALID when the seller no longer offers the approved chain: nothing leased, reserved or signed, the approval untouched", async () => {
      const approvalId = await approvedOnBase();
      offers = [{ network: TESTNET }]; // Base Sepolia is gone from the offer
      balances.set(TESTNET.caip2, 9_000_000n);
      reads = [];
      const leased = vi.spyOn(wallet, "leaseSigner");

      const err = await failure(() => fetchPaid(reader, { approvalId }));

      expect((err as MoneySwitchError).code).toBe("APPROVAL_INVALID");
      expect(reads, "no balance was read").toHaveLength(0);
      expectNothingHappened(leased);
      expect(getApproval(db, approvalId)!.status, "still approved, usable for the right payment").toBe("approved");
    });

    it("INSUFFICIENT_FUNDS, not another chain, when the approved chain is the one that has run short", async () => {
      const approvalId = await approvedOnBase();
      balances.set(TESTNET.caip2, 9_000_000n).set(BASE_SEPOLIA.caip2, 0n);
      const leased = vi.spyOn(wallet, "leaseSigner");

      const err = await failure(() => fetchPaid(reader, { approvalId }));

      expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
      expectNothingHappened(leased);
    });

    it("an approval_id that does not exist narrows nothing: the policy engine says APPROVAL_INVALID", async () => {
      balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      const leased = vi.spyOn(wallet, "leaseSigner");
      const err = await failure(() => fetchPaid(reader, { approvalId: "no-such-approval" }));
      expect((err as MoneySwitchError).code).toBe("APPROVAL_INVALID");
      expect(leased.mock.calls, "it got as far as the policy engine, which needs the signer").toHaveLength(1);
      expect(paidOn()).toHaveLength(0);
    });

    describe("only this key's approval for this very request narrows the chain; any other approval narrows nothing", () => {
      /**
       * Base Sepolia (where the approval was given) has run short since, and Testnet holds plenty. An approval that narrowed the offers
       * would leave only Base and end in INSUFFICIENT_FUNDS; one that narrows nothing lets the chain choice go on to Testnet, and it is
       * the policy engine that refuses the approval_id (APPROVAL_INVALID), after both chains were looked at.
       */
      async function expectNarrowsNothing(approvalId: string, extra: Pick<PaidFetchInput, "url" | "method"> = {}) {
        balances.set(TESTNET.caip2, 9_000_000n).set(BASE_SEPOLIA.caip2, 0n);
        reads = [];
        const err = await failure(() => fetchPaid(reader, { approvalId, ...extra }));
        expect((err as MoneySwitchError).code, "refused by the policy engine, not by the chain choice").toBe("APPROVAL_INVALID");
        expect(reads.map((r) => r.network), "both chains were looked at").toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
        expect(paidOn(), "nothing was signed").toHaveLength(0);
        expect(getApproval(db, approvalId)!.status, "the approval is untouched, still usable for the right request").toBe("approved");
        expect(wallet.inFlight).toBe(0);
      }

      it("control: this key's approval for this url and method does narrow it (the resend is INSUFFICIENT_FUNDS while Base is short)", async () => {
        const approvalId = await approvedOnBase();
        balances.set(TESTNET.caip2, 9_000_000n).set(BASE_SEPOLIA.caip2, 0n);
        reads = [];
        const err = await failure(() => fetchPaid(reader, { approvalId }));
        expect((err as MoneySwitchError).code).toBe("INSUFFICIENT_FUNDS");
        expect(reads.map((r) => r.network), "only the approved chain was looked at").toEqual([BASE_SEPOLIA.caip2]);
      });

      it("another key's approval_id narrows nothing", async () => {
        const mine = key;
        key = newKey({ approvalThreshold: parseUsdcToMicros("0.001") }); // another key, same seller
        const approvalId = await approvedOnBase();
        expect(getApproval(db, approvalId)!.keyId).not.toBe(mine.id);
        key = mine;
        await expectNarrowsNothing(approvalId);
      });

      it("this key's approval_id for another url narrows nothing", async () => {
        const approvalId = await approvedOnBase(); // for GET {seller}/item
        await expectNarrowsNothing(approvalId, { url: `${sellerUrl}/other` });
      });

      it("this key's approval_id for another method narrows nothing", async () => {
        const approvalId = await approvedOnBase(); // for GET {seller}/item
        await expectNarrowsNothing(approvalId, { method: "POST" });
      });
    });
  });
});
