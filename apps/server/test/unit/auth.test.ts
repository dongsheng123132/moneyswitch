import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

describe("Admin auth", () => {
  it("admin token can create a key", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: {
        name: "demo",
        total_budget: "5",
        daily_budget: "1",
        per_request_limit: "1",
        allowed_hosts: ["example.com:443"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key.startsWith("mk_live_")).toBe(true);
  });

  it("a MoneyKey calling an admin route -> 403", async () => {
    t = await buildTestApp();
    const createRes = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: {
        name: "demo",
        total_budget: "5",
        daily_budget: "1",
        per_request_limit: "1",
        allowed_hosts: ["example.com:443"],
      },
    });
    const moneyKey = createRes.json().key as string;

    const res = await t.app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${moneyKey}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("no token / garbage token on admin route -> 403", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: "GET", url: "/v1/keys" });
    expect(res.statusCode).toBe(403);
  });
});

describe("MoneyKey auth on agent routes", () => {
  it("invalid MoneyKey -> 401 KEY_INVALID", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: "Bearer mk_live_totallybogus0000000000000000" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("KEY_INVALID");
  });

  it("admin token on agent route -> 401", async () => {
    t = await buildTestApp();
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${t.adminToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("valid MoneyKey -> /v1/status ok", async () => {
    t = await buildTestApp();
    const createRes = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: {
        name: "demo",
        total_budget: "5",
        daily_budget: "1",
        per_request_limit: "1",
        allowed_hosts: ["example.com:443"],
      },
    });
    const moneyKey = createRes.json().key as string;
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${moneyKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.remaining_today).toBe("1");
    expect(body.currency).toBe("USDC");
    // SPEC-v0.3-employee.md §B.0
    expect(body.key_name).toBe("demo");
    expect(body.key_prefix).toEqual(expect.stringContaining("mk_live_"));
    expect(moneyKey.startsWith(body.key_prefix)).toBe(true);
    expect(body.daily_budget).toBe("1");
    expect(body.total_budget).toBe("5");
  });
});
