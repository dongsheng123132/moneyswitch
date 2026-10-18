import { describe, it, expect, afterEach } from "vitest";
import { schema } from "@moneyswitch/db";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/**
 * POST /v1/keys (admin) field rules must match POST /v1/keys/children
 * (children.ts / delegation.ts): a missing or malformed field is a 400
 * INVALID_REQUEST naming the field. Before this suite, a missing budget
 * leaked `Cannot read properties of undefined (reading 'trim')`, a missing
 * name leaked a SQLite NOT NULL error, and a non-array allowed_hosts was
 * stored as a string (which later made /v1/fetch drop `code` from its envelope).
 */

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

function createKey(over: Record<string, unknown> = {}) {
  return t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: {
      name: "agent",
      total_budget: "10",
      daily_budget: "1",
      per_request_limit: "0.5",
      allowed_hosts: ["example.com:443"],
      network_mode: "testnet",
      ...over,
    },
  });
}

describe("POST /v1/keys: input validation", () => {
  it("missing / malformed fields -> 400 INVALID_REQUEST naming the field, and no key row", async () => {
    t = await buildTestApp();
    for (const [over, field] of [
      [{ name: undefined }, "name"],
      [{ name: "" }, "name"],
      [{ name: "   " }, "name"],
      [{ total_budget: undefined }, "total_budget"],
      [{ daily_budget: null }, "daily_budget"],
      [{ per_request_limit: "abc" }, "per_request_limit"],
      [{ approval_threshold: "x" }, "approval_threshold"],
      [{ allowed_hosts: "example.com:443" }, "allowed_hosts"],
      [{ allowed_hosts: [42] }, "allowed_hosts"],
      [{ allowed_hosts: [""] }, "allowed_hosts"],
      [{ allowed_hosts: ["https://example.com"] }, "allowed_hosts"],
      [{ allowed_hosts: ["example.com/path"] }, "allowed_hosts"],
      [{ can_delegate: "yes" }, "can_delegate"],
      [{ max_payments_per_minute: 0 }, "max_payments_per_minute"],
      [{ expires_at: 42 }, "expires_at"],
    ] as const) {
      const res = await createKey(over as Record<string, unknown>);
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      const b = res.json();
      expect(b.error).toBe("INVALID_REQUEST");
      expect(b.code).toBe("INVALID_REQUEST");
      expect(b.field).toBe(field);
      expect(String(b.message)).not.toMatch(/Cannot read properties|NOT NULL|TypeError/);
    }
    expect(t.ctx.db.select().from(schema.moneyKeys).all().length).toBe(0);
  });

  it("numbers are accepted as amounts too, like the child-key body parser", async () => {
    t = await buildTestApp();
    const res = await createKey({
      total_budget: 10,
      daily_budget: 1,
      per_request_limit: 0.5,
      approval_threshold: 0.2,
    });
    expect(res.statusCode).toBe(200);
    const k = res.json();
    expect(k.total_budget).toBe("10");
    expect(k.approval_threshold).toBe("0.2");
  });

  it("name and host entries are trimmed; host entry with a scheme or path is refused", async () => {
    t = await buildTestApp();
    const ok = await createKey({
      name: "  spaced  ",
      allowed_hosts: ["  example.com:443  ", "bare.example"],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe("spaced");
    expect(ok.json().allowed_hosts).toEqual(["example.com:443", "bare.example"]);

    const scheme = await createKey({ allowed_hosts: ["https://example.com"] });
    expect(scheme.statusCode).toBe(400);
    expect(scheme.json().field).toBe("allowed_hosts");

    const path = await createKey({ allowed_hosts: ["example.com:443/path"] });
    expect(path.statusCode).toBe(400);
  });

  it("missing budgets never throw TypeError; missing name never leaks SQLite", async () => {
    t = await buildTestApp();
    const noBudgets = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name: "x" },
    });
    expect(noBudgets.statusCode).toBe(400);
    expect(noBudgets.json()).toMatchObject({ code: "INVALID_REQUEST", field: "total_budget" });

    const noName = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { total_budget: "1", daily_budget: "1", per_request_limit: "1", allowed_hosts: [] },
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json()).toMatchObject({ code: "INVALID_REQUEST", field: "name" });
    expect(JSON.stringify(noName.json())).not.toContain("NOT NULL");
  });

  it("valid body still issues a key (happy path unchanged)", async () => {
    t = await buildTestApp();
    const res = await createKey();
    expect(res.statusCode).toBe(200);
    const k = res.json();
    expect(k.key).toMatch(/^mk_live_/);
    expect(k.approval_pin).toMatch(/^\d{4,6}$/);
    expect(k.allowed_hosts).toEqual(["example.com:443"]);
    expect(k.network_mode).toBe("testnet");
  });
});
