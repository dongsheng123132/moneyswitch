import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/** A local stand-in for Feishu / WeCom / Telegram / a generic webhook: records every request, answers per path. */
interface Hit {
  path: string;
  body: any;
  headers: http.IncomingHttpHeaders;
}
let fake: http.Server;
let base: string;
let hits: Hit[] = [];

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // not json
      }
      hits.push({ path: req.url ?? "", body, headers: req.headers });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.startsWith("/feishu-bad")) return send(200, { code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" });
      if (req.url?.startsWith("/feishu")) return send(200, { StatusCode: 0, StatusMessage: "success", code: 0, data: {}, msg: "success" });
      if (req.url?.startsWith("/wecom")) return send(200, { errcode: 0, errmsg: "ok" });
      if (req.url?.includes("/sendMessage")) return send(200, { ok: true, result: { message_id: 1 } });
      if (req.url?.startsWith("/broken")) return send(500, { oops: true });
      return send(200, { received: true });
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => fake.close(r));
});

let t: TestCtx;
beforeEach(async () => {
  hits = [];
  t = await buildTestApp();
  // Isolate from the developer's real environment; read env from here instead of process.env.
  t.ctx.notify = { env: {}, log: { info: () => undefined, warn: () => undefined }, telegramApiBase: base };
});
afterEach(async () => {
  await cleanupTestApp(t);
});

const admin = () => ({ authorization: `Bearer ${t.adminToken}` });

async function createMoneyKey() {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: admin(),
    payload: { name: "k", total_budget: "5", daily_budget: "1", per_request_limit: "1", allowed_hosts: ["example.com:443"] },
  });
  return res.json().key as string;
}

const FEISHU_SECRET = "demo";
const TG_TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz012345";

describe("auth", () => {
  it("rejects missing, garbage and MoneyKey credentials on all three routes", async () => {
    const mk = await createMoneyKey();
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Bearer ${mk}` }]) {
      expect((await t.app.inject({ method: "GET", url: "/v1/admin/notify", headers })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers, payload: {} })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "POST", url: "/v1/admin/notify/test", headers })).statusCode).toBe(403);
    }
  });
});

describe("GET / PUT /v1/admin/notify", () => {
  it("starts unconfigured", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/admin/notify", headers: admin() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.values(body.channels).map((c: any) => c.configured)).toEqual([false, false, false, false]);
    expect(body.approve_url).toBeNull();
  });

  it("reports approve_url from MONEYSWITCH_PUBLIC_URL", async () => {
    t.ctx.config.publicUrl = "https://pay.example.com";
    const body = (await t.app.inject({ method: "GET", url: "/v1/admin/notify", headers: admin() })).json();
    expect(body.approve_url).toBe("https://pay.example.com/approvals");
  });

  it("saves, returns the masked view (never a full secret, not even right after saving), and persists the real values", async () => {
    const feishu = `${base}/feishu/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789`;
    const put = await t.app.inject({
      method: "PUT",
      url: "/v1/admin/notify",
      headers: admin(),
      payload: {
        feishu: { webhook: feishu, secret: "SuperSecretSigningKey" },
        telegram: { bot_token: TG_TOKEN, chat_id: "-100777" },
        webhook: { url: `${base}/hook/XXXX-secret-path-token` },
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await t.app.inject({ method: "GET", url: "/v1/admin/notify", headers: admin() });
    for (const res of [put, get]) {
      const raw = res.body;
      for (const secret of [feishu, "0a1b2c3d-4e5f", "SuperSecretSigningKey", TG_TOKEN, "AAE-abcdefghijklmnopqrstuvwxyz", "XXXX-secret-path-token"]) {
        expect(raw).not.toContain(secret);
      }
      const ch = res.json().channels;
      expect(ch.feishu).toMatchObject({ configured: true, webhook: { set: true, source: "db" }, secret: { set: true, masked: null } });
      expect(ch.feishu.webhook.masked).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/••••6789$/);
      expect(ch.telegram).toMatchObject({ configured: true, bot_token: { masked: "••••2345" }, chat_id: { value: "-100777" } });
      expect(ch.wecom.configured).toBe(false);
      expect(ch.webhook.configured).toBe(true);
    }
    // ...and the real values are what the sender will use
    const row = t.ctx.sqlite.prepare(`SELECT value FROM notify_settings WHERE key = 'feishu_webhook'`).get() as { value: string };
    expect(row.value).toBe(feishu);
  });

  it("partial update: absent fields stay, empty string clears", async () => {
    await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: { wecom: { webhook: `${base}/wecom?key=abc` }, webhook: { url: `${base}/hook` } } });
    const res = await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: { webhook: { url: "" } } });
    const ch = res.json().channels;
    expect(ch.wecom.configured).toBe(true);
    expect(ch.webhook.configured).toBe(false);
  });

  it("validates input: 400 with the offending field", async () => {
    const put = (payload: unknown) => t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: payload as object });
    let res = await put({ feishu: { webhook: "ftp://x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_URL", field: "feishu.webhook" });
    res = await put({ telegram: { bot_token: "nope" } });
    expect(res.json()).toEqual({ error: "INVALID_TELEGRAM_BOT_TOKEN", field: "telegram.bot_token" });
    res = await put({ unknown: { a: "b" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_FIELD");
    // nothing was written by the failed requests
    const rows = t.ctx.sqlite.prepare(`SELECT count(*) AS n FROM notify_settings`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("environment variables override stored values, show as source env, and are read-only (409)", async () => {
    await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: { wecom: { webhook: `${base}/wecom?key=stored` } } });
    t.ctx.notify = { ...t.ctx.notify, env: { MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: `${base}/wecom?key=FROM-ENV-0123456789` } };
    const get = await t.app.inject({ method: "GET", url: "/v1/admin/notify", headers: admin() });
    expect(get.json().channels.wecom.webhook).toMatchObject({ set: true, source: "env" });
    expect(get.body).not.toContain("FROM-ENV-0123456789");

    const put = await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: { wecom: { webhook: `${base}/other` } } });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toEqual({ error: "FIELD_FROM_ENV", field: "wecom.webhook" });
  });

  it("the audit log records which fields changed, never their values", async () => {
    await t.app.inject({ method: "PUT", url: "/v1/admin/notify", headers: admin(), payload: { feishu: { webhook: `${base}/feishu/UNIQUE-AUDIT-TOKEN-123`, secret: "audit-secret-xyz" } } });
    const rows = t.ctx.sqlite.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'notify.%'`).all() as { action: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("notify.update");
    expect(JSON.parse(rows[0].detail)).toEqual({ fields: ["feishu.webhook", "feishu.secret"] });
    expect(rows[0].detail).not.toContain("UNIQUE-AUDIT-TOKEN-123");
    expect(rows[0].detail).not.toContain("audit-secret-xyz");
  });
});

describe("POST /v1/admin/notify/test", () => {
  it("with nothing configured returns an empty result list", async () => {
    const res = await t.app.inject({ method: "POST", url: "/v1/admin/notify/test", headers: admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
    expect(hits).toHaveLength(0);
  });

  it("sends a test message to each configured channel and reports ok per channel (wire formats as documented)", async () => {
    // Pin the clock to the timestamp of Feishu's own doc example so the signature on the wire is the documented vector.
    t.ctx.notify = { ...t.ctx.notify, now: () => new Date(1599360473 * 1000) };
    const put = await t.app.inject({
      method: "PUT",
      url: "/v1/admin/notify",
      headers: admin(),
      payload: {
        feishu: { webhook: `${base}/feishu/hook/TOKEN-F`, secret: FEISHU_SECRET },
        wecom: { webhook: `${base}/wecom/send?key=TOKEN-W` },
        telegram: { bot_token: TG_TOKEN, chat_id: "-100777" },
        webhook: { url: `${base}/hook/TOKEN-H` },
      },
    });
    expect(put.statusCode).toBe(200);

    const res = await t.app.inject({ method: "POST", url: "/v1/admin/notify/test", headers: admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { channel: "feishu", ok: true },
        { channel: "wecom", ok: true },
        { channel: "telegram", ok: true },
        { channel: "webhook", ok: true },
      ],
    });

    const hit = (frag: string) => hits.find((h) => h.path.includes(frag))!;
    expect(hits).toHaveLength(4);
    expect(hit("TOKEN-F").body).toEqual({
      timestamp: "1599360473",
      sign: "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=", // derived from the doc's algorithm for ts 1599360473 + secret "demo"
      msg_type: "text",
      content: { text: expect.stringContaining("测试通知") },
    });
    expect(hit("TOKEN-W").body).toEqual({ msgtype: "text", text: { content: expect.stringContaining("测试通知") } });
    expect(hit("/sendMessage").path).toBe(`/bot${TG_TOKEN}/sendMessage`);
    expect(hit("/sendMessage").body).toEqual({ chat_id: -100777, text: expect.stringContaining("测试通知"), link_preview_options: { is_disabled: true } });
    expect(hit("TOKEN-H").body).toEqual({ event: "test", approval: null, approve_url: null });
    for (const h of hits) expect(h.headers["content-type"]).toContain("application/json");
  });

  it("reports a failing channel without blocking the others and without leaking secrets", async () => {
    await t.app.inject({
      method: "PUT",
      url: "/v1/admin/notify",
      headers: admin(),
      payload: {
        feishu: { webhook: `${base}/feishu-bad/SECRET-FEISHU-PATH-TOKEN`, secret: "wrong-secret-value" },
        wecom: { webhook: `${base}/broken/SECRET-WECOM-PATH-TOKEN` },
        webhook: { url: `${base}/hook/ok` },
        telegram: { bot_token: TG_TOKEN, chat_id: "7" },
      },
    });
    // Telegram base points at a closed port: network failure
    t.ctx.notify = { ...t.ctx.notify, telegramApiBase: "http://127.0.0.1:1" };

    const res = await t.app.inject({ method: "POST", url: "/v1/admin/notify/test", headers: admin() });
    const { results } = res.json();
    expect(results.map((r: any) => [r.channel, r.ok])).toEqual([
      ["feishu", false],
      ["wecom", false],
      ["telegram", false],
      ["webhook", true],
    ]);
    expect(results[0].error).toContain("code 19021");
    expect(results[1].error).toContain("HTTP 500");
    expect(results[2].error).toMatch(/^network error/);
    for (const secret of ["SECRET-FEISHU-PATH-TOKEN", "SECRET-WECOM-PATH-TOKEN", "wrong-secret-value", TG_TOKEN, "AAE-abcdefghijklmnopqrstuvwxyz"]) {
      expect(res.body).not.toContain(secret);
    }
    // the audit trail has ok/fail only
    const row = t.ctx.sqlite.prepare(`SELECT detail FROM audit_log WHERE action = 'notify.test'`).get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({
      results: [
        { channel: "feishu", ok: false },
        { channel: "wecom", ok: false },
        { channel: "telegram", ok: false },
        { channel: "webhook", ok: true },
      ],
    });
  });

  it("uses env-configured channels too", async () => {
    t.ctx.notify = { ...t.ctx.notify, env: { MONEYSWITCH_NOTIFY_WEBHOOK_URL: `${base}/hook/from-env` } };
    const res = await t.app.inject({ method: "POST", url: "/v1/admin/notify/test", headers: admin() });
    expect(res.json()).toEqual({ results: [{ channel: "webhook", ok: true }] });
    expect(hits.map((h) => h.path)).toEqual(["/hook/from-env"]);
  });
});
