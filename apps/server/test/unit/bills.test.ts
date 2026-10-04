import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

// GET /v1/admin/usage is the Bills page (SPEC.md §2: every payment). It used to return the newest 200 and say nothing about the rest.
// The hard cap (BILLS_MAX_ROWS) is tested in packages/core with a small max; here: past 200 nothing is cut, and the answer says so.
describe("GET /v1/admin/usage: every payment, with truncated and total", () => {
  let t: TestCtx;
  let keyId: string;
  const COUNT = 250;
  beforeAll(async () => {
    t = await buildTestApp();
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name: "agent", total_budget: "5", daily_budget: "1", per_request_limit: "0.1", allowed_hosts: ["example.com:443"] },
    });
    expect(created.statusCode).toBe(200);
    keyId = created.json().id;
    const insert = t.ctx.sqlite.prepare(
      `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind)
       VALUES (?, ?, 'https://example.com/premium', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, 'settled', ?, ?, 'fetch')`
    );
    const base = Date.parse("2026-10-04T00:00:00.000Z");
    t.ctx.sqlite.transaction(() => {
      for (let i = 0; i < COUNT; i++) {
        const at = new Date(base + i * 1000).toISOString();
        insert.run(`p${i}`, keyId, at, at);
      }
    })();
  });
  afterAll(async () => { await cleanupTestApp(t); });

  const usage = async () => (await t.app.inject({ url: "/v1/admin/usage", headers: { authorization: `Bearer ${t.adminToken}` } })).json();

  it("more than 200 payments: all of them, newest first, truncated false, total correct", async () => {
    const body = await usage();
    expect(body.payments).toHaveLength(COUNT);
    expect(body.truncated).toBe(false);
    expect(body.total).toBe(COUNT);
    expect(body.payments[0].id).toBe(`p${COUNT - 1}`);
    expect(body.payments[COUNT - 1].id).toBe("p0");
  });

  it("each payment keeps exactly the fields it had before (backward compatible)", async () => {
    const [row] = (await usage()).payments as Array<Record<string, unknown>>;
    expect(Object.keys(row).sort()).toEqual(
      ["amount", "approval_id", "asset", "created_at", "error_code", "host", "id", "key_id", "kind", "method", "network", "pay_to", "status", "tx_hash", "updated_at", "url"].sort()
    );
    expect(row).toMatchObject({ key_id: keyId, amount: "0.01", status: "settled", pay_to: "0xb", method: "GET", approval_id: null, kind: "fetch" });
  });

  it("still admin-only", async () => {
    expect((await t.app.inject({ url: "/v1/admin/usage" })).statusCode).toBe(403);
  });
});
