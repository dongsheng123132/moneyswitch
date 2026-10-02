import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { createApproval, createMoneyKey, decideApproval } from "@moneyswitch/core";
import type { AppContext } from "../../src/context.js";
import { createApprovalOutbox, startNotifyLoop } from "../../src/notify/outbox.js";
import type { NotifyLogger, NotifyRuntimeOptions } from "../../src/notify/types.js";

const HOOK = "http://hook.test/ms";
const ENV = { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface Recorder {
  calls: { url: string; body: any }[];
  lines: string[];
  log: NotifyLogger;
  /** Set to make every call fail with this HTTP status (null = succeed). */
  failWith: number | null;
  delayMs: number;
  fetch: typeof fetch;
}

function recorder(): Recorder {
  const r: Recorder = {
    calls: [],
    lines: [],
    log: { info: (m) => r.lines.push(m), warn: (m) => r.lines.push(m) },
    failWith: null,
    delayMs: 0,
    fetch: (async (url: string, init: RequestInit) => {
      r.calls.push({ url, body: JSON.parse(String(init.body)) });
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      return new Response("", { status: r.failWith ?? 200 });
    }) as unknown as typeof fetch,
  };
  return r;
}

function makeCtx(sqlite: Database.Database, db: AppContext["db"], notify: NotifyRuntimeOptions, publicUrl: string | null = null): AppContext {
  return {
    db,
    sqlite,
    wallet: {} as never,
    config: { port: 0, host: "127.0.0.1", dataDir: ".", dbFilePath: ":memory:", walletPassword: null, publicUrl },
    notify,
  };
}

function memCtx(rec: Recorder, over: NotifyRuntimeOptions = {}, publicUrl: string | null = null) {
  const { db, sqlite } = openDb({ filePath: ":memory:" });
  cleanups.push(() => sqlite.close());
  return makeCtx(sqlite, db, { fetch: rec.fetch, log: rec.log, env: ENV, ...over }, publicUrl);
}

function newApproval(ctx: AppContext, url = "https://api.example.com/deep-report?api_key=TOPSECRET&x=1", amount = 150_000n) {
  const { row: key } = createMoneyKey(ctx.db, {
    name: "Codex",
    totalBudget: 10_000_000n,
    dailyBudget: 5_000_000n,
    perRequestLimit: 1_000_000n,
    approvalThreshold: 100_000n,
    allowedHosts: ["api.example.com"],
  });
  return {
    key,
    approval: createApproval(ctx.db, {
      keyId: key.id,
      url,
      method: "get",
      body: { secret_body: "BODYSECRET" },
      network: "eip155:10143",
      asset: "0xusdc",
      payTo: "0xpayto",
      amount,
    }),
  };
}

function rowOf(ctx: AppContext, id: string) {
  return ctx.sqlite.prepare(`SELECT status, notified_at, notify_attempts, notify_attempt_at FROM approvals WHERE id = ?`).get(id) as {
    status: string;
    notified_at: string | null;
    notify_attempts: number;
    notify_attempt_at: string | null;
  };
}

describe("approval notification outbox", () => {
  it("sends one message per pending approval with the right fields, then never again", async () => {
    const rec = recorder();
    const ctx = memCtx(rec, {}, "https://pay.example.com/");
    const { key, approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);

    expect(await outbox.tick()).toEqual({ attempted: 1, delivered: 1, failed: 0, gaveUp: 0 });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].url).toBe(HOOK);
    expect(rec.calls[0].body).toEqual({
      event: "approval_required",
      approval: {
        id: approval.id,
        key_name: "Codex",
        key_prefix: key.keyPrefix,
        amount: "0.15",
        currency: "USDC",
        host: "api.example.com",
        path: "/deep-report",
        method: "GET",
        expires_at: approval.expiresAt,
      },
      approve_url: "https://pay.example.com/approvals",
    });
    expect(rowOf(ctx, approval.id).notified_at).not.toBeNull();

    await outbox.tick();
    await outbox.tick();
    expect(rec.calls).toHaveLength(1);
  });

  it("never leaks the query string, headers or body of the paid request", async () => {
    const rec = recorder();
    const ctx = memCtx(rec);
    newApproval(ctx, "https://user:hunter2@api.example.com:8443/v1/pay?api_key=TOPSECRET#frag");
    await createApprovalOutbox(ctx).tick();
    const wire = JSON.stringify(rec.calls[0].body);
    for (const secret of ["TOPSECRET", "hunter2", "BODYSECRET", "api_key", "frag", "user:"]) expect(wire).not.toContain(secret);
    expect(rec.calls[0].body.approval).toMatchObject({ host: "api.example.com:8443", path: "/v1/pay" });
    expect(rec.calls[0].body.approve_url).toBeNull(); // no MONEYSWITCH_PUBLIC_URL configured
  });

  it("the chat text is zh, short, and points to the dashboard when there is no public URL", async () => {
    const rec = recorder();
    const ctx = memCtx(rec, { env: { MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: "http://wecom.test/send?key=abc" }, fetch: (async (_u: string, init: RequestInit) => {
      rec.calls.push({ url: _u, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    }) as unknown as typeof fetch });
    const { approval } = newApproval(ctx);
    await createApprovalOutbox(ctx).tick();
    const text: string = rec.calls[0].body.text.content;
    expect(text).toContain("有一笔付款等你审批");
    expect(text).toContain(approval.id);
    expect(text).toContain("请打开 MoneySwitch Dashboard 的「审批」页面");
    expect(text).toContain("去向：api.example.com/deep-report");
    expect(text).not.toContain("TOPSECRET");
  });

  it("with no channel configured nothing is sent and no attempt is consumed; configuring one later delivers it", async () => {
    const rec = recorder();
    const ctx = memCtx(rec, { env: {} });
    const { approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);
    expect(await outbox.tick()).toEqual({ attempted: 0, delivered: 0, failed: 0, gaveUp: 0 });
    expect(rowOf(ctx, approval.id)).toMatchObject({ notified_at: null, notify_attempts: 0 });

    ctx.notify = { ...ctx.notify, env: ENV };
    const outbox2 = createApprovalOutbox(ctx);
    expect((await outbox2.tick()).delivered).toBe(1);
    expect(rec.calls).toHaveLength(1);
  });

  it("restart: an approval created before the restart (never notified) is sent afterwards, and a notified one is not re-sent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-restart-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "ms.sqlite");
    const rec = recorder();

    // process 1: two approvals, only the first one gets delivered before the "crash"
    const first = openDb({ filePath: file });
    const ctx1 = makeCtx(first.sqlite, first.db, { fetch: rec.fetch, log: rec.log, env: ENV });
    const a1 = newApproval(ctx1).approval;
    await createApprovalOutbox(ctx1).tick();
    const a2 = newApproval(ctx1).approval; // created after the last tick, i.e. lost to the crash
    expect(rec.calls).toHaveLength(1);
    first.sqlite.close();

    // process 2: same database file
    const second = openDb({ filePath: file });
    cleanups.push(() => second.sqlite.close());
    const ctx2 = makeCtx(second.sqlite, second.db, { fetch: rec.fetch, log: rec.log, env: ENV });
    await createApprovalOutbox(ctx2).tick();
    await createApprovalOutbox(ctx2).tick();

    expect(rec.calls.map((c) => c.body.approval.id)).toEqual([a1.id, a2.id]);
    expect(rowOf(ctx2, a1.id).notified_at).not.toBeNull();
    expect(rowOf(ctx2, a2.id).notified_at).not.toBeNull();
  });

  it("skips expired approvals (even if still marked pending) and approvals that were already decided", async () => {
    const rec = recorder();
    const ctx = memCtx(rec);
    const expired = newApproval(ctx).approval;
    ctx.sqlite.prepare(`UPDATE approvals SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), expired.id);
    const approved = newApproval(ctx).approval;
    decideApproval(ctx.db, approved.id, "approved");
    const denied = newApproval(ctx).approval;
    decideApproval(ctx.db, denied.id, "denied");
    const live = newApproval(ctx).approval;

    await createApprovalOutbox(ctx).tick();

    expect(rec.calls.map((c) => c.body.approval.id)).toEqual([live.id]);
    expect(rowOf(ctx, expired.id)).toMatchObject({ notified_at: null, notify_attempts: 0 });
  });

  it("an approval that expires while its notification is backing off is dropped, not sent late", async () => {
    const rec = recorder();
    rec.failWith = 500;
    let nowMs = Date.now();
    const ctx = memCtx(rec, { now: () => new Date(nowMs) });
    const { approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);
    await outbox.tick();
    expect(rec.calls).toHaveLength(1);

    rec.failWith = null;
    nowMs += 11 * 60_000; // past the 10 minute approval lifetime
    await outbox.tick();
    expect(rec.calls).toHaveLength(1);
    expect(rowOf(ctx, approval.id).notified_at).toBeNull();
  });

  it("retries a failed delivery with back-off, a bounded number of times, then gives up with a warn", async () => {
    const rec = recorder();
    rec.failWith = 503;
    let nowMs = Date.now();
    const ctx = memCtx(rec, { now: () => new Date(nowMs), maxAttempts: 3 });
    const { approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);

    expect(await outbox.tick()).toMatchObject({ attempted: 1, failed: 1, gaveUp: 0 });
    // inside the back-off window: nothing happens
    nowMs += 5_000;
    expect(await outbox.tick()).toMatchObject({ attempted: 0 });
    expect(rec.calls).toHaveLength(1);

    nowMs += 11_000; // 16s after attempt 1 (back-off 15s)
    expect(await outbox.tick()).toMatchObject({ attempted: 1, failed: 1, gaveUp: 0 });
    nowMs += 20_000; // 20s < 30s back-off after attempt 2
    expect(await outbox.tick()).toMatchObject({ attempted: 0 });
    nowMs += 11_000; // 31s
    expect(await outbox.tick()).toMatchObject({ attempted: 1, failed: 0, gaveUp: 1 });
    expect(rec.calls).toHaveLength(3);
    expect(rowOf(ctx, approval.id)).toMatchObject({ notified_at: null, notify_attempts: 3 });
    expect(rec.lines.filter((l) => l.includes("giving up on approval " + approval.id))).toHaveLength(1);

    // given up: no more traffic however long we wait
    nowMs += 5 * 60_000;
    await outbox.tick();
    expect(rec.calls).toHaveLength(3);
  });

  it("a delivery that fails once and then succeeds is sent exactly once successfully", async () => {
    const rec = recorder();
    rec.failWith = 500;
    let nowMs = Date.now();
    const ctx = memCtx(rec, { now: () => new Date(nowMs) });
    const { approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);
    await outbox.tick();
    rec.failWith = null;
    nowMs += 16_000;
    expect(await outbox.tick()).toMatchObject({ delivered: 1 });
    nowMs += 10 * 60_000 - 20_000;
    await outbox.tick();
    expect(rec.calls).toHaveLength(2);
    expect(rowOf(ctx, approval.id).notified_at).not.toBeNull();
  });

  it("counts as notified when at least one channel took it; the failing channel is not retried", async () => {
    const rec = recorder();
    const ctx = memCtx(rec, {
      env: { MONEYSWITCH_NOTIFY_WEBHOOK_URL: HOOK, MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: "http://wecom.test/send?key=abc" },
      fetch: (async (url: string, init: RequestInit) => {
        rec.calls.push({ url, body: JSON.parse(String(init.body)) });
        return url.includes("wecom") ? new Response("", { status: 500 }) : new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const { approval } = newApproval(ctx);
    const outbox = createApprovalOutbox(ctx);
    expect(await outbox.tick()).toMatchObject({ delivered: 1, failed: 0 });
    await outbox.tick();
    expect(rec.calls).toHaveLength(2); // one per channel, once
    expect(rowOf(ctx, approval.id).notified_at).not.toBeNull();
    expect(rec.lines.some((l) => l.includes("WeCom delivery failed"))).toBe(true);
  });

  it("two loops over the same database never send the same approval twice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-race-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "ms.sqlite");
    const rec = recorder();
    rec.delayMs = 60; // keep the first send in flight while the other loop looks

    const a = openDb({ filePath: file });
    const b = openDb({ filePath: file });
    cleanups.push(() => a.sqlite.close(), () => b.sqlite.close());
    const ctxA = makeCtx(a.sqlite, a.db, { fetch: rec.fetch, log: rec.log, env: ENV });
    const ctxB = makeCtx(b.sqlite, b.db, { fetch: rec.fetch, log: rec.log, env: ENV });
    const ids = [newApproval(ctxA).approval.id, newApproval(ctxA).approval.id, newApproval(ctxA).approval.id];

    const [ra, rb] = await Promise.all([createApprovalOutbox(ctxA).tick(), createApprovalOutbox(ctxB).tick()]);

    expect(ra.delivered + rb.delivered).toBe(3);
    expect(rec.calls.map((c) => c.body.approval.id).sort()).toEqual([...ids].sort());
  });

  it("the same two-loops race on one connection (interleaved ticks) also sends once", async () => {
    const rec = recorder();
    rec.delayMs = 40;
    const ctx = memCtx(rec);
    newApproval(ctx);
    const [r1, r2] = await Promise.all([createApprovalOutbox(ctx).tick(), createApprovalOutbox(ctx).tick()]);
    expect(r1.delivered + r2.delivered).toBe(1);
    expect(rec.calls).toHaveLength(1);
  });

  it("the background loop picks up new approvals on its own, sends once, and stops cleanly", async () => {
    const rec = recorder();
    const ctx = memCtx(rec);
    const loop = startNotifyLoop(ctx, 20);
    cleanups.push(() => void loop.stop());
    newApproval(ctx);
    const deadline = Date.now() + 3000;
    while (rec.calls.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(rec.calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(rec.calls).toHaveLength(1);

    await loop.stop();
    newApproval(ctx);
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.calls).toHaveLength(1);
  });

  it("interval 0 disables the loop", async () => {
    const rec = recorder();
    const ctx = memCtx(rec);
    const loop = startNotifyLoop(ctx, 0);
    newApproval(ctx);
    await new Promise((r) => setTimeout(r, 80));
    expect(rec.calls).toHaveLength(0);
    await loop.stop();
  });

  it("stop() aborts a hanging send instead of waiting for the timeout, and does not burn the attempt", async () => {
    const rec = recorder();
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const ctx = memCtx(rec, { fetch: hanging, sendTimeoutMs: 60_000 });
    const { approval } = newApproval(ctx);
    const loop = startNotifyLoop(ctx, 10);
    await new Promise((r) => setTimeout(r, 80)); // let it start the send
    const t0 = Date.now();
    await loop.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rowOf(ctx, approval.id)).toMatchObject({ notified_at: null, notify_attempts: 0 });
  });

  it("no secret appears in any log line produced by a failing run", async () => {
    const rec = recorder();
    rec.fetch = (async () => {
      throw new Error("connect failed " + HOOK + " token abc");
    }) as unknown as typeof fetch;
    const ctx = memCtx(rec, { maxAttempts: 1 });
    newApproval(ctx);
    await createApprovalOutbox(ctx).tick();
    expect(rec.lines.length).toBeGreaterThan(0);
    expect(rec.lines.join("\n")).not.toContain("hook.test");
    expect(rec.lines.join("\n")).not.toContain(HOOK);
  });
});
