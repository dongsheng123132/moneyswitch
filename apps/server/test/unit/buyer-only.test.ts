import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

describe("v0.6 buyer-only surface", () => {
  let t: TestCtx;
  beforeAll(async () => { t = await buildTestApp(); });
  afterAll(async () => { await cleanupTestApp(t); });
  it("has no seller endpoints, including for an administrator", async () => {
    for (const url of ["/v1/admin/tollbooths", "/v1/admin/earnings"]) {
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

// The "atomic" trim: MoneySwitch is the wallet, MoneyKeys, approvals, the ledger and POST /v1/fetch. Everything below used to exist.
describe("atomic trim: the removed features answer 404", () => {
  let t: TestCtx;
  let keyId: string;
  let moneyKey: string;
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
    moneyKey = created.json().key;
  });
  afterAll(async () => { await cleanupTestApp(t); });

  const asAdmin = () => ({ authorization: `Bearer ${t.adminToken}` });
  const asKey = () => ({ authorization: `Bearer ${moneyKey}` });

  it("the OpenAI-compatible gateway is gone: /v1/chat/completions, /v1/models and the billing stubs, with a key and with the admin token", async () => {
    for (const headers of [asKey(), asAdmin()]) {
      for (const [method, url] of [
        ["POST", "/v1/chat/completions"],
        ["GET", "/v1/models"],
        ["GET", "/v1/dashboard/billing/subscription"],
        ["GET", "/v1/dashboard/billing/usage"],
      ] as const) {
        const res = await t.app.inject({ method, url, headers, ...(method === "POST" ? { payload: { model: "m", messages: [] } } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });

  it("the channel routes are gone: list, create, update, delete and probe-models", async () => {
    for (const [method, url] of [
      ["GET", "/v1/admin/channels"],
      ["POST", "/v1/admin/channels"],
      ["PATCH", "/v1/admin/channels/some-id"],
      ["DELETE", "/v1/admin/channels/some-id"],
      ["GET", "/v1/admin/channels/probe-models?base_url=http://127.0.0.1:1"],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: asAdmin(), ...(method === "POST" || method === "PATCH" ? { payload: { name: "x", base_url: "http://127.0.0.1:1", models: [] } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("there are no demo routes, no CLI download, and nothing in the setup / meta answers mentions a demo, the CLI or MCP", async () => {
    for (const url of ["/v1/demo", "/v1/demo/state", "/v1/admin/demo", "/v1/admin/demo/reset"]) {
      expect((await t.app.inject({ url, headers: asAdmin() })).statusCode, url).toBe(404);
    }
    const dl = await t.app.inject({ url: "/dl/moneyswitch.tgz" });
    expect(String(dl.headers["content-type"] ?? "")).not.toMatch(/gzip/);
    expect(dl.rawPayload.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);
    const status = await t.app.inject({ url: "/v1/setup/status" });
    expect(Object.keys(status.json())).toEqual(["setup_link_active"]);
    const meta = (await t.app.inject({ url: "/v1/admin/meta", headers: asAdmin() })).json();
    for (const field of ["demo", "demo_seller_url", "cli_tarball_available", "cli_local_path", "mcp_local_path"]) {
      expect(meta, field).not.toHaveProperty(field);
    }
    const wallet = (await t.app.inject({ url: "/v1/admin/wallet", headers: asAdmin() })).json();
    expect(wallet).not.toHaveProperty("simulated");
  });

  it("allowed_models is ignored: it is not validated, not stored, not returned; the DB column stays", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: asAdmin(),
      payload: { name: "old client", total_budget: "5", daily_budget: "1", per_request_limit: "0.1", allowed_hosts: [], allowed_models: ["gpt-4o", 3] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("allowed_models");
    const stored = t.ctx.sqlite.prepare("SELECT allowed_models FROM money_keys WHERE id = ?").get(res.json().id) as { allowed_models: string | null };
    expect(stored.allowed_models).toBeNull();
    const list = (await t.app.inject({ url: "/v1/keys", headers: asAdmin() })).json();
    for (const k of list.keys) expect(k).not.toHaveProperty("allowed_models");
    const columns = (t.ctx.sqlite.prepare("PRAGMA table_info(money_keys)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("allowed_models");
  });

  it("old payment rows of the gateway (kind chat) still list in the history and the usage, as ordinary payments without model or tokens", async () => {
    const now = new Date().toISOString();
    t.ctx.sqlite
      .prepare(
        `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind, model, prompt_tokens, completion_tokens)
         VALUES ('old-chat-1', ?, 'https://llm.example.com/v1/chat/completions', 'llm.example.com:443', 'POST', 'eip155:10143', '0xa', '0xb', 10000, 'settled', ?, ?, 'chat', 'old-model', 12, 34)`
      )
      .run(keyId, now, now);
    const history = (await t.app.inject({ url: "/v1/history", headers: asKey() })).json().history as Array<Record<string, unknown>>;
    const row = history.find((h) => h.id === "old-chat-1");
    expect(row).toMatchObject({ kind: "chat", url: "https://llm.example.com/v1/chat/completions", amount: "0.01", status: "settled" });
    expect(row).not.toHaveProperty("model");
    expect(row).not.toHaveProperty("prompt_tokens");
    expect(row).not.toHaveProperty("completion_tokens");
    const usage = (await t.app.inject({ url: "/v1/admin/usage", headers: asAdmin() })).json().payments as Array<Record<string, unknown>>;
    const urow = usage.find((p) => p.id === "old-chat-1");
    expect(urow).toMatchObject({ kind: "chat", key_id: keyId, status: "settled" });
    expect(urow).not.toHaveProperty("model");
    expect(urow).not.toHaveProperty("prompt_tokens");
  });

  it("the legacy channel table is kept (additive-only database)", () => {
    const names = (t.ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("channels");
    const columns = (t.ctx.sqlite.prepare("PRAGMA table_info(payments)").all() as { name: string }[]).map((c) => c.name);
    for (const legacy of ["kind", "model", "prompt_tokens", "completion_tokens"]) expect(columns).toContain(legacy);
  });
});
