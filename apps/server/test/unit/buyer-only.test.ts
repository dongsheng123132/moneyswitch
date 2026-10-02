import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

describe("v0.6 buyer-only surface", () => {
  let t: TestCtx;
  beforeAll(async () => { t = await buildTestApp(); });
  afterAll(async () => { await cleanupTestApp(t); });
  it("has no seller endpoints, including for an administrator", async () => {
    for (const url of ["/v1/admin/tollbooths", "/v1/admin/earnings", "/t/old-service/data"]) {
      const response = await t.app.inject({ url, headers: { authorization: `Bearer ${t.adminToken}` } });
      expect(response.statusCode).toBe(404);
    }
  });
  it("retains the legacy seller tables without exposing them", () => {
    const rows = t.ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("tollbooths");
    expect(names).toContain("tollbooth_routes");
    expect(names).toContain("earnings");
  });
  it("still catches a public address pasted as a MoneyKey", async () => {
    const response = await t.app.inject({ url: "/v1/status", headers: { authorization: "Bearer 0x534b2f3A21130d7a60830c2Df862319e593943A3" } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "KEY_INVALID", hint: "LOOKS_LIKE_ADDRESS" });
  });
});
