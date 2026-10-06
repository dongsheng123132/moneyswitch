import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import { createMoneyKey, createChildKey, getKeyChain, parseUsdcToMicros, usedToday, listHistoryForKey, MoneySwitchError, type MoneyKeyRow, type NetworkMode } from "@moneyswitch/core";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import type Database from "better-sqlite3";
import { x402Client } from "@x402/core/client";
import { performPaidFetch } from "../src/client.js";
import type { KnownBalanceReader } from "../src/balance.js";
import { BASE, BASE_SEPOLIA, MAINNET, NETWORKS, TESTNET, getEnabledNetworksFor, getEnabledNetworksForChain, isMainnetNetwork, type NetworkConfig } from "../src/networks.js";

/**
 * SPEC.md §1, §6 (v0.7.2): every chain is a mainnet or a testnet, and a key pays only on the enabled chains of its own kind (a key from
 * before network types: on all of them). performPaidFetch narrows the chain list by the key, so a seller that accepts only the other
 * kind is UNSUPPORTED_PAYMENT before a balance is read, a wallet leased, anything reserved or anything signed.
 */

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const PRICE = 10_000n;
const MIXED = [TESTNET, MAINNET, BASE_SEPOLIA, BASE];

describe("network kinds", () => {
  it("every configured chain knows whether it is real money: the two Monad / Base mainnets are mainnets, the two testnets are testnets", () => {
    expect([TESTNET, MAINNET, BASE_SEPOLIA, BASE].map((n) => [n.caip2, n.kind])).toEqual([
      ["eip155:10143", "testnet"],
      ["eip155:143", "mainnet"],
      ["eip155:84532", "testnet"],
      ["eip155:8453", "mainnet"],
    ]);
    expect(Object.values(NETWORKS).every((n) => n.kind === "mainnet" || n.kind === "testnet")).toBe(true);
    expect([TESTNET, MAINNET, BASE_SEPOLIA, BASE].map(isMainnetNetwork)).toEqual([false, true, false, true]);
  });

  describe("getEnabledNetworksFor(mode): the enabled chains a key of that kind may pay on", () => {
    const original = process.env.MONEYSWITCH_NETWORKS;
    afterEach(() => {
      if (original === undefined) delete process.env.MONEYSWITCH_NETWORKS;
      else process.env.MONEYSWITCH_NETWORKS = original;
    });
    const enable = (...networks: NetworkConfig[]) => (process.env.MONEYSWITCH_NETWORKS = networks.map((n) => n.caip2).join(","));
    const ids = (mode: NetworkMode | null) => getEnabledNetworksFor(mode).map((n) => n.caip2);

    it("filters by kind and keeps the instance's order", () => {
      enable(BASE, TESTNET, MAINNET, BASE_SEPOLIA);
      expect(ids("mainnet")).toEqual([BASE.caip2, MAINNET.caip2]);
      expect(ids("testnet")).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
    });

    it("null (a key from before network types) where the instance enables one kind only: every enabled chain, unchanged", () => {
      enable(TESTNET, BASE_SEPOLIA);
      expect(ids(null)).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
      enable(BASE, MAINNET);
      expect(ids(null)).toEqual([BASE.caip2, MAINNET.caip2]);
      delete process.env.MONEYSWITCH_NETWORKS;
      expect(ids(null)).toEqual([TESTNET.caip2]);
    });

    it("null where the instance enables BOTH kinds: the testnets only, in the instance's order (enabling a mainnet must not let an old key spend real money)", () => {
      enable(BASE, TESTNET, MAINNET, BASE_SEPOLIA);
      expect(ids(null)).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
      enable(MAINNET, BASE_SEPOLIA);
      expect(ids(null)).toEqual([BASE_SEPOLIA.caip2]);
    });

    it("a kind the instance does not enable is an empty list, never the other kind", () => {
      enable(TESTNET, BASE_SEPOLIA);
      expect(ids("mainnet")).toEqual([]);
      enable(MAINNET);
      expect(ids("testnet")).toEqual([]);
      expect(ids("mainnet")).toEqual([MAINNET.caip2]);
    });

    it("only chains that are enabled count: the default (nothing configured) is the testnet", () => {
      delete process.env.MONEYSWITCH_NETWORKS;
      expect(ids("testnet")).toEqual([TESTNET.caip2]);
      expect(ids("mainnet")).toEqual([]);
    });
  });
});

describe("getEnabledNetworksForChain: a key's chains from its chain of keys (ancestor consistency)", () => {
  const original = process.env.MONEYSWITCH_NETWORKS;
  afterEach(() => {
    if (original === undefined) delete process.env.MONEYSWITCH_NETWORKS;
    else process.env.MONEYSWITCH_NETWORKS = original;
  });
  const row = (id: string, parentId: string | null, networkMode: NetworkMode | null) => ({ id, parentId, networkMode }) as MoneyKeyRow;
  const ids = (chain: MoneyKeyRow[]) => getEnabledNetworksForChain(chain).map((n) => n.caip2);

  it("a key without a type follows the first typed ancestor", () => {
    process.env.MONEYSWITCH_NETWORKS = MIXED.map((n) => n.caip2).join(",");
    expect(ids([row("c", "p", null), row("p", null, "mainnet")])).toEqual([MAINNET.caip2, BASE.caip2]);
    expect(ids([row("g", "c", null), row("c", "p", null), row("p", null, "testnet")])).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
  });

  it("the key's own type wins when the ancestors agree with it; a typed key under an untyped parent is its own", () => {
    process.env.MONEYSWITCH_NETWORKS = MIXED.map((n) => n.caip2).join(",");
    expect(ids([row("c", "p", "mainnet"), row("p", null, "mainnet")])).toEqual([MAINNET.caip2, BASE.caip2]);
    expect(ids([row("c", "p", "mainnet"), row("p", null, null)])).toEqual([MAINNET.caip2, BASE.caip2]);
  });

  it("no type anywhere: the old rule (all of the instance's only kind, the testnets where both are enabled)", () => {
    process.env.MONEYSWITCH_NETWORKS = MIXED.map((n) => n.caip2).join(",");
    expect(ids([row("c", "p", null), row("p", null, null)])).toEqual([TESTNET.caip2, BASE_SEPOLIA.caip2]);
    process.env.MONEYSWITCH_NETWORKS = [MAINNET, BASE].map((n) => n.caip2).join(",");
    expect(ids([row("c", "p", null), row("p", null, null)])).toEqual([MAINNET.caip2, BASE.caip2]);
  });

  it("two typed levels that differ: no network at all", () => {
    process.env.MONEYSWITCH_NETWORKS = MIXED.map((n) => n.caip2).join(",");
    expect(ids([row("c", "p", "testnet"), row("p", null, "mainnet")])).toEqual([]);
    expect(ids([row("g", "c", null), row("c", "p", "mainnet"), row("p", null, "testnet")])).toEqual([]);
  });
});

describe("performPaidFetch pays only on the chains of the key's kind", () => {
  let tmpDir: string;
  let db: MoneySwitchDb;
  let sqlite: Database.Database;
  let wallet: LocalWalletDriver;
  let server: http.Server;
  let sellerUrl: string;
  let sellerHost: string;
  let offers: NetworkConfig[] = [];
  let seen: { paid: boolean; paidNetwork: string | null }[] = [];
  let balances = new Map<string, bigint | null>();
  let reads: string[] = [];
  const reader: KnownBalanceReader = async (_address, network) => {
    reads.push(network.caip2);
    return balances.get(network.caip2) ?? null;
  };
  const originalNetworks = process.env.MONEYSWITCH_NETWORKS;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-network-mode-"));
    wallet = new LocalWalletDriver(tmpDir, { protect: false });
    await wallet.createWithPhrase();
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const signature = req.headers["payment-signature"] ?? req.headers["x-payment"];
        const paid = typeof signature === "string";
        seen.push({ paid, paidNetwork: paid ? (decodePaymentSignatureHeader(signature) as { accepted: { network: string } }).accepted.network : null });
        if (paid) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ delivered: true }));
          return;
        }
        const paymentRequired = {
          x402Version: 2,
          error: "Payment required",
          resource: { url: `${sellerUrl}${req.url}`, description: "network mode seller", mimeType: "application/json" },
          accepts: offers.map((n) => ({
            scheme: "exact",
            network: n.caip2,
            amount: PRICE.toString(),
            asset: n.usdcAddress,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: n.usdcDomainName, version: n.usdcDomainVersion },
          })),
        };
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired as never) });
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
    offers = [];
    seen = [];
    balances = new Map();
    reads = [];
    process.env.MONEYSWITCH_NETWORKS = MIXED.map((n) => n.caip2).join(",");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
    if (originalNetworks === undefined) delete process.env.MONEYSWITCH_NETWORKS;
    else process.env.MONEYSWITCH_NETWORKS = originalNetworks;
  });

  const keyOf = (networkMode?: NetworkMode | null): MoneyKeyRow =>
    createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("5"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: [sellerHost],
      networkMode,
    }).row;
  const pay = (key: MoneyKeyRow) => performPaidFetch(db, sqlite, key, wallet, { url: `${sellerUrl}/item`, host: sellerHost, method: "GET" }, { balanceReader: reader });
  const paidOn = () => seen.filter((r) => r.paid).map((r) => r.paidNetwork);
  const failure = (run: () => Promise<unknown>) => run().then(() => null, (e: unknown) => e);

  it("a testnet key and a seller that accepts only mainnets: UNSUPPORTED_PAYMENT, nothing read, leased, reserved or signed", async () => {
    offers = [MAINNET, BASE];
    const key = keyOf("testnet");
    const lease = vi.spyOn(wallet, "leaseSigner");
    const err = await failure(() => pay(key));
    expect(err).toBeInstanceOf(MoneySwitchError);
    expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(lease).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(listHistoryForKey(db, key.id, 50)).toHaveLength(0);
    expect(usedToday(db, key.id)).toBe(0n);
    expect(paidOn()).toEqual([]);
  });

  it("a mainnet key and a seller that accepts only testnets: the same refusal", async () => {
    offers = [TESTNET, BASE_SEPOLIA];
    const key = keyOf("mainnet");
    const lease = vi.spyOn(wallet, "leaseSigner");
    const err = await failure(() => pay(key));
    expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(lease).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(listHistoryForKey(db, key.id, 50)).toHaveLength(0);
    expect(paidOn()).toEqual([]);
  });

  it("a seller that offers both kinds: a mainnet key pays on the mainnet, a testnet key on the testnet, whatever the balances and the seller's order", async () => {
    offers = [TESTNET, MAINNET];
    balances.set(TESTNET.caip2, 9_000_000n).set(MAINNET.caip2, 9_000_000n);
    await pay(keyOf("mainnet"));
    expect(paidOn()).toEqual([MAINNET.caip2]);
    expect(reads).toEqual([MAINNET.caip2]);
    seen = [];
    reads = [];
    offers = [MAINNET, TESTNET];
    await pay(keyOf("testnet"));
    expect(paidOn()).toEqual([TESTNET.caip2]);
    expect(reads).toEqual([TESTNET.caip2]);
  });

  it("the balance choice works inside the kind: the first of the key's chains that can pay, in MONEYSWITCH_NETWORKS order", async () => {
    process.env.MONEYSWITCH_NETWORKS = [MAINNET, TESTNET, BASE, BASE_SEPOLIA].map((n) => n.caip2).join(",");
    offers = [BASE, TESTNET, MAINNET, BASE_SEPOLIA];
    balances.set(MAINNET.caip2, 0n).set(BASE.caip2, 5_000_000n).set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
    await pay(keyOf("mainnet"));
    expect(paidOn()).toEqual([BASE.caip2]);
    seen = [];
    await pay(keyOf("testnet"));
    expect(paidOn()).toEqual([TESTNET.caip2]);
  });

  it("a key from before network types on an instance with both kinds: testnets only; a seller that accepts only a mainnet is UNSUPPORTED_PAYMENT, nothing leased, reserved or signed", async () => {
    offers = [TESTNET];
    await pay(keyOf());
    expect(paidOn()).toEqual([TESTNET.caip2]);
    seen = [];
    reads = [];
    balances.set(MAINNET.caip2, 9_000_000n).set(TESTNET.caip2, 20_000n);
    offers = [MAINNET, TESTNET];
    await pay(keyOf(null));
    expect(paidOn()).toEqual([TESTNET.caip2]);
    expect(reads).toEqual([TESTNET.caip2]);
    seen = [];
    offers = [MAINNET, BASE];
    const legacy = keyOf();
    const lease = vi.spyOn(wallet, "leaseSigner");
    const err = await failure(() => pay(legacy));
    expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(lease).not.toHaveBeenCalled();
    expect(listHistoryForKey(db, legacy.id, 50)).toHaveLength(0);
    expect(paidOn()).toEqual([]);
  });

  it("a key from before network types where the instance enables one kind only: every enabled chain, as it always was", async () => {
    process.env.MONEYSWITCH_NETWORKS = [MAINNET, BASE].map((n) => n.caip2).join(",");
    offers = [MAINNET];
    await pay(keyOf());
    expect(paidOn()).toEqual([MAINNET.caip2]);
    seen = [];
    process.env.MONEYSWITCH_NETWORKS = [TESTNET, BASE_SEPOLIA].map((n) => n.caip2).join(",");
    offers = [TESTNET];
    await pay(keyOf(null));
    expect(paidOn()).toEqual([TESTNET.caip2]);
  });

  it("a key without a type under a typed parent follows the parent (a mainnet parent: the mainnet, never the testnet)", async () => {
    const parent = createMoneyKey(db, {
      name: "p", totalBudget: parseUsdcToMicros("10"), dailyBudget: parseUsdcToMicros("5"), perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: [sellerHost], canDelegate: true, networkMode: "mainnet",
    }).row;
    const child = createChildKey(db, parent.id, { name: "c", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") }, { maxDepth: 3 }).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id = ?").run(child.id); // as a child of a key from before the column would be
    expect(getKeyChain(db, child.id)[0].networkMode).toBeNull();
    offers = [TESTNET, MAINNET];
    balances.set(TESTNET.caip2, 9_000_000n).set(MAINNET.caip2, 9_000_000n);
    await pay(getKeyChain(db, child.id)[0]);
    expect(paidOn()).toEqual([MAINNET.caip2]);
    expect(reads).toEqual([MAINNET.caip2]);
    seen = [];
    offers = [TESTNET];
    const err = await failure(() => pay(getKeyChain(db, child.id)[0]));
    expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(paidOn()).toEqual([]);
  });

  it("a chain whose types disagree (a testnet child under a mainnet parent) pays nothing: UNSUPPORTED_PAYMENT, nothing leased, reserved or signed", async () => {
    const parent = createMoneyKey(db, {
      name: "p", totalBudget: parseUsdcToMicros("10"), dailyBudget: parseUsdcToMicros("5"), perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: [sellerHost], canDelegate: true, networkMode: "mainnet",
    }).row;
    const child = createChildKey(db, parent.id, { name: "c", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") }, { maxDepth: 3 }).row;
    sqlite.prepare("UPDATE money_keys SET network_mode = 'testnet' WHERE id = ?").run(child.id); // no code path does this: the database was edited
    const lease = vi.spyOn(wallet, "leaseSigner");
    for (const sellerOffers of [[TESTNET], [MAINNET], [TESTNET, MAINNET]]) {
      offers = sellerOffers;
      const err = await failure(() => pay(getKeyChain(db, child.id)[0]));
      expect(err, sellerOffers.map((n) => n.caip2).join()).toBeInstanceOf(MoneySwitchError);
      expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    }
    expect(lease).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(listHistoryForKey(db, child.id, 50)).toHaveLength(0);
    expect(usedToday(db, child.id)).toBe(0n);
    expect(paidOn()).toEqual([]);
  });

  it("defence in depth: should the SDK ever pick a network that is not in the key's list, the payment is refused before the wallet is leased or anything is reserved", async () => {
    let hook: ((ctx: unknown) => Promise<unknown>) | null = null;
    const original = x402Client.prototype.onBeforePaymentCreation;
    vi.spyOn(x402Client.prototype, "onBeforePaymentCreation").mockImplementation(function (this: x402Client, h: never) {
      hook = h as never;
      return original.call(this, h);
    });
    const key = keyOf("testnet");
    offers = [MAINNET];
    // the seller offers a chain this key cannot use: the client (and its hooks) are built, no payment is made
    const refused = await performPaidFetch(db, sqlite, key, wallet, { url: `${sellerUrl}/item`, host: sellerHost, method: "GET" }, { balanceReader: reader }).catch((e: unknown) => e);
    expect((refused as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(hook).not.toBeNull();
    const lease = vi.spyOn(wallet, "leaseSigner");
    const outcome = (await hook!({ selectedRequirements: { network: MAINNET.caip2, asset: MAINNET.usdcAddress, payTo: PAY_TO, amount: "10000", scheme: "exact" } })) as { abort?: boolean; reason?: string };
    expect(outcome).toEqual({ abort: true, reason: "UNSUPPORTED_PAYMENT" });
    expect(lease).not.toHaveBeenCalled();
    expect(listHistoryForKey(db, key.id, 50)).toHaveLength(0);
    expect(usedToday(db, key.id)).toBe(0n);
    expect(paidOn()).toEqual([]);
  });

  it("a kind the instance does not enable pays nothing, even where the seller offers the other kind", async () => {
    process.env.MONEYSWITCH_NETWORKS = [TESTNET, BASE_SEPOLIA].map((n) => n.caip2).join(",");
    offers = [MAINNET, TESTNET];
    const err = await failure(() => pay(keyOf("mainnet")));
    expect((err as MoneySwitchError).code).toBe("UNSUPPORTED_PAYMENT");
    expect(paidOn()).toEqual([]);
  });
});
