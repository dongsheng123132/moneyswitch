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

  it("the same field rules as POST /v1/keys/children: one reading, one answer", async () => {
    t = await buildTestApp();
    const parent = await createKey({ can_delegate: true, max_payments_per_minute: 20, approval_threshold: "0.2" });
    const h = { authorization: `Bearer ${parent.json().key}` };
    // The bodies differ only where they must: a child key inherits its
    // parent's hosts, a root key with none has none.
    const shared: Array<[Record<string, unknown>, string]> = [
      [{ name: "" }, "name"],
      [{ name: 42 }, "name"],
      [{ total_budget: undefined }, "total_budget"],
      [{ total_budget: "-1" }, "total_budget"],
      [{ per_request_limit: "abc" }, "per_request_limit"],
      [{ allowed_hosts: "example.com:443" }, "allowed_hosts"],
      [{ allowed_hosts: ["https://example.com"] }, "allowed_hosts"],
      [{ can_delegate: "yes" }, "can_delegate"],
      [{ max_payments_per_minute: 0 }, "max_payments_per_minute"],
      [{ expires_at: "soon" }, "expires_at"],
    ];
    for (const [over, field] of shared) {
      const admin = await createKey(over);
      const child = await t.app.inject({
        method: "POST",
        url: "/v1/keys/children",
        headers: h,
        payload: { name: "kid", total_budget: "1", daily_budget: "0.1", per_request_limit: "0.05", ...over },
      });
      for (const [res, who] of [
        [admin, "admin"],
        [child, "child"],
      ] as const) {
        const b = res.json();
        expect(b.code, `${who} ${JSON.stringify(over)}`).toBe("INVALID_REQUEST");
        expect(b.field, `${who} ${JSON.stringify(over)}`).toBe(field);
        // the human sentence, without the "INVALID_REQUEST: " prefix logs carry
        expect(b.message, `${who} ${JSON.stringify(over)}`).not.toMatch(/^INVALID_REQUEST: /);
      }
    }
    expect(t.ctx.db.select().from(schema.moneyKeys).all().length).toBe(1);
  });

  it("an unparseable expires_at is refused by the route, not by the database layer", async () => {
    t = await buildTestApp();
    // Before: this fell through to core and came back as a FORBIDDEN whose
    // message carried the "FORBIDDEN: " prefix, with no `field` to fix.
    const res = await createKey({ expires_at: "not-a-date" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_REQUEST", code: "INVALID_REQUEST", field: "expires_at" });
    expect(res.json().message).not.toContain("FORBIDDEN");
  });

  it("a negative budget or a negative approval threshold is refused, not stored as a magnitude", async () => {
    t = await buildTestApp();
    for (const [over, field] of [
      [{ total_budget: "-1" }, "total_budget"],
      [{ daily_budget: "-1" }, "daily_budget"],
      [{ per_request_limit: "-1" }, "per_request_limit"],
      [{ approval_threshold: "-1" }, "approval_threshold"],
    ] as const) {
      const res = await createKey(over as Record<string, unknown>);
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json().code, JSON.stringify(over)).toBe("INVALID_REQUEST");
      expect(res.json().field, JSON.stringify(over)).toBe(field);
    }
    expect(t.ctx.db.select().from(schema.moneyKeys).all().length).toBe(0);
  });

  it("an approval_threshold above the per-request limit is refused: it could never fire", async () => {
    t = await buildTestApp();
    const res = await createKey({ per_request_limit: "0.5", approval_threshold: "0.6" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_REQUEST", field: "approval_threshold" });
    // equal to the limit is fine (every payment at the limit asks)
    expect((await createKey({ per_request_limit: "0.5", approval_threshold: "0.5" })).statusCode).toBe(200);
  });

  it("an omitted allowed_hosts is a root key with no hosts; every site then asks a person", async () => {
    t = await buildTestApp();
    const res = await createKey({ allowed_hosts: undefined });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowed_hosts).toEqual([]);
  });

  it("the hosts a key is issued with match what the gate later compares", async () => {
    t = await buildTestApp();
    for (const ok of ["example.com", "example.com:8443", "api.test", "127.0.0.1:4020", "localhost:4020", "example.com.:443", "[::1]:8080"]) {
      expect((await createKey({ allowed_hosts: [ok] })).statusCode, ok).toBe(200);
    }
    for (const bad of ["https://example.com", "example.com/v1", "user@example.com", "example.com:0", "example.com:99999"]) {
      const res = await createKey({ allowed_hosts: [bad] });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().field, bad).toBe("allowed_hosts");
    }
  });
});
