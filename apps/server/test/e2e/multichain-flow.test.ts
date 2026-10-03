import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { BASE_SEPOLIA, TESTNET } from "@moneyswitch/x402";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

let t: TestCtx;
let seller: StubSeller;
let wrongAssetSeller: StubSeller;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let key: string;
const original = process.env.MONEYSWITCH_NETWORKS;
afterEach(() => {
  if (original === undefined) delete process.env.MONEYSWITCH_NETWORKS;
  else process.env.MONEYSWITCH_NETWORKS = original;
});
beforeAll(async () => {
  t = await buildTestApp({ unlockWallet: true, port: 0 });
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorUrl = `http://127.0.0.1:${(facilitator.server.address() as { port: number }).port}`;
  const payTo = "0x1111111111111111111111111111111111111111";
  seller = await startStubSeller({ facilitatorUrl, payTo, network: BASE_SEPOLIA });
  wrongAssetSeller = await startStubSeller({ facilitatorUrl, payTo, network: { ...BASE_SEPOLIA, usdcAddress: TESTNET.usdcAddress } });
  const response = await t.app.inject({ method: "POST", url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` }, payload: {
    name: "multichain", daily_budget: "5", total_budget: "10", per_request_limit: "1",
    allowed_hosts: [`127.0.0.1:${seller.port}`, `127.0.0.1:${wrongAssetSeller.port}`],
  } });
  key = response.json().key;
}, 30_000);
afterAll(async () => {
  await seller?.close(); await wrongAssetSeller?.close(); await facilitator?.close();
  if (t) await cleanupTestApp(t);
});
async function buy(url = seller.url) {
  const response = await t.app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url, max_price: "0.01" } });
  return response.json();
}
describe("payments select an enabled chain and its own USDC", () => {
  it("buys Base Sepolia while Monad is the default, with a valid EIP-3009 signature", async () => {
    process.env.MONEYSWITCH_NETWORKS = `${TESTNET.caip2},${BASE_SEPOLIA.caip2}`;
    const out = await buy();
    expect(out.status).toBe("ok");
    expect(out.charged).toBe("yes");
    expect(out.payment.network).toBe(BASE_SEPOLIA.caip2);
    expect(out.payment.tx_hash).toMatch(/^0xmock/);
    const row = t.ctx.sqlite.prepare("SELECT network, asset FROM payments WHERE tx_hash = ?").get(out.payment.tx_hash) as any;
    expect(row.network).toBe(BASE_SEPOLIA.caip2);
    expect(row.asset.toLowerCase()).toBe(BASE_SEPOLIA.usdcAddress.toLowerCase());
  });
  it("never signs for a disabled chain", async () => {
    process.env.MONEYSWITCH_NETWORKS = TESTNET.caip2;
    const calls = seller.settleCalls();
    const out = await buy();
    expect(out.charged).toBe("no");
    expect(out.status).not.toBe("ok");
    expect(seller.settleCalls()).toBe(calls);
  });
  it("never signs when the seller substitutes another chain's token", async () => {
    process.env.MONEYSWITCH_NETWORKS = `${TESTNET.caip2},${BASE_SEPOLIA.caip2}`;
    const out = await buy(wrongAssetSeller.url);
    expect(out.charged).toBe("no");
    expect(wrongAssetSeller.requests.every((r) => !r.paid)).toBe(true);
    expect(wrongAssetSeller.settleCalls()).toBe(0);
  });
});
