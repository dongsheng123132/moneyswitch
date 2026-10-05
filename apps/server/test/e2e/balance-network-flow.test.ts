import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { BASE_SEPOLIA, TESTNET, type KnownBalanceReader } from "@moneyswitch/x402";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * SPEC.md §6 through POST /v1/fetch: the wallet's balance per chain (AppContext.balanceReader, a fake here, so no RPC is touched) decides
 * whether a payment goes out and on which chain; a wallet that cannot cover the price on any chain the seller accepts is told so
 * (INSUFFICIENT_FUNDS: denied, charged no) before anything is leased, reserved or signed.
 */

let t: TestCtx;
let seller: StubSeller;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let key: string;
const originalNetworks = process.env.MONEYSWITCH_NETWORKS;
let reads: string[] = [];
/** caip2 -> balance, null (or missing) = the chain's RPC does not answer. */
let balances = new Map<string, bigint | null>();

beforeAll(async () => {
  t = await buildTestApp({ unlockWallet: true, port: 0 });
  const reader: KnownBalanceReader = async (_address, network) => {
    reads.push(network.caip2);
    return balances.get(network.caip2) ?? null;
  };
  t.ctx.balanceReader = reader;
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorUrl = `http://127.0.0.1:${(facilitator.server.address() as { port: number }).port}`;
  seller = await startStubSeller({ facilitatorUrl, payTo: "0x1111111111111111111111111111111111111111", network: BASE_SEPOLIA });
  const response = await t.app.inject({ method: "POST", url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` }, payload: {
    name: "balance-network", daily_budget: "5", total_budget: "10", per_request_limit: "1",
    allowed_hosts: [`127.0.0.1:${seller.port}`],
  } });
  key = response.json().key;
}, 30_000);
afterAll(async () => {
  await seller?.close(); await facilitator?.close();
  if (t) await cleanupTestApp(t);
});
beforeEach(() => {
  process.env.MONEYSWITCH_NETWORKS = `${TESTNET.caip2},${BASE_SEPOLIA.caip2}`;
  seller.reset();
  reads = [];
  balances = new Map();
});
afterEach(() => {
  if (originalNetworks === undefined) delete process.env.MONEYSWITCH_NETWORKS;
  else process.env.MONEYSWITCH_NETWORKS = originalNetworks;
});

async function buy() {
  const response = await t.app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: seller.url, max_price: "0.01" } });
  return response.json();
}
const paymentRows = () => (t.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n;

describe("POST /v1/fetch with the wallet's balances known", () => {
  it("INSUFFICIENT_FUNDS when no chain the seller accepts can cover the price: denied, charged no, nothing reserved or sent", async () => {
    balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 9_999n); // the seller only takes Base Sepolia, 0.01 USDC = 10000
    const rowsBefore = paymentRows();
    const out = await buy();
    expect(out.status).toBe("denied");
    expect(out.code).toBe("INSUFFICIENT_FUNDS");
    expect(out.charged).toBe("no");
    expect(out.payment).toBeNull();
    expect(paymentRows(), "no payments row").toBe(rowsBefore);
    expect(seller.requests.filter((r) => r.paid), "nothing signed reached the seller").toHaveLength(0);
    expect(seller.settleCalls()).toBe(0);
    expect(reads, "only the chain the seller accepts was looked at").toEqual([BASE_SEPOLIA.caip2]);
  });

  it("pays on the chain that has the money", async () => {
    balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 5_000_000n);
    const out = await buy();
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("yes");
    expect(out.payment.network).toBe(BASE_SEPOLIA.caip2);
  });

  it("still pays when the balance cannot be read (an RPC that does not answer is not a refusal)", async () => {
    const out = await buy(); // no entry in `balances`: every chain answers "unknown"
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("yes");
    expect(out.payment.network).toBe(BASE_SEPOLIA.caip2);
  });

  it("a free resource reads no balance", async () => {
    seller.setBehavior({ free: true });
    const out = await buy();
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("no");
    expect(out.payment).toBeNull();
    expect(reads).toHaveLength(0);
  });
});

/** The chain the signed payment that reached the seller was made for, read from its own PAYMENT-SIGNATURE header (not from our books). */
function networkPaidAtSeller(): string {
  const paid = seller.requests.filter((r) => r.paid);
  expect(paid, "exactly one signed payment reached the seller").toHaveLength(1);
  const header = (paid[0].headers["payment-signature"] ?? paid[0].headers["x-payment"]) as string;
  return (decodePaymentSignatureHeader(header) as { accepted: { network: string } }).accepted.network;
}

describe("POST /v1/fetch to a seller that accepts two chains", () => {
  // MONEYSWITCH_NETWORKS is Testnet, then Base Sepolia (beforeEach); this seller lists Base Sepolia FIRST, Testnet second.
  describe("listing them in the opposite order to MONEYSWITCH_NETWORKS", () => {
    beforeEach(() => seller.setBehavior({ networks: [BASE_SEPOLIA, TESTNET] }));

    it("pays on Base Sepolia when Testnet holds nothing and Base Sepolia can cover it", async () => {
      balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      const out = await buy();
      expect(out.status).toBe("ok");
      expect(out.charged).toBe("yes");
      expect(out.payment.network).toBe(BASE_SEPOLIA.caip2);
      expect(networkPaidAtSeller()).toBe(BASE_SEPOLIA.caip2);
      expect(reads.sort(), "both chains the seller accepts were looked at").toEqual([BASE_SEPOLIA.caip2, TESTNET.caip2].sort());
    });

    it("pays on the chain listed first in MONEYSWITCH_NETWORKS when both can cover it, not on the seller's first", async () => {
      balances.set(TESTNET.caip2, 5_000_000n).set(BASE_SEPOLIA.caip2, 5_000_000n);
      const out = await buy();
      expect(out.status).toBe("ok");
      expect(out.payment.network).toBe(TESTNET.caip2);
      expect(networkPaidAtSeller()).toBe(TESTNET.caip2);
    });

    it("INSUFFICIENT_FUNDS when neither can, though the seller accepts both", async () => {
      balances.set(TESTNET.caip2, 9_999n).set(BASE_SEPOLIA.caip2, 0n);
      const out = await buy();
      expect(out.status).toBe("denied");
      expect(out.code).toBe("INSUFFICIENT_FUNDS");
      expect(seller.requests.filter((r) => r.paid)).toHaveLength(0);
    });
  });

  it("skips the chain that holds nothing even when it is first both in MONEYSWITCH_NETWORKS and in the seller's own list", async () => {
    seller.setBehavior({ networks: [TESTNET, BASE_SEPOLIA] });
    balances.set(TESTNET.caip2, 0n).set(BASE_SEPOLIA.caip2, 5_000_000n);
    const out = await buy();
    expect(out.status).toBe("ok");
    expect(out.payment.network).toBe(BASE_SEPOLIA.caip2);
    expect(networkPaidAtSeller()).toBe(BASE_SEPOLIA.caip2);
  });
});
