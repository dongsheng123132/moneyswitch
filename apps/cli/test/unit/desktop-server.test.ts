import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parse } from "smol-toml";
import { createUiServer } from "../../src/desktop/server.js";
import { DesktopService } from "../../src/desktop/service.js";
import { SessionManager } from "../../src/desktop/session.js";
import { desktopStorePath } from "../../src/desktop/paths.js";
import { FakeAgentRunner } from "../helpers/fake-claude.js";
import { tmpHome } from "../helpers/tmp-home.js";
// @ts-expect-error plain .mjs helper shared with the Playwright walkthrough
import { createMockMoneyServer } from "../helpers/mock-money-server.mjs";

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

describe("desktop console HTTP API (session, CSRF, preview -> apply -> restore)", () => {
  const { home, env } = tmpHome();
  const money = createMockMoneyServer({ daily: "10.00", total: "100.00", per: "1.00" });
  let moneyUrl = "";
  let base = "";
  let origin = "";
  let cookie = "";
  let close: () => Promise<void>;
  const mcp = { command: "node", args: ["/abs/mcp/index.js"] };

  beforeAll(async () => {
    moneyUrl = await money.listen();
    const port = await freePort();
    const sessions = new SessionManager(port, "one-time-token");
    const service = new DesktopService({ env, runner: new FakeAgentRunner(home), mcpCommand: mcp });
    const { server } = createUiServer({ port, service, sessions, assetsDir: path.join(home, "no-assets") });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${port}`;
    origin = base;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterAll(async () => {
    await close();
    await money.close();
  });

  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { ...(method === "GET" ? {} : { "content-type": "application/json", origin }), ...(cookie ? { cookie } : {}), ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });

  it("refuses the API before login, then logs in with the one-time token only once", async () => {
    expect((await call("GET", "/api/state")).status).toBe(401);
    const bad = await call("POST", "/api/session", { token: "nope" });
    expect(bad.status).toBe(401);
    const ok = await call("POST", "/api/session", { token: "one-time-token" });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    cookie = setCookie.split(";")[0];
    expect((await call("POST", "/api/session", { token: "one-time-token" })).status).toBe(401);
    expect((await call("GET", "/api/state")).status).toBe(200);
  });

  it("blocks cross-origin writes even with the cookie", async () => {
    const r = await call("PUT", "/api/account", { server: moneyUrl, key: money.root.key }, { origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(fs.existsSync(desktopStorePath(env))).toBe(false);
  });

  it("connects the account (validated against /v1/status) and stores it locally", async () => {
    const r = await call("PUT", "/api/account", { server: `${moneyUrl}/`, key: money.root.key });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.keyMasked).not.toContain(money.root.key);
    const stored = JSON.parse(fs.readFileSync(desktopStorePath(env), "utf8"));
    expect(stored.server).toBe(moneyUrl);
    expect(stored.key).toBe(money.root.key);
    const st = await (await call("GET", "/api/state")).json();
    expect(JSON.stringify(st)).not.toContain(money.root.key);
  });

  it("rejects a child key above the parent's limits (server-side CHILD_EXCEEDS_PARENT surfaces with the field)", async () => {
    const r = await call("POST", "/api/agents/codex/wallet/child", { daily_budget: "50", per_request_limit: "0.5", total_budget: "10" });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe("CHILD_EXCEEDS_PARENT");
    expect(b.detail.field).toBe("daily_budget");
  });

  it("cuts a child key for Codex and saves the model config", async () => {
    const c = await call("POST", "/api/agents/codex/wallet/child", { daily_budget: "2.00", per_request_limit: "0.50", total_budget: "20.00" });
    expect(c.status).toBe(200);
    const w = (await c.json()).wallet;
    expect(w.source).toBe("child");
    expect(w.keyMasked).toMatch(/^mk_live_/);
    const b = await call("PUT", "/api/agents/codex/brain", { preset: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-fake-codex-1234567890", model: "gpt-6-sol" });
    expect(b.status).toBe(200);
    expect(JSON.stringify(await b.json())).not.toContain("sk-fake-codex-1234567890");
  });

  it("preview does not write; apply requires the matching planId", async () => {
    const cfg = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(cfg, 'model = "o3"\n');
    const pv = await (await call("POST", "/api/agents/codex/preview", { action: "enable" })).json();
    expect(fs.readFileSync(cfg, "utf8")).toBe('model = "o3"\n');
    expect(pv.plan.files[0].display).toBe("~/.codex/config.toml");
    expect(JSON.stringify(pv)).not.toContain("sk-fake-codex-1234567890");

    expect((await call("POST", "/api/agents/codex/apply", { action: "enable", planId: "stale" })).status).toBe(409);
    // an edit between preview and confirm invalidates the plan
    fs.writeFileSync(cfg, 'model = "o4"\n');
    expect((await call("POST", "/api/agents/codex/apply", { action: "enable", planId: pv.planId })).status).toBe(409);

    const pv2 = await (await call("POST", "/api/agents/codex/preview", { action: "enable" })).json();
    const r = await call("POST", "/api/agents/codex/apply", { action: "enable", planId: pv2.planId });
    expect(r.status).toBe(200);
    const res = await r.json();
    expect(res.status).toBe("enabled");
    expect(res.backups[0]).toMatch(/config\.toml\.bak-\d+$/);
    const doc = parse(fs.readFileSync(cfg, "utf8")) as any;
    expect(doc.model).toBe("gpt-6-sol");
    expect(doc.mcp_servers.moneyswitch.env.MONEY_API_KEY).toMatch(/^mk_live_/);
    expect(doc.mcp_servers.moneyswitch.env.MONEY_API_KEY).not.toBe(money.root.key);
  });

  it("shows drift after an external edit, and today's spend per agent", async () => {
    const cfg = path.join(home, ".codex", "config.toml");
    const child = [...money.byId.values()].find((k: any) => k.parentId === "key_root") as any;
    money.spend(child.id, "0.35");
    const usage = await (await call("GET", "/api/usage")).json();
    expect(usage.agents.codex.used_today).toBe("0.35");
    expect(usage.account.remaining_today).toBe("9.65");

    const original = fs.readFileSync(cfg, "utf8");
    fs.writeFileSync(cfg, original.replace('"gpt-6-sol"', '"hand-edited"'));
    const st = await (await call("GET", "/api/state")).json();
    expect(st.agents.find((a: any) => a.id === "codex").status).toBe("drifted");
    fs.writeFileSync(cfg, original);
  });

  it("refuses to drop the wallet while enabled; disable restores the original file", async () => {
    expect((await call("DELETE", "/api/agents/codex/wallet", { revoke: true })).status).toBe(409);
    const pv = await (await call("POST", "/api/agents/codex/preview", { action: "disable" })).json();
    const r = await call("POST", "/api/agents/codex/apply", { action: "disable", planId: pv.planId });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe('model = "o4"\n');
    const del = await call("DELETE", "/api/agents/codex/wallet", { revoke: true });
    expect((await del.json()).revoked).toBe(true);
    const child = [...money.byId.values()].find((k: any) => k.parentId === "key_root") as any;
    expect(child.revoked).toBe(true);
  });

  it("never sends the model API key to the MoneySwitch server", () => {
    // Only /v1/* MoneyKey calls reached it.
    expect(money.requests.every((r: any) => r.url.startsWith("/v1/") || r.url.startsWith("/dl/"))).toBe(true);
    expect(JSON.stringify(money.requests)).not.toContain("sk-fake-codex");
  });
});
