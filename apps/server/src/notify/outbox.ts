import { formatMicrosToUsdc } from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { CHANNEL_LABEL } from "./channels.js";
import { dispatchEvent } from "./dispatcher.js";
import { splitHostPath } from "./message.js";
import { DEFAULT_LANE_CONCURRENCY, resolveRuntime } from "./runtime.js";
import { hasAnyChannel, resolveSettings, toNotifyConfig } from "./settings.js";
import { NOTIFY_CHANNELS, type NotifyChannelId, type NotifyConfig, type NotifyEvent } from "./types.js";

/**
 * Approval notification outbox.
 *
 * The payment path only ever INSERTs a `pending` approval (packages/core
 * createApproval) and knows nothing about notifications. This loop, which runs
 * beside the HTTP server, finds approvals that are still pending, unexpired and
 * not yet announced, and delivers each one to every configured channel.
 *
 * State is kept per (approval, channel) in `approval_notify_deliveries`:
 * attempts + back-off, delivery time, or the reason nothing is sent. Each
 * configured channel is a "lane" with its own schedule, so
 *  - a channel that failed is retried on its own (bounded, with back-off) even
 *    though another channel already took the approval, and a channel that
 *    already took it is never sent the same approval again;
 *  - a slow or black-holed channel only delays itself: lanes run in parallel
 *    and, inside a lane, sends run with bounded concurrency.
 *
 * Guarantees:
 *  - never on the request path: nothing here is awaited by /v1/fetch or the gateway;
 *  - survives restarts: the state is in the database;
 *  - at most one message per approval and channel, even with several loops on
 *    the same database: an attempt is claimed with a compare-and-swap on
 *    `attempts` right before it is sent, and the claim also requires the
 *    approval to be still pending and unexpired at that moment. The one
 *    unavoidable gap is a crash between a successful send and the delivery
 *    stamp; the retry lease then re-sends once;
 *  - a failed send is retried with back-off up to `maxAttempts` times, then
 *    given up with a warn log;
 *  - no flood: a repeat of a request that is still pending and already
 *    announced (same key, URL, method, body, payee and price) is not announced
 *    again, and one key gets at most PER_KEY_PUSHES_PER_WINDOW pushes per
 *    window and channel, followed by a single summary message;
 *  - `approvals.notified_at` is stamped once every configured channel is settled
 *    (delivered, skipped or given up) and at least one delivered;
 *  - idle cost: one tiny SELECT per tick.
 */

interface Candidate {
  id: string;
  key_id: string;
  url: string;
  method: string;
  body_sha256: string;
  pay_to: string;
  amount: number;
  created_at: string;
  expires_at: string;
  key_name: string | null;
  key_prefix: string | null;
  /** null = the outbox has not looked at this approval on this channel yet */
  d_kind: string | null;
  d_attempts: number | null;
  d_attempt_at: string | null;
}

type Kind = "approval" | "digest";

interface Job {
  row: Candidate;
  kind: Kind;
  attempts: number;
}

interface DeliveryRow {
  channel: string;
  attempts: number;
  delivered_at: string | null;
  skipped: string | null;
}

export interface TickResult {
  /** Sends this tick tried (one per approval and channel). */
  attempted: number;
  /** Sends that were accepted by their channel. */
  delivered: number;
  /** Sends that failed and will be retried. */
  failed: number;
  /** Sends that failed for the last allowed time. */
  gaveUp: number;
}

export const DEFAULT_NOTIFY_INTERVAL_MS = 2_500;
/** One key gets at most this many approval pushes per window and channel; then one summary, then silence until the window rolls. */
export const PER_KEY_PUSHES_PER_WINDOW = 5;
export const PUSH_WINDOW_MS = 60_000;
const BATCH_SIZE = 50;

const emptyResult = (): TickResult => ({ attempted: 0, delivered: 0, failed: 0, gaveUp: 0 });

function addResult(into: TickResult, from: TickResult): TickResult {
  into.attempted += from.attempted;
  into.delivered += from.delivered;
  into.failed += from.failed;
  into.gaveUp += from.gaveUp;
  return into;
}

function approveUrlOf(ctx: AppContext): string | null {
  const base = ctx.config.publicUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/approvals` : null;
}

export function createApprovalOutbox(ctx: AppContext) {
  const runtime = resolveRuntime(ctx.notify);
  const abort = new AbortController();
  const laneConcurrency = Math.max(1, Math.floor(ctx.notify?.laneConcurrency ?? DEFAULT_LANE_CONCURRENCY));
  let stopped = false;
  /** Every lane run in flight (guarded or not); stop() waits for them. */
  const running = new Set<Promise<unknown>>();
  /** Lanes the interval driver is currently running, so it never starts a second run of the same lane. */
  const busy = new Set<NotifyChannelId>();

  const hasOpenWork = ctx.sqlite.prepare(
    `SELECT 1 AS x FROM approvals WHERE status = 'pending' AND notified_at IS NULL AND expires_at > ? LIMIT 1`
  );
  const selectCandidates = ctx.sqlite.prepare(
    `SELECT a.id AS id, a.key_id AS key_id, a.url AS url, a.method AS method, a.body_sha256 AS body_sha256,
            a.pay_to AS pay_to, a.amount AS amount, a.created_at AS created_at, a.expires_at AS expires_at,
            k.name AS key_name, k.key_prefix AS key_prefix,
            d.kind AS d_kind, d.attempts AS d_attempts, d.attempt_at AS d_attempt_at
       FROM approvals a
       LEFT JOIN money_keys k ON k.id = a.key_id
       LEFT JOIN approval_notify_deliveries d ON d.approval_id = a.id AND d.channel = ?
      WHERE a.status = 'pending' AND a.notified_at IS NULL AND a.expires_at > ?
        AND (d.approval_id IS NULL OR (d.delivered_at IS NULL AND d.skipped IS NULL AND d.attempts < ?))
      ORDER BY (d.approval_id IS NOT NULL), a.created_at ASC, a.id ASC
      LIMIT ${BATCH_SIZE}`
  );
  const findEarlierTwin = ctx.sqlite.prepare(
    `SELECT 1 AS x
       FROM approvals s JOIN approval_notify_deliveries sd ON sd.approval_id = s.id AND sd.channel = ?
      WHERE s.id <> ? AND s.key_id = ? AND s.url = ? AND s.method = ? AND s.body_sha256 = ? AND s.pay_to = ? AND s.amount = ?
        AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))
        AND s.status = 'pending' AND s.expires_at > ?
        AND sd.skipped IS NULL AND (sd.delivered_at IS NOT NULL OR sd.attempts < ?)
      LIMIT 1`
  );
  const countRecent = ctx.sqlite.prepare(
    `SELECT count(*) AS n
       FROM approval_notify_deliveries d JOIN approvals a ON a.id = d.approval_id
      WHERE d.channel = ? AND a.key_id = ? AND d.kind = ? AND d.skipped IS NULL AND d.created_at > ?`
  );
  const insertDelivery = ctx.sqlite.prepare(
    `INSERT OR IGNORE INTO approval_notify_deliveries (approval_id, channel, kind, attempts, skipped, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  );
  const claimAttempt = ctx.sqlite.prepare(
    `UPDATE approval_notify_deliveries SET attempts = attempts + 1, attempt_at = ?
      WHERE approval_id = ? AND channel = ? AND attempts = ? AND delivered_at IS NULL AND skipped IS NULL
        AND EXISTS (SELECT 1 FROM approvals a WHERE a.id = ? AND a.status = 'pending' AND a.notified_at IS NULL AND a.expires_at > ?)`
  );
  const releaseAttempt = ctx.sqlite.prepare(
    `UPDATE approval_notify_deliveries SET attempts = attempts - 1
      WHERE approval_id = ? AND channel = ? AND delivered_at IS NULL AND attempts > 0`
  );
  const markDelivered = ctx.sqlite.prepare(
    `UPDATE approval_notify_deliveries SET delivered_at = ? WHERE approval_id = ? AND channel = ? AND delivered_at IS NULL`
  );
  const selectDeliveries = ctx.sqlite.prepare(
    `SELECT channel, attempts, delivered_at, skipped FROM approval_notify_deliveries WHERE approval_id = ?`
  );
  const markNotified = ctx.sqlite.prepare(`UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL`);
  const countPending = ctx.sqlite.prepare(
    `SELECT count(*) AS n FROM approvals WHERE key_id = ? AND status = 'pending' AND expires_at > ?`
  );

  function isDue(row: Candidate, nowMs: number): boolean {
    const attempts = row.d_attempts ?? 0;
    if (attempts === 0 || !row.d_attempt_at) return true;
    return nowMs >= new Date(row.d_attempt_at).getTime() + runtime.backoffMs(attempts);
  }

  /**
   * What to do with an approval this channel has not looked at yet. Decided
   * once and stored, so later ticks (and other loops) never reverse it:
   *  - a still-pending, still-announced earlier twin (same key, URL, method,
   *    body, payee, price) means this one is a repeat -> skip, "duplicate";
   *  - else the key's push budget for the window decides: approval push,
   *    then one summary (kind "digest"), then skip, "rate_limited".
   * Returns null when another loop decided first.
   */
  const decide = ctx.sqlite.transaction(
    (row: Candidate, channel: NotifyChannelId, nowIso: string, windowStartIso: string): { kind: Kind; skipped: string | null } | null => {
      let kind: Kind = "approval";
      let skipped: string | null = null;
      const twin = findEarlierTwin.get(
        channel, row.id, row.key_id, row.url, row.method, row.body_sha256, row.pay_to, row.amount,
        row.created_at, row.created_at, row.id, nowIso, runtime.maxAttempts
      );
      if (twin) {
        skipped = "duplicate";
      } else if ((countRecent.get(channel, row.key_id, "approval", windowStartIso) as { n: number }).n >= PER_KEY_PUSHES_PER_WINDOW) {
        if ((countRecent.get(channel, row.key_id, "digest", windowStartIso) as { n: number }).n === 0) kind = "digest";
        else skipped = "rate_limited";
      }
      return insertDelivery.run(row.id, channel, kind, skipped, nowIso).changes === 1 ? { kind, skipped } : null;
    }
  );

  function toEvent(row: Candidate, kind: Kind, nowIso: string): NotifyEvent {
    const keyName = row.key_name ?? row.key_id.slice(0, 8);
    const keyPrefix = row.key_prefix ?? "";
    if (kind === "digest") {
      const pending = (countPending.get(row.key_id, nowIso) as { n: number }).n;
      return { type: "approval_digest", keyName, keyPrefix, pending: Math.max(1, pending), approveUrl: approveUrlOf(ctx) };
    }
    const { host, path } = splitHostPath(row.url);
    return {
      type: "approval_required",
      approval: {
        id: row.id,
        keyName,
        keyPrefix,
        amount: formatMicrosToUsdc(BigInt(row.amount)),
        currency: "USDC",
        host,
        path: path.slice(0, 200),
        method: row.method.toUpperCase(),
        expiresAt: row.expires_at,
      },
      approveUrl: approveUrlOf(ctx),
    };
  }

  function configuredChannels(config: NotifyConfig): NotifyChannelId[] {
    return NOTIFY_CHANNELS.filter((c) => config[c]);
  }

  /** Stamps notified_at once every configured channel is settled (delivered / skipped / given up) and at least one delivered. */
  function settle(approvalId: string, config: NotifyConfig): void {
    const rows = selectDeliveries.all(approvalId) as DeliveryRow[];
    for (const channel of configuredChannels(config)) {
      const d = rows.find((r) => r.channel === channel);
      if (!d) return; // this channel has not looked at it yet
      if (!d.delivered_at && !d.skipped && d.attempts < runtime.maxAttempts) return; // still owed
    }
    if (rows.some((r) => r.delivered_at)) markNotified.run(runtime.now().toISOString(), approvalId);
  }

  async function sendJob(job: Job, channel: NotifyChannelId, config: NotifyConfig, result: TickResult): Promise<void> {
    if (stopped) return;
    const { row } = job;
    const label = CHANNEL_LABEL[channel];
    const claimedAt = runtime.now().toISOString();
    // Only the loop whose compare-and-swap lands may send this attempt, and only while the approval is still live.
    if (claimAttempt.run(claimedAt, row.id, channel, job.attempts, row.id, claimedAt).changes !== 1) return;
    result.attempted++;

    const [outcome] = await dispatchEvent(toEvent(row, job.kind, claimedAt), config, runtime.deps(abort.signal), runtime.log, [channel]);
    if (!outcome || outcome.ok) {
      markDelivered.run(runtime.now().toISOString(), row.id, channel);
      result.delivered++;
      runtime.log.info(
        `[moneyswitch] notify: ${job.kind === "digest" ? `summary for key ${row.key_prefix ?? row.key_id.slice(0, 8)} (approval ${row.id})` : `approval ${row.id}`} delivered via ${label}`
      );
      settle(row.id, config);
      return;
    }
    if (stopped) {
      // Shutting down mid-send: this attempt did not really happen.
      releaseAttempt.run(row.id, channel);
      return;
    }
    const made = job.attempts + 1;
    if (made >= runtime.maxAttempts) {
      result.gaveUp++;
      runtime.log.warn(`[moneyswitch] notify: giving up on approval ${row.id} (${label}) after ${made} failed delivery attempts`);
      settle(row.id, config);
    } else {
      result.failed++;
      runtime.log.warn(`[moneyswitch] notify: approval ${row.id} ${label} delivery attempt ${made}/${runtime.maxAttempts} failed, will retry`);
    }
  }

  /** One pass over one channel: decide what is new, then send what is due, a few at a time. */
  async function runLane(channel: NotifyChannelId, config: NotifyConfig): Promise<TickResult> {
    const result = emptyResult();
    const now = runtime.now();
    const nowIso = now.toISOString();
    const windowStartIso = new Date(now.getTime() - PUSH_WINDOW_MS).toISOString();
    const rows = selectCandidates.all(channel, nowIso, runtime.maxAttempts) as Candidate[];

    const jobs: Job[] = [];
    for (const row of rows) {
      if (stopped) break;
      if (row.d_kind === null) {
        const decision = decide.immediate(row, channel, nowIso, windowStartIso);
        if (!decision) continue; // another loop decided it
        if (decision.skipped) {
          runtime.log.info(
            decision.skipped === "duplicate"
              ? `[moneyswitch] notify: approval ${row.id} not announced on ${CHANNEL_LABEL[channel]}: duplicate of a pending approval that was already announced`
              : `[moneyswitch] notify: approval ${row.id} not announced on ${CHANNEL_LABEL[channel]}: key ${row.key_prefix ?? row.key_id.slice(0, 8)} is over its push limit (see the summary message)`
          );
          settle(row.id, config);
          continue;
        }
        jobs.push({ row, kind: decision.kind, attempts: 0 });
      } else if (isDue(row, now.getTime())) {
        jobs.push({ row, kind: row.d_kind === "digest" ? "digest" : "approval", attempts: row.d_attempts ?? 0 });
      }
    }

    let next = 0;
    const worker = async () => {
      while (!stopped) {
        const job = jobs[next++];
        if (!job) return;
        try {
          await sendJob(job, channel, config, result);
        } catch (e) {
          if (!stopped) runtime.log.warn(`[moneyswitch] notify: ${CHANNEL_LABEL[channel]} lane error: ${e instanceof Error ? e.message : "error"}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(laneConcurrency, jobs.length) }, worker));
    return result;
  }

  /** Starts a run of every configured channel's lane (skipping lanes still busy when `guarded`). */
  function startLanes(guarded: boolean): Promise<TickResult>[] {
    const config = toNotifyConfig(resolveSettings(ctx.sqlite, runtime.env).values);
    if (!hasAnyChannel(config)) return [];
    if (!hasOpenWork.get(runtime.now().toISOString())) return [];
    const started: Promise<TickResult>[] = [];
    for (const channel of configuredChannels(config)) {
      if (guarded && busy.has(channel)) continue;
      if (guarded) busy.add(channel);
      const p = runLane(channel, config);
      const tracked = p
        .catch((e): TickResult => {
          if (guarded && !stopped) runtime.log.warn(`[moneyswitch] notify: outbox tick failed: ${e instanceof Error ? e.message : "error"}`);
          if (!guarded) throw e;
          return emptyResult();
        })
        .finally(() => {
          busy.delete(channel);
          running.delete(tracked);
        });
      running.add(tracked);
      started.push(tracked);
    }
    return started;
  }

  return {
    /** Runs every lane once and resolves when all of them are done (tests, and manual triggering). */
    async tick(): Promise<TickResult> {
      const total = emptyResult();
      for (const r of await Promise.all(startLanes(false))) addResult(total, r);
      return total;
    },
    /** Interval driver: starts the lanes that are not still running from the previous tick; null when it started none. */
    tickGuarded(): Promise<TickResult | null> {
      if (stopped) return Promise.resolve(null);
      let started: Promise<TickResult>[];
      try {
        started = startLanes(true);
      } catch (e) {
        runtime.log.warn(`[moneyswitch] notify: outbox tick failed: ${e instanceof Error ? e.message : "error"}`);
        return Promise.resolve(null);
      }
      if (started.length === 0) return Promise.resolve(null);
      return Promise.all(started).then((all) => all.reduce((sum, r) => addResult(sum, r), emptyResult()));
    },
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      await Promise.allSettled([...running]);
    },
  };
}

/**
 * Starts the background loop (every `intervalMs`, default 2.5s; 0 disables).
 * The timer is unref'd so it never keeps the process alive. `stop()` aborts
 * in-flight sends and resolves once the running lanes have finished, so the
 * caller can close the SQLite handle right after.
 */
export function startNotifyLoop(
  ctx: AppContext,
  intervalMs: number = DEFAULT_NOTIFY_INTERVAL_MS
): { stop: () => Promise<void>; tick: () => Promise<TickResult> } {
  const outbox = createApprovalOutbox(ctx);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop: () => outbox.stop(), tick: outbox.tick };
  }
  const timer = setInterval(() => {
    void outbox.tickGuarded();
  }, intervalMs);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await outbox.stop();
    },
    tick: outbox.tick,
  };
}
