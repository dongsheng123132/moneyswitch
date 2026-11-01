import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { createMoneyKey, evaluateAndReserve, revokeMoneyKey, MoneySwitchError } from "@moneyswitch/core";

const { paidFetch } = vi.hoisted(() => ({ paidFetch: vi.fn() }));
vi.mock("@moneyswitch/x402", async (importOriginal) => ({
  ...await importOriginal<typeof import("@moneyswitch/x402")>(),
  performPaidFetch: paidFetch,
}));

describe("purpose and explicit network at the Agent boundary", () => {
  let t: TestCtx;
  let keyId: string;
  let moneyKey: string;
  let otherKey: string;
  const asKey = () => ({ authorization: `Bearer ${moneyKey}` });
  const asAdmin = () => ({ authorization: `Bearer ${t.adminToken}` });
  const request = (extra: Record<string, unknown> = {}) => t.app.inject({
    method: "POST", url: "/v1/fetch", headers: asKey(), payload: { url: "https://example.com/data", ...extra },
  });
  beforeAll(async () => {
    t = await buildTestApp({ unlockWallet: true });
    const keyInput = { name: "market-agent", totalBudget: 10_000_000n, dailyBudget: 1_000_000n, perRequestLimit: 100_000n, allowedHosts: ["example.com:443"] };
    const issued = createMoneyKey(t.ctx.db, keyInput);
    keyId = issued.row.id;
    moneyKey = issued.plaintextKey;
    otherKey = createMoneyKey(t.ctx.db, { ...keyInput, name: "another-agent" }).plaintextKey;
  });
  beforeEach(() => {
    paidFetch.mockReset();
    paidFetch.mockResolvedValue({ charged: "no", httpStatus: 200, headers: {}, body: { ok: true }, payment: null, approvalId: null });
  });
  afterAll(async () => { await cleanupTestApp(t); });

  it("rejects non-string or oversized purposes before approvals or upstream requests", async () => {
    for (const purpose of [null, 42, {}, "x".repeat(161)]) {
      const result = await request({ purpose });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ status: "error", charged: "no", reason: expect.stringContaining("purpose") });
    }
    expect(paidFetch).not.toHaveBeenCalled();
    expect(t.ctx.sqlite.prepare("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  it("passes the exact Solana CAIP-2 and a coarse trimmed purpose, with Unicode characters counted correctly", async () => {
    const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const result = await request({ network, purpose: "  获取市场数据  " });
    expect(result.json().status).toBe("ok");
    expect(paidFetch.mock.calls[0][4]).toMatchObject({ network, purpose: "获取市场数据" });
    expect((await request({ purpose: "😀".repeat(160) })).statusCode).toBe(200);
    expect(paidFetch.mock.calls[1][4].purpose).toBe("😀".repeat(160));
  });

  it("omitted or whitespace-only purpose never copies the task or request body into an annotation", async () => {
    const taskBody = { confidentialTask: "private employee project" };
    for (const extra of [{ body: taskBody }, { purpose: "   ", body: taskBody }]) {
      expect((await request(extra)).json().status).toBe("ok");
      expect(paidFetch.mock.calls.at(-1)?.[4]).toMatchObject({ purpose: undefined, body: taskBody, network: undefined });
    }
  });

  it("rejects malformed network identifiers before approvals or upstream requests", async () => {
    for (const network of [null, 42, {}, "sol", "eip155:", " eip155:84532", "solana:" + "x".repeat(33)]) {
      const result = await request({ network });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ charged: "no", reason: expect.stringContaining("CAIP-2") });
    }
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it("explains the required network when the payment layer refuses it, without hiding the reason", async () => {
    paidFetch.mockRejectedValueOnce(new MoneySwitchError("UNSUPPORTED_PAYMENT", "The requested payment network is not enabled for this key; no other chain will be used"));
    const result = await request({ network: "eip155:84532" });
    expect(result.json()).toMatchObject({
      status: "denied", code: "UNSUPPORTED_PAYMENT", charged: "no",
      reason: "Requested network eip155:84532: The requested payment network is not enabled for this key; no other chain will be used",
    });
    paidFetch.mockRejectedValueOnce(new MoneySwitchError("UNSUPPORTED_PAYMENT"));
    const unsupportedSeller = await request({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    expect(unsupportedSeller.json().reason).toContain("no other chain was used");
  });

  it("exposes optional trace fields only to this key and the administrator, retaining revoked key names", async () => {
    const key = (await import("@moneyswitch/core")).getMoneyKeyById(t.ctx.db, keyId)!;
    const paymentId = evaluateAndReserve(t.ctx.db, key, {
      url: "https://example.com/data", host: "example.com:443", method: "GET", body: undefined,
      network: "eip155:84532", asset: "0xusdc", payTo: "0xseller", amount: 10_000n, purpose: "获取市场数据",
    }).paymentId;
    const history = (await t.app.inject({ url: "/v1/history", headers: asKey() })).json().history;
    expect(history).toContainEqual(expect.objectContaining({ id: paymentId, purpose: "获取市场数据", asset: "0xusdc", pay_to: "0xseller" }));
    const otherHistory = await t.app.inject({ url: "/v1/history", headers: { authorization: `Bearer ${otherKey}` } });
    expect(otherHistory.json().history).toEqual([]);
    const forbidden = await t.app.inject({ url: "/v1/admin/usage", headers: { authorization: `Bearer ${otherKey}` } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).not.toHaveProperty("payments");
    const now = new Date().toISOString();
    t.ctx.sqlite.prepare(`INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at)
      VALUES ('missing-key-payment', 'missing-key', 'https://example.com/legacy', 'example.com:443', 'GET', 'eip155:84532', '0xusdc', '0xseller', 10000, 'settled', ?, ?)`).run(now, now);
    revokeMoneyKey(t.ctx.db, keyId);
    const usage = (await t.app.inject({ url: "/v1/admin/usage", headers: asAdmin() })).json().payments;
    expect(usage).toContainEqual(expect.objectContaining({ id: paymentId, key_id: keyId, key_name: "market-agent", purpose: "获取市场数据" }));
    expect(usage).toContainEqual(expect.objectContaining({ id: "missing-key-payment", key_name: null, purpose: null }));
  });
});
