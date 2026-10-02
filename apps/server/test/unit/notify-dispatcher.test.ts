import { describe, it, expect } from "vitest";
import { dispatchEvent, scrubSecrets } from "../../src/notify/dispatcher.js";
import { resolveRuntime } from "../../src/notify/runtime.js";
import type { NotifyConfig, NotifyEvent, NotifyLogger } from "../../src/notify/types.js";

const FEISHU_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/FEISHU-TOKEN-0123456789";
const FEISHU_SECRET = "feishu-signing-secret-xyz";
const WECOM_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=WECOM-KEY-0123456789";
const TG_TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz012345";
const HOOK_URL = "https://hooks.example.com/services/HOOK-TOKEN-0123456789";

const ALL: NotifyConfig = {
  feishu: { webhook: FEISHU_URL, secret: FEISHU_SECRET },
  wecom: { webhook: WECOM_URL },
  telegram: { botToken: TG_TOKEN, chatId: "-100777" },
  webhook: { url: HOOK_URL },
};
const SECRETS = [FEISHU_URL, FEISHU_SECRET, WECOM_URL, TG_TOKEN, HOOK_URL, "FEISHU-TOKEN-0123456789", "WECOM-KEY-0123456789", "HOOK-TOKEN-0123456789"];

const EVENT: NotifyEvent = {
  type: "approval_required",
  approval: {
    id: "a1",
    keyName: "Codex",
    keyPrefix: "mk_live_ab12",
    amount: "0.15",
    currency: "USDC",
    host: "api.example.com",
    path: "/deep-report",
    method: "GET",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  approveUrl: null,
};

function capture() {
  const lines: string[] = [];
  const log: NotifyLogger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  return { lines, log };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function depsWith(fetchImpl: typeof fetch, extra: { timeoutMs?: number; telegramApiBase?: string } = {}) {
  const rt = resolveRuntime({ fetch: fetchImpl, sendTimeoutMs: extra.timeoutMs ?? 2000, telegramApiBase: "https://tg.test" });
  return rt.deps();
}

describe("dispatchEvent", () => {
  it("posts the right payload to every configured channel and reports ok per channel", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes("feishu")) return json(200, { code: 0, msg: "success" });
      if (url.includes("weixin")) return json(200, { errcode: 0, errmsg: "ok" });
      if (url.includes("tg.test")) return json(200, { ok: true, result: {} });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { log } = capture();

    const results = await dispatchEvent(EVENT, ALL, depsWith(fetchImpl), log);

    expect(results).toEqual([
      { channel: "feishu", ok: true },
      { channel: "wecom", ok: true },
      { channel: "telegram", ok: true },
      { channel: "webhook", ok: true },
    ]);
    const byHost = (frag: string) => calls.find((c) => c.url.includes(frag))!;
    expect(byHost("feishu").body).toMatchObject({ msg_type: "text", sign: expect.any(String), timestamp: expect.stringMatching(/^\d{10}$/) });
    expect(byHost("feishu").body.content.text).toContain("金额：0.15 USDC");
    expect(byHost("weixin").body).toMatchObject({ msgtype: "text" });
    expect(byHost("weixin").body.text.content).toContain("Key：Codex");
    expect(byHost("tg.test").url).toBe(`https://tg.test/bot${TG_TOKEN}/sendMessage`);
    expect(byHost("tg.test").body).toMatchObject({ chat_id: -100777 });
    expect(byHost("hooks.example.com").body).toMatchObject({ event: "approval_required", approval: { id: "a1", amount: "0.15" } });
  });

  it("one failing channel does not block the others", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("feishu")) return json(200, { code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" });
      if (url.includes("weixin")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (url.includes("tg.test")) return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const { log } = capture();

    const results = await dispatchEvent(EVENT, ALL, depsWith(fetchImpl), log);

    expect(results.map((r) => [r.channel, r.ok])).toEqual([
      ["feishu", false],
      ["wecom", false],
      ["telegram", false],
      ["webhook", true],
    ]);
    expect(results[0].error).toContain("code 19021");
    expect(results[1].error).toBe("network error (ECONNREFUSED)");
    expect(results[2].error).toContain("error_code 401");
    expect(results[2].error).toContain("Unauthorized");
  });

  it("a channel that hangs times out on its own without delaying the rest past the timeout", async () => {
    const fetchImpl = ((url: string, init: RequestInit) => {
      if (url.includes("feishu")) {
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;
    const { log } = capture();
    const t0 = Date.now();
    const results = await dispatchEvent(EVENT, { ...ALL, wecom: null, telegram: null }, depsWith(fetchImpl, { timeoutMs: 150 }), log);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(results).toEqual([
      { channel: "feishu", ok: false, error: "timeout" },
      { channel: "webhook", ok: true },
    ]);
  });

  it("a fetch that throws (even with the URL in its message) still yields a result, never a rejection", async () => {
    const fetchImpl = (() => {
      throw new Error("boom " + HOOK_URL);
    }) as unknown as typeof fetch;
    const { log } = capture();
    const results = await dispatchEvent(EVENT, { feishu: null, wecom: null, telegram: null, webhook: { url: HOOK_URL } }, depsWith(fetchImpl), log);
    expect(results).toEqual([{ channel: "webhook", ok: false, error: "network error" }]);
  });

  it("returns an empty list when nothing is configured", async () => {
    const { log } = capture();
    expect(await dispatchEvent(EVENT, { feishu: null, wecom: null, telegram: null, webhook: null }, depsWith(fetch), log)).toEqual([]);
  });

  it("redirects are not followed and count as failure", async () => {
    let seenRedirectMode: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenRedirectMode = init.redirect;
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as unknown as typeof fetch;
    const { log } = capture();
    const results = await dispatchEvent(EVENT, { feishu: null, wecom: null, telegram: null, webhook: { url: HOOK_URL } }, depsWith(fetchImpl), log);
    expect(seenRedirectMode).toBe("manual");
    expect(results).toEqual([{ channel: "webhook", ok: false, error: "webhook answered HTTP 302" }]);
  });
});

describe("no secret ever reaches a log line or an error result", () => {
  it("even when the transport error and the remote reply echo the URLs, tokens and signing secret", async () => {
    const fetchImpl = (async (url: string) => {
      // Hostile / sloppy upstreams: errors and bodies that repeat what we sent.
      if (url.includes("feishu")) return json(200, { code: 19021, msg: `bad sign for ${FEISHU_URL} secret ${FEISHU_SECRET}` });
      if (url.includes("weixin")) return json(200, { errcode: 93000, errmsg: `invalid webhook url ${WECOM_URL}` });
      if (url.includes("tg.test")) return json(404, { ok: false, error_code: 404, description: `Not Found: bot${TG_TOKEN}/sendMessage` });
      throw new Error(`connect ECONNREFUSED ${HOOK_URL} (token HOOK-TOKEN-0123456789)`);
    }) as unknown as typeof fetch;
    const { lines, log } = capture();

    const results = await dispatchEvent(EVENT, ALL, depsWith(fetchImpl), log);

    expect(results.every((r) => !r.ok)).toBe(true);
    const everything = JSON.stringify(results) + "\n" + lines.join("\n");
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    // the failures were logged (and are useful) even though scrubbed
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toContain("Feishu delivery failed");
    expect(lines.join("\n")).toContain("code 19021");
  });

  it("scrubSecrets removes known secrets, URLs and bot tokens, and bounds length", () => {
    const out = scrubSecrets(`x ${FEISHU_SECRET} y https://evil.example/a?b=c z bot${TG_TOKEN} ${"q".repeat(500)}`, [FEISHU_SECRET]);
    expect(out).not.toContain(FEISHU_SECRET);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain(TG_TOKEN);
    expect(out.length).toBeLessThanOrEqual(240);
  });
});
