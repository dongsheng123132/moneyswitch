import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { TESTNET } from "@moneyswitch/x402";
import { monadTestnet } from "@moneyswitch/tollbooth";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

describe("SPEC-v0.5: shared facts stay in sync", () => {
  it("packages/tollbooth monadTestnet() (used by `moneyswitch sell`) equals packages/x402 TESTNET", () => {
    const n = monadTestnet();
    expect(n.caip2).toBe(TESTNET.caip2);
    expect(n.usdcAddress).toBe(TESTNET.usdcAddress);
    expect(n.usdcDomainName).toBe(TESTNET.usdcDomainName);
    expect(n.usdcDomainVersion).toBe(TESTNET.usdcDomainVersion);
    expect(n.facilitatorUrl).toBe(TESTNET.facilitatorUrl);
  });
});

describe("SPEC-v0.5 §1 key-field guard on the server", () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(async () => cleanupTestApp(t));

  it("a 0x address used as a MoneyKey gets KEY_INVALID + hint LOOKS_LIKE_ADDRESS", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: "Bearer 0x534b2f3A21130d7a60830c2Df862319e593943A3" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "KEY_INVALID", hint: "LOOKS_LIKE_ADDRESS" });
  });

  it("toll booth admin API requires the admin token", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/tollbooths" });
    expect(res.statusCode).toBe(403);
    const earn = await t.app.inject({ method: "GET", url: "/v1/admin/earnings", headers: { authorization: "Bearer mk_live_x" } });
    expect(earn.statusCode).toBe(403);
  });

  it("creating a toll booth without a wallet and without pay_to explains what to do", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/admin/tollbooths",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name: "x", upstream_url: "http://127.0.0.1:8000", default_price: "0.01" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PAY_TO_REQUIRED");
  });

  it("unknown toll booth → JSON 404, never the Dashboard HTML", async () => {
    const res = await t.app.inject({ method: "GET", url: "/t/nope/anything" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("TOLLBOOTH_NOT_FOUND");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });
});
