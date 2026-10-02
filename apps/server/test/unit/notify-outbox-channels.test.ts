import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@moneyswitch/db";
import { createApproval, createMoneyKey, decideApproval } from "@moneyswitch/core";
import type { AppContext } from "../../src/context.js";
import { createApprovalOutbox, startNotifyLoop } from "../../src/notify/outbox.js";
import type { NotifyLogger, NotifyRuntimeOptions } from "../../src/notify/types.js";

/**
 * Outbox behaviour that spans several channels or several approvals:
 * per-channel retries, channels not holding each other up, expiry checked at
 * send time, and coalescing / flood control for repeated approvals.
 */

const HOOK = "http://hook.test/ms";
const WECOM = "http://wecom.test/send?key=abc";
const TG_TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz012345";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface Call {
  url: string;
  body: any;
  at: number;
}

/** Fake network for several channels at once; every channel can be made to fail or to hang independently. */
function multiNet() {
  const t0 = Date.now();
  const calls: Call[] = [];
  const lines: string[] = [];
  const log: NotifyLogger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const state = {
    /** the next n WeCom calls answer HTTP 500 */
    wecomFailures: 0,
    wecomAlways: false,
    telegram: "ok" as "ok" | "hang",
    /** the first webhook call takes this long */
    firstWebhookDelayMs: 0,
    /** the call with this ordinal (1-based, any channel) answers HTTP 500 */
    failNth: 0,
  };
  let webhookCalls = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), at: Date.now() - t0 });
    if (state.failNth && calls.length === state.failNth) return new Response("", { status: 500 });
    if (url.includes("wecom.test")) {
      if (state.wecomAlways || state.wecomFailures > 0) {
        state.wecomFailures = Math.max(0, state.wecomFailures - 1);
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    }
    if (url.includes("api.telegram.org")) {
      if (state.telegram === "hang") {
        return new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    if (webhookCalls++ === 0 && state.firstWebhookDelayMs) await new Promise((r) => setTimeout(r, state.firstWebhookDelayMs));
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    calls,
    lines,
    log,
    state,
    fetch: fetchImpl,
    to: (frag: string) => calls.filter((c) => c.url.includes(frag)),
  };
}

function ctxWith(net: ReturnType<typeof multiNet>, env: NodeJS.ProcessEnv, over: NotifyRuntimeOptions = {}, publicUrl: string | null = null): AppContext {
  const { db, sqlite } = openDb({ filePath: ":memory:" });
  cleanups.push(() => sqlite.close());
  return {
    db,
    sqlite,
    wallet: {} as never,
    config: { port: 0, host: "127.0.0.1", dataDir: ".", dbFilePath: ":memory:", walletPassword: null, publicUrl },
    notify: { fetch: net.fetch, log: net.log, env, ...over },
  };
}

function keyFor(ctx: AppContext, name = "Codex") {
  return createMoneyKey(ctx.db, {
    name,
    totalBudget: 10_000_000n,
    dailyBudget: 5_000_000n,
    perRequestLimit: 1_000_000n,
    approvalThreshold: 100_000n,
    allowedHosts: ["api.example.com"],
  }).row;
}

/** An approval on an existing key. `ageMs` makes the creation order deterministic (older = served first). */
function approvalOn(ctx: AppContext, keyId: string, url: string, ageMs: number, body: unknown = { q: 1 }) {
  const a = createApproval(ctx.db, { keyId, url, method: "post", body, network: "eip155:10143", asset: "0xusdc", payTo: "0xpayto", amount: 150_000n });
  ctx.sqlite.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - ageMs).toISOString(), a.id);
  return a;
}

function notifiedAt(ctx: AppContext, id: string): string | null {
  return (ctx.sqlite.prepare(`SELECT notified_at FROM approvals WHERE id = ?`).get(id) as { notified_at: string | null }).notified_at;
}

describe("outbox: per-channel delivery", () => {
  const ENV2 = { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK, MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: WECOM };

  it("a channel that failed is retried on its own, with back-off, although another channel already took the approval", async () => {
    const net = multiNet();
    net.state.wecomFailures = 2;
    let nowMs = Date.now();
    const ctx = ctxWith(net, ENV2, { now: () => new Date(nowMs) });
    const a = approvalOn(ctx, keyFor(ctx).id, "https://api.example.com/x", 0);
    const outbox = createApprovalOutbox(ctx);

    await outbox.tick();
    expect(net.to("hook.test")).toHaveLength(1);
    expect(net.to("wecom.test")).toHaveLength(1);
    expect(notifiedAt(ctx, a.id)).toBeNull(); // WeCom still owes this approval

    nowMs += 5_000; // inside WeCom's back-off window: no traffic at all
    await outbox.tick();
    expect(net.calls).toHaveLength(2);

    nowMs += 11_000; // 16s after attempt 1 -> WeCom attempt 2 (fails again); the webhook is NOT sent again
    await outbox.tick();
    expect(net.to("wecom.test")).toHaveLength(2);
    expect(net.to("hook.test")).toHaveLength(1);
    expect(notifiedAt(ctx, a.id)).toBeNull();

    nowMs += 31_000; // attempt 3 succeeds
    await outbox.tick();
    expect(net.to("wecom.test")).toHaveLength(3);
    expect(net.to("hook.test")).toHaveLength(1);
    expect(notifiedAt(ctx, a.id)).not.toBeNull();

    nowMs += 5 * 60_000;
    await outbox.tick();
    expect(net.calls).toHaveLength(4); // 1 webhook + 3 WeCom, nothing after delivery
  });

  it("a channel that keeps failing gets a bounded number of attempts and one warn; the working channel is never repeated", async () => {
    const net = multiNet();
    net.state.wecomAlways = true;
    let nowMs = Date.now();
    const ctx = ctxWith(net, ENV2, { now: () => new Date(nowMs), maxAttempts: 3 });
    const a = approvalOn(ctx, keyFor(ctx).id, "https://api.example.com/x", 0);
    const outbox = createApprovalOutbox(ctx);

    for (let i = 0; i < 8; i++) {
      await outbox.tick();
      nowMs += 70_000;
    }
    expect(net.to("wecom.test")).toHaveLength(3);
    expect(net.to("hook.test")).toHaveLength(1);
    const giveUps = net.lines.filter((l) => l.includes("giving up"));
    expect(giveUps).toHaveLength(1);
    expect(giveUps[0]).toContain(a.id);
    expect(giveUps[0]).toContain("WeCom");
    // every configured channel is settled (webhook delivered, WeCom given up): the outbox is done with it
    expect(notifiedAt(ctx, a.id)).not.toBeNull();
  });
});

describe("outbox: channels do not hold each other up", () => {
  it("a black-holed Telegram does not delay the webhook for later approvals", async () => {
    const net = multiNet();
    net.state.telegram = "hang";
    const ctx = ctxWith(
      net,
      { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK, MONEYSWITCH_NOTIFY_TELEGRAM_BOT_TOKEN: TG_TOKEN, MONEYSWITCH_NOTIFY_TELEGRAM_CHAT_ID: "-100777" },
      { sendTimeoutMs: 300 }
    );
    const key = keyFor(ctx);
    const ids = [4, 3, 2, 1].map((age) => approvalOn(ctx, key.id, `https://api.example.com/p${age}`, age * 1000).id);

    await createApprovalOutbox(ctx).tick();

    const hooks = net.to("hook.test");
    expect(hooks.map((c) => c.body.approval.id)).toEqual(ids);
    // Serial delivery made each approval wait for the previous Telegram timeout (arrivals at +0, +300, +600, +900 ms).
    expect(Math.max(...hooks.map((c) => c.at))).toBeLessThan(200);
    expect(net.lines.filter((l) => l.includes("Telegram delivery failed"))).toHaveLength(4);
  });

  it("does not send an approval that expired while it waited its turn", async () => {
    const net = multiNet();
    net.state.firstWebhookDelayMs = 250;
    const ctx = ctxWith(net, { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK }, { laneConcurrency: 1 });
    const key = keyFor(ctx);
    const first = approvalOn(ctx, key.id, "https://api.example.com/first", 5000);
    const second = approvalOn(ctx, key.id, "https://api.example.com/second", 4000);
    // valid when the tick picks it up, dead by the time the first (slow) send is over
    ctx.sqlite.prepare(`UPDATE approvals SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() + 100).toISOString(), second.id);

    await createApprovalOutbox(ctx).tick();

    expect(net.calls.map((c) => c.body.approval.id)).toEqual([first.id]);
    expect(notifiedAt(ctx, second.id)).toBeNull();
  });
});

describe("outbox: coalescing and flood control", () => {
  const ENV1 = { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK };

  it("identical retries of one request (an OpenAI SDK retrying a 409) produce one push, not one per attempt", async () => {
    const net = multiNet();
    const ctx = ctxWith(net, ENV1);
    const key = keyFor(ctx);
    const other = keyFor(ctx, "Other");
    const a1 = approvalOn(ctx, key.id, "https://api.example.com/chat", 5000);
    const a2 = approvalOn(ctx, key.id, "https://api.example.com/chat", 4000);
    const a3 = approvalOn(ctx, key.id, "https://api.example.com/chat", 3000);
    const different = approvalOn(ctx, key.id, "https://api.example.com/other", 2000);
    const otherKey = approvalOn(ctx, other.id, "https://api.example.com/chat", 1000);

    const outbox = createApprovalOutbox(ctx);
    await outbox.tick();
    await outbox.tick();

    expect(net.calls.map((c) => c.body.approval.id)).toEqual([a1.id, different.id, otherKey.id]);
    expect(notifiedAt(ctx, a2.id)).toBeNull();
    expect(notifiedAt(ctx, a3.id)).toBeNull();
    expect(net.lines.some((l) => l.includes(a2.id) && l.includes("duplicate"))).toBe(true);
  });

  it("a different body (or price) is a different request and gets its own push", async () => {
    const net = multiNet();
    const ctx = ctxWith(net, ENV1);
    const key = keyFor(ctx);
    const a1 = approvalOn(ctx, key.id, "https://api.example.com/chat", 3000, { q: 1 });
    const a2 = approvalOn(ctx, key.id, "https://api.example.com/chat", 2000, { q: 2 });
    await createApprovalOutbox(ctx).tick();
    expect(net.calls.map((c) => c.body.approval.id)).toEqual([a1.id, a2.id]);
  });

  it("once the first request is decided, a new identical request is announced again", async () => {
    const net = multiNet();
    const ctx = ctxWith(net, ENV1);
    const key = keyFor(ctx);
    const a1 = approvalOn(ctx, key.id, "https://api.example.com/chat", 3000);
    const outbox = createApprovalOutbox(ctx);
    await outbox.tick();
    decideApproval(ctx.db, a1.id, "denied");
    const a2 = approvalOn(ctx, key.id, "https://api.example.com/chat", 0);
    await outbox.tick();
    expect(net.calls.map((c) => c.body.approval.id)).toEqual([a1.id, a2.id]);
  });

  it("a looping key is capped per minute: 5 pushes, one summary, the rest silent; other keys and the next minute are unaffected", async () => {
    const net = multiNet();
    let nowMs = Date.now();
    const ctx = ctxWith(net, ENV1, { now: () => new Date(nowMs) });
    const loop = keyFor(ctx, "Looper");
    const calm = keyFor(ctx, "Calm");
    const ids = Array.from({ length: 8 }, (_, i) => approvalOn(ctx, loop.id, `https://api.example.com/r${i}`, 20_000 - i * 1000, { i }).id);
    const calmApproval = approvalOn(ctx, calm.id, "https://api.example.com/calm", 100);
    const outbox = createApprovalOutbox(ctx);

    await outbox.tick();
    await outbox.tick();

    const events = net.calls.map((c) => c.body);
    expect(events.filter((e) => e.event === "approval_required" && e.approval.key_name === "Looper").map((e) => e.approval.id)).toEqual(ids.slice(0, 5));
    const digests = events.filter((e) => e.event === "approval_digest");
    expect(digests).toEqual([
      {
        event: "approval_digest",
        approval: null,
        key_name: "Looper",
        key_prefix: loop.keyPrefix,
        pending_count: 8,
        approve_url: null,
      },
    ]);
    expect(events.filter((e) => e.event === "approval_required" && e.approval.id === calmApproval.id)).toHaveLength(1);
    expect(net.calls).toHaveLength(5 + 1 + 1);

    nowMs += 61_000; // the window rolled over
    const later = approvalOn(ctx, loop.id, "https://api.example.com/later", 0);
    await outbox.tick();
    expect(net.calls.at(-1)!.body).toMatchObject({ event: "approval_required", approval: { id: later.id } });
    expect(net.calls).toHaveLength(8);
  });

  it("the summary reaches chat channels as readable zh text without any request details", async () => {
    const net = multiNet();
    const ctx = ctxWith(net, { MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: WECOM }, {}, "https://pay.example.com");
    const key = keyFor(ctx, "Looper");
    for (let i = 0; i < 6; i++) approvalOn(ctx, key.id, `https://api.example.com/r${i}?token=SECRETQ`, 20_000 - i * 1000, { i });
    await createApprovalOutbox(ctx).tick();
    const texts: string[] = net.calls.map((c) => c.body.text.content);
    expect(texts).toHaveLength(6);
    const digest = texts[5];
    expect(digest).toContain("Looper");
    expect(digest).toContain("6 笔");
    expect(digest).toContain("https://pay.example.com/approvals");
    expect(digest).not.toContain("SECRETQ");
    expect(digest).not.toContain("api.example.com");
  });

  it("a summary that fails to send is retried as a summary, and the flood gets nothing extra, even after the window rolls", async () => {
    const net = multiNet();
    net.state.failNth = 6; // the summary: 5 approval pushes come first
    let nowMs = Date.now();
    const ctx = ctxWith(net, { MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: WECOM }, { now: () => new Date(nowMs) });
    const key = keyFor(ctx, "Looper");
    for (let i = 0; i < 9; i++) approvalOn(ctx, key.id, `https://api.example.com/r${i}`, 20_000 - i * 1000, { i });
    const outbox = createApprovalOutbox(ctx);
    const isSummary = (c: Call) => String(c.body.text.content).includes("同一个 Key");

    await outbox.tick();
    expect(net.calls).toHaveLength(6);
    expect(net.calls.filter(isSummary)).toHaveLength(1); // ...which failed

    nowMs += 20_000; // past the first back-off
    await outbox.tick();
    expect(net.calls.filter(isSummary)).toHaveLength(2); // retried as a summary, not turned into an approval push
    expect(net.calls).toHaveLength(7);

    nowMs += 60_000; // the window rolled, but the other 3 approvals were already decided: silent for good
    await outbox.tick();
    expect(net.calls).toHaveLength(7);
  });
});

describe("outbox: interval driver and several loops", () => {
  it("while Telegram is stuck, the webhook still gets approvals that arrive later (lanes tick independently)", async () => {
    const net = multiNet();
    net.state.telegram = "hang";
    const ctx = ctxWith(
      net,
      { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK, MONEYSWITCH_NOTIFY_TELEGRAM_BOT_TOKEN: TG_TOKEN, MONEYSWITCH_NOTIFY_TELEGRAM_CHAT_ID: "-100777" },
      { sendTimeoutMs: 600 }
    );
    const key = keyFor(ctx);
    const loop = startNotifyLoop(ctx, 15);
    cleanups.push(() => void loop.stop());
    const first = approvalOn(ctx, key.id, "https://api.example.com/one", 0);
    await waitUntil(() => net.to("hook.test").length >= 1);
    await new Promise((r) => setTimeout(r, 100)); // Telegram's lane is still stuck on `first`
    const tSecond = Date.now();
    const second = approvalOn(ctx, key.id, "https://api.example.com/two", 0);
    await waitUntil(() => net.to("hook.test").length >= 2);
    // A single serial tick would only have looked at `second` after Telegram's 600 ms timeout.
    expect(Date.now() - tSecond).toBeLessThan(300);
    expect(net.to("hook.test").map((c) => c.body.approval.id)).toEqual([first.id, second.id]);
    await loop.stop();
  });

  it("two loops over one database announce a repeated request once, not once per loop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-twins-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "ms.sqlite");
    const net = multiNet();
    const a = openDb({ filePath: file });
    const b = openDb({ filePath: file });
    cleanups.push(() => a.sqlite.close(), () => b.sqlite.close());
    const mk = (conn: typeof a): AppContext => ({
      db: conn.db,
      sqlite: conn.sqlite,
      wallet: {} as never,
      config: { port: 0, host: "127.0.0.1", dataDir: ".", dbFilePath: file, walletPassword: null },
      notify: { fetch: net.fetch, log: net.log, env: { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK } },
    });
    const ctxA = mk(a);
    const ctxB = mk(b);
    const key = keyFor(ctxA);
    const first = approvalOn(ctxA, key.id, "https://api.example.com/chat", 3000);
    approvalOn(ctxA, key.id, "https://api.example.com/chat", 2000);
    approvalOn(ctxA, key.id, "https://api.example.com/chat", 1000);

    await Promise.all([createApprovalOutbox(ctxA).tick(), createApprovalOutbox(ctxB).tick()]);

    expect(net.calls.map((c) => c.body.approval.id)).toEqual([first.id]);
  });
});

async function waitUntil(cond: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("condition not met in time");
}
