import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { createMoneyKey, parseUsdcToMicros } from "@moneyswitch/core";
import { BASE, BASE_SEPOLIA, MAINNET, TESTNET, type KnownBalanceReader } from "@moneyswitch/x402";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * SPEC.md §1, §6 through POST /v1/fetch: an instance that enables a testnet AND a mainnet, with a testnet key, a mainnet key and a key from
 * before network types. A key only ever pays on the enabled chains of its own kind: a seller that accepts only the other kind is
 * UNSUPPORTED_PAYMENT (denied, charged no) before anything is read, reserved or signed; the balance choice, the approval line and the other
 * checks all work on that narrowed list.
 */

let t: TestCtx;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let mainnetSeller: StubSeller; // accepts Monad mainnet only
let testnetSeller: StubSeller; // accepts Monad testnet only
let bothSeller: StubSeller; // accepts both, the MAINNET first
let keys: { testnet: string; mainnet: string; old: string };
const originalNetworks = process.env.MONEYSWITCH_NETWORKS;
let reads: string[] = [];
/** caip2 -> balance, null (or missing) = the chain's RPC does not answer. */
let balances = new Map<string, bigint | null>();

const MIXED = `${TESTNET.caip2},${MAINNET.caip2},${BASE_SEPOLIA.caip2},${BASE.caip2}`;
const sellers = () => [mainnetSeller, testnetSeller, bothSeller];
/** Forgets what the sellers saw; the seller that accepts both kinds lists the mainnet first. */
function resetSellers() {
  for (const s of sellers()) s.reset();
  bothSeller.setBehavior({ networks: [MAINNET, TESTNET] });
}

beforeAll(async () => {
  t = await buildTestApp({ unlockWallet: true, port: 0 });
  t.ctx.balanceReader = (async (_address, network) => {
    reads.push(network.caip2);
    return balances.get(network.caip2) ?? null;
  }) as KnownBalanceReader;
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorUrl = `http://127.0.0.1:${(facilitator.server.address() as { port: number }).port}`;
  const payTo = "0x1111111111111111111111111111111111111111";
  mainnetSeller = await startStubSeller({ facilitatorUrl, payTo, network: MAINNET });
  testnetSeller = await startStubSeller({ facilitatorUrl, payTo, network: TESTNET });
  bothSeller = await startStubSeller({ facilitatorUrl, payTo, network: MAINNET });
  const hosts = sellers().map((s) => `127.0.0.1:${s.port}`);
  process.env.MONEYSWITCH_NETWORKS = MIXED;
  const issue = async (name: string, network_mode: "testnet" | "mainnet", extra: Record<string, unknown> = {}) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name, daily_budget: "5", total_budget: "10", per_request_limit: "1", allowed_hosts: hosts, network_mode, ...extra },
    });
    expect(res.statusCode).toBe(200);
    return res.json().key as string;
  };
  keys = {
    testnet: await issue("testnet-key", "testnet"),
    mainnet: await issue("mainnet-key", "mainnet"),
    // a key from before v0.7.2: no network type
    old: createMoneyKey(t.ctx.db, {
      name: "old-key",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("5"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: hosts,
    }).plaintextKey,
  };
}, 30_000);
afterAll(async () => {
  for (const s of sellers()) await s?.close();
  await facilitator?.close();
  if (t) await cleanupTestApp(t);
});
beforeEach(() => {
  process.env.MONEYSWITCH_NETWORKS = MIXED;
  resetSellers();
  reads = [];
  balances = new Map();
});
afterEach(() => {
  if (originalNetworks === undefined) delete process.env.MONEYSWITCH_NETWORKS;
  else process.env.MONEYSWITCH_NETWORKS = originalNetworks;
});

async function buy(key: string, seller: StubSeller, extra: Record<string, unknown> = {}) {
  const response = await t.app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: seller.url, max_price: "0.01", ...extra } });
  return response.json();
}
const paymentRows = () => (t.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n;
/** The chain the signed payment that reached the seller was made for, read from its own PAYMENT-SIGNATURE header (not from our books). */
function networkPaidAtSeller(seller: StubSeller): string {
  const paid = seller.requests.filter((r) => r.paid);
  expect(paid, "exactly one signed payment reached the seller").toHaveLength(1);
  const header = (paid[0].headers["payment-signature"] ?? paid[0].headers["x-payment"]) as string;
  return (decodePaymentSignatureHeader(header) as { accepted: { network: string } }).accepted.network;
}
function expectNothingHappened(seller: StubSeller, rowsBefore: number) {
  expect(paymentRows(), "no payments row, nothing reserved").toBe(rowsBefore);
  expect(seller.requests.filter((r) => r.paid), "nothing signed reached the seller").toHaveLength(0);
  expect(seller.settleCalls()).toBe(0);
}

describe("a testnet key on an instance that enables a mainnet too", () => {
  it("a seller that accepts only a mainnet: UNSUPPORTED_PAYMENT, charged no, nothing read, reserved or signed; the reason says what the key pays on", async () => {
    const rowsBefore = paymentRows();
    const out = await buy(keys.testnet, mainnetSeller);
    expect(out.status).toBe("denied");
    expect(out.code).toBe("UNSUPPORTED_PAYMENT");
    expect(out.charged).toBe("no");
    expect(out.payment).toBeNull();
    expect(out.reason).toContain("testnet");
    expect(out.reason).toContain(TESTNET.caip2);
    expect(out.reason).not.toContain(MAINNET.caip2);
    expectNothingHappened(mainnetSeller, rowsBefore);
    expect(reads, "no balance was looked at for a payment that is refused anyway").toEqual([]);
  });

  it("a seller that accepts a testnet: pays on the testnet", async () => {
    const out = await buy(keys.testnet, testnetSeller);
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("yes");
    expect(out.payment.network).toBe(TESTNET.caip2);
    expect(networkPaidAtSeller(testnetSeller)).toBe(TESTNET.caip2);
  });

  it("a seller that offers both kinds (the mainnet first): only the testnet is looked at and used, even when the mainnet holds more", async () => {
    balances.set(MAINNET.caip2, 9_000_000n).set(TESTNET.caip2, 20_000n);
    const out = await buy(keys.testnet, bothSeller);
    expect(out.status).toBe("ok");
    expect(out.payment.network).toBe(TESTNET.caip2);
    expect(networkPaidAtSeller(bothSeller)).toBe(TESTNET.caip2);
    expect(reads, "no mainnet balance was read for a testnet key").toEqual([TESTNET.caip2]);
  });

  it("a testnet that cannot cover the price is INSUFFICIENT_FUNDS: it never falls over to the mainnet that could", async () => {
    balances.set(MAINNET.caip2, 9_000_000n).set(TESTNET.caip2, 9_999n);
    const rowsBefore = paymentRows();
    const out = await buy(keys.testnet, bothSeller);
    expect(out.status).toBe("denied");
    expect(out.code).toBe("INSUFFICIENT_FUNDS");
    expect(out.charged).toBe("no");
    expectNothingHappened(bothSeller, rowsBefore);
  });

  it("the approval line works on the narrowed list: the approval is for the testnet, and so is the payment after it is approved", async () => {
    const keyId = (t.ctx.sqlite.prepare("SELECT id FROM money_keys WHERE name = 'testnet-key'").get() as { id: string }).id;
    t.ctx.sqlite.prepare("UPDATE money_keys SET approval_threshold = 5000 WHERE id = ?").run(keyId); // 0.005 USDC: the 0.01 price is over it
    try {
      const first = await buy(keys.testnet, bothSeller);
      expect(first.status).toBe("approval_required");
      const row = t.ctx.sqlite.prepare("SELECT network FROM approvals WHERE id = ?").get(first.approval_id) as { network: string };
      expect(row.network).toBe(TESTNET.caip2);
      expect(bothSeller.requests.filter((r) => r.paid)).toHaveLength(0);
      expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${first.approval_id}/approve`, headers: { authorization: `Bearer ${t.adminToken}` } })).statusCode).toBe(200);
      const second = await buy(keys.testnet, bothSeller, { approval_id: first.approval_id });
      expect(second.status).toBe("ok");
      expect(second.payment.network).toBe(TESTNET.caip2);
    } finally {
      t.ctx.sqlite.prepare("UPDATE money_keys SET approval_threshold = NULL WHERE id = ?").run(keyId);
    }
  });
});

describe("a mainnet key on an instance that enables a testnet too", () => {
  it("a seller that accepts only a testnet: UNSUPPORTED_PAYMENT, charged no, nothing read, reserved or signed", async () => {
    const rowsBefore = paymentRows();
    const out = await buy(keys.mainnet, testnetSeller);
    expect(out.status).toBe("denied");
    expect(out.code).toBe("UNSUPPORTED_PAYMENT");
    expect(out.charged).toBe("no");
    expect(out.reason).toContain("mainnet");
    expect(out.reason).toContain(MAINNET.caip2);
    expect(out.reason).not.toContain(TESTNET.caip2);
    expectNothingHappened(testnetSeller, rowsBefore);
    expect(reads).toEqual([]);
  });

  it("a seller that offers both kinds (the testnet listed second): pays on the mainnet only; the testnet's balance is never read", async () => {
    balances.set(MAINNET.caip2, 20_000n).set(TESTNET.caip2, 9_000_000n);
    const out = await buy(keys.mainnet, bothSeller);
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("yes");
    expect(out.payment.network).toBe(MAINNET.caip2);
    expect(networkPaidAtSeller(bothSeller)).toBe(MAINNET.caip2);
    expect(reads).toEqual([MAINNET.caip2]);
  });

  it("a mainnet that cannot cover the price is INSUFFICIENT_FUNDS: test tokens are never spent in its place", async () => {
    balances.set(MAINNET.caip2, 9_999n).set(TESTNET.caip2, 9_000_000n);
    const rowsBefore = paymentRows();
    const out = await buy(keys.mainnet, bothSeller);
    expect(out.status).toBe("denied");
    expect(out.code).toBe("INSUFFICIENT_FUNDS");
    expect(out.charged).toBe("no");
    expectNothingHappened(bothSeller, rowsBefore);
  });

  it("a seller that accepts a mainnet: pays on it", async () => {
    const out = await buy(keys.mainnet, mainnetSeller);
    expect(out.status).toBe("ok");
    expect(out.payment.network).toBe(MAINNET.caip2);
  });
});

describe("a key from before network types (SPEC.md §6)", () => {
  describe("on an instance that enables both kinds: it pays on the testnets only, so enabling a mainnet never lets it spend real money", () => {
    it("a mainnet-only seller: UNSUPPORTED_PAYMENT, charged no, nothing read, reserved or signed; the reason says it pays on testnets only", async () => {
      const rowsBefore = paymentRows();
      const out = await buy(keys.old, mainnetSeller);
      expect(out.status).toBe("denied");
      expect(out.code).toBe("UNSUPPORTED_PAYMENT");
      expect(out.charged).toBe("no");
      expect(out.reason).toContain("before network types");
      expect(out.reason).toContain("testnets");
      expect(out.reason).toContain(TESTNET.caip2);
      expect(out.reason).not.toContain(MAINNET.caip2);
      expectNothingHappened(mainnetSeller, rowsBefore);
      expect(reads).toEqual([]);
    });

    it("a testnet seller is paid", async () => {
      const out = await buy(keys.old, testnetSeller);
      expect(out.status).toBe("ok");
      expect(out.payment.network).toBe(TESTNET.caip2);
    });

    it("a seller that offers both kinds: the testnet is used and the mainnet's balance is never read, even when only the mainnet holds money", async () => {
      balances.set(TESTNET.caip2, 20_000n).set(MAINNET.caip2, 9_000_000n);
      const out = await buy(keys.old, bothSeller);
      expect(out.status).toBe("ok");
      expect(out.payment.network).toBe(TESTNET.caip2);
      expect(networkPaidAtSeller(bothSeller)).toBe(TESTNET.caip2);
      expect(reads).toEqual([TESTNET.caip2]);
      resetSellers();
      reads = [];
      balances.set(TESTNET.caip2, 0n).set(MAINNET.caip2, 9_000_000n);
      const rowsBefore = paymentRows();
      const short = await buy(keys.old, bothSeller);
      expect(short.code).toBe("INSUFFICIENT_FUNDS");
      expectNothingHappened(bothSeller, rowsBefore);
    });

    it("the status call says so: network_mode null, the testnets, and a default network that is one of them", async () => {
      const status = (await t.app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${keys.old}` } })).json();
      expect(status).toMatchObject({ network_mode: null, networks: [TESTNET.caip2, BASE_SEPOLIA.caip2], network: TESTNET.caip2 });
    });
  });

  describe("on an instance that enables one kind only: as before, every enabled chain", () => {
    it("mainnets only: it pays a mainnet seller", async () => {
      process.env.MONEYSWITCH_NETWORKS = `${MAINNET.caip2},${BASE.caip2}`;
      const out = await buy(keys.old, mainnetSeller);
      expect(out.status).toBe("ok");
      expect(out.payment.network).toBe(MAINNET.caip2);
    });

    it("testnets only: it pays a testnet seller, and a mainnet-only seller is UNSUPPORTED_PAYMENT with no reason (it has no type to name)", async () => {
      process.env.MONEYSWITCH_NETWORKS = TESTNET.caip2;
      const out = await buy(keys.old, testnetSeller);
      expect(out.status).toBe("ok");
      const refused = await buy(keys.old, mainnetSeller);
      expect(refused.code).toBe("UNSUPPORTED_PAYMENT");
      expect(refused.reason).toBeUndefined();
    });
  });

  describe("a key without a type under a typed parent follows its parent; a chain whose types disagree pays nothing", () => {
    const hosts = () => sellers().map((s) => `127.0.0.1:${s.port}`);
    async function childOf(mode: "testnet" | "mainnet") {
      const parent = createMoneyKey(t.ctx.db, {
        name: `parent-${mode}`,
        totalBudget: parseUsdcToMicros("10"),
        dailyBudget: parseUsdcToMicros("5"),
        perRequestLimit: parseUsdcToMicros("1"),
        allowedHosts: hosts(),
        canDelegate: true,
        networkMode: mode,
      });
      const made = await t.app.inject({
        method: "POST",
        url: "/v1/keys/children",
        headers: { authorization: `Bearer ${parent.plaintextKey}` },
        payload: { name: `child-${mode}`, daily_budget: "1", total_budget: "2", per_request_limit: "0.5" },
      });
      expect(made.statusCode).toBe(200);
      return { id: made.json().id as string, key: made.json().key as string };
    }

    it("the untyped child of a mainnet parent pays the mainnet and never the testnet", async () => {
      const kid = await childOf("mainnet");
      t.ctx.sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id = ?").run(kid.id); // a child of a key from before the column
      const out = await buy(kid.key, bothSeller);
      expect(out.status).toBe("ok");
      expect(out.payment.network).toBe(MAINNET.caip2);
      const rowsBefore = paymentRows();
      const refused = await buy(kid.key, testnetSeller);
      expect(refused.code).toBe("UNSUPPORTED_PAYMENT");
      expectNothingHappened(testnetSeller, rowsBefore);
    });

    it("a testnet child under a mainnet parent (the database was edited): UNSUPPORTED_PAYMENT, charged no, nothing leased, reserved or signed", async () => {
      const kid = await childOf("mainnet");
      t.ctx.sqlite.prepare("UPDATE money_keys SET network_mode = 'testnet' WHERE id = ?").run(kid.id);
      for (const seller of [testnetSeller, mainnetSeller, bothSeller]) {
        const rowsBefore = paymentRows();
        const out = await buy(kid.key, seller);
        expect(out.status).toBe("denied");
        expect(out.code).toBe("UNSUPPORTED_PAYMENT");
        expect(out.charged).toBe("no");
        expect(out.reason).toContain("disagrees with its parent");
        expectNothingHappened(seller, rowsBefore);
      }
      expect(reads).toEqual([]);
    });
  });
});

describe("a child key pays like its parent", () => {
  it("the child of a testnet key cannot pay a mainnet-only seller either", async () => {
    const parent = createMoneyKey(t.ctx.db, {
      name: "parent",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("5"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: sellers().map((s) => `127.0.0.1:${s.port}`),
      canDelegate: true,
      networkMode: "testnet",
    });
    const made = await t.app.inject({
      method: "POST",
      url: "/v1/keys/children",
      headers: { authorization: `Bearer ${parent.plaintextKey}` },
      payload: { name: "child", daily_budget: "1", total_budget: "2", per_request_limit: "0.5" },
    });
    expect(made.statusCode).toBe(200);
    const childKey = made.json().key as string;
    expect(made.json().network_mode).toBe("testnet");
    const rowsBefore = paymentRows();
    const refused = await buy(childKey, mainnetSeller);
    expect(refused.code).toBe("UNSUPPORTED_PAYMENT");
    expectNothingHappened(mainnetSeller, rowsBefore);
    expect((await buy(childKey, testnetSeller)).payment.network).toBe(TESTNET.caip2);
  });
});
