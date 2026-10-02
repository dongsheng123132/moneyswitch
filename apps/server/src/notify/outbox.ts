import { formatMicrosToUsdc } from "@moneyswitch/core";
import type { AppContext } from "../context.js";
import { dispatchEvent } from "./dispatcher.js";
import { splitHostPath } from "./message.js";
import { resolveRuntime } from "./runtime.js";
import { hasAnyChannel, resolveSettings, toNotifyConfig } from "./settings.js";
import type { NotifyEvent } from "./types.js";

/**
 * Approval notification outbox.
 *
 * The payment path only ever INSERTs a `pending` approval (packages/core
 * createApproval) and knows nothing about notifications. This loop, which runs
 * beside the HTTP server, finds approvals that are still pending, unexpired
 * and have `notified_at IS NULL`, sends one message each and stamps
 * `notified_at`.
 *
 * Guarantees:
 *  - never on the request path: nothing here is awaited by /v1/fetch or the gateway;
 *  - survives restarts: the state is the approvals table itself;
 *  - at most one message per approval, even with several loops on the same
 *    database: an attempt is claimed with a compare-and-swap on
 *    `notify_attempts` before anything is sent, and `notified_at` is stamped
 *    on success. The one unavoidable gap is a crash between a successful send
 *    and that stamp; the retry lease then re-sends once;
 *  - a failed delivery (every configured channel failed) is retried with
 *    back-off up to `maxAttempts` times, then dropped with a warn log;
 *  - an approval counts as notified once at least one channel took it. The
 *    other channels' failures are logged, not retried, so a working channel is
 *    never spammed twice because another one is down;
 *  - idle cost with no channel configured: one tiny SELECT per tick.
 */

interface Candidate {
  id: string;
  key_id: string;
  url: string;
  method: string;
  amount: number;
  expires_at: string;
  attempts: number;
  attempt_at: string | null;
  key_name: string | null;
  key_prefix: string | null;
}

export interface TickResult {
  /** Approvals this tick tried to deliver. */
  attempted: number;
  /** Delivered to at least one channel. */
  delivered: number;
  /** Every configured channel failed (will be retried unless it was the last attempt). */
  failed: number;
  /** Failed for the last allowed time. */
  gaveUp: number;
}

export const DEFAULT_NOTIFY_INTERVAL_MS = 2_500;
const BATCH_SIZE = 50;

function approveUrlOf(ctx: AppContext): string | null {
  const base = ctx.config.publicUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/approvals` : null;
}

export function createApprovalOutbox(ctx: AppContext) {
  const runtime = resolveRuntime(ctx.notify);
  const abort = new AbortController();
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const selectCandidates = ctx.sqlite.prepare(
    `SELECT a.id AS id, a.key_id AS key_id, a.url AS url, a.method AS method, a.amount AS amount,
            a.expires_at AS expires_at, a.notify_attempts AS attempts, a.notify_attempt_at AS attempt_at,
            k.name AS key_name, k.key_prefix AS key_prefix
       FROM approvals a LEFT JOIN money_keys k ON k.id = a.key_id
      WHERE a.status = 'pending' AND a.notified_at IS NULL AND a.expires_at > ? AND a.notify_attempts < ?
      ORDER BY a.created_at ASC
      LIMIT ${BATCH_SIZE}`
  );
  const claimAttempt = ctx.sqlite.prepare(
    `UPDATE approvals SET notify_attempts = notify_attempts + 1, notify_attempt_at = ?
      WHERE id = ? AND status = 'pending' AND notified_at IS NULL AND notify_attempts = ?`
  );
  const markNotified = ctx.sqlite.prepare(`UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL`);
  const releaseAttempt = ctx.sqlite.prepare(
    `UPDATE approvals SET notify_attempts = notify_attempts - 1 WHERE id = ? AND notified_at IS NULL AND notify_attempts > 0`
  );

  function isDue(row: Candidate, nowMs: number): boolean {
    if (row.attempts === 0 || !row.attempt_at) return true;
    return nowMs >= new Date(row.attempt_at).getTime() + runtime.backoffMs(row.attempts);
  }

  function toEvent(row: Candidate): NotifyEvent {
    const { host, path } = splitHostPath(row.url);
    return {
      type: "approval_required",
      approval: {
        id: row.id,
        keyName: row.key_name ?? row.key_id.slice(0, 8),
        keyPrefix: row.key_prefix ?? "",
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

  async function tick(): Promise<TickResult> {
    const result: TickResult = { attempted: 0, delivered: 0, failed: 0, gaveUp: 0 };
    const config = toNotifyConfig(resolveSettings(ctx.sqlite, runtime.env).values);
    if (!hasAnyChannel(config)) return result;

    const now = runtime.now();
    const rows = selectCandidates.all(now.toISOString(), runtime.maxAttempts) as Candidate[];
    for (const row of rows) {
      if (stopped) break;
      if (!isDue(row, now.getTime())) continue;
      // Claim: only the loop whose compare-and-swap lands may send this attempt.
      if (claimAttempt.run(runtime.now().toISOString(), row.id, row.attempts).changes !== 1) continue;
      result.attempted++;

      const results = await dispatchEvent(toEvent(row), config, runtime.deps(abort.signal), runtime.log);
      if (results.some((r) => r.ok)) {
        markNotified.run(runtime.now().toISOString(), row.id);
        result.delivered++;
        runtime.log.info(
          `[moneyswitch] notify: approval ${row.id} delivered via ${results.filter((r) => r.ok).map((r) => r.channel).join(", ")}`
        );
        continue;
      }
      if (stopped) {
        // Shutting down mid-send: this attempt did not really happen.
        releaseAttempt.run(row.id);
        break;
      }
      const made = row.attempts + 1;
      if (made >= runtime.maxAttempts) {
        result.gaveUp++;
        runtime.log.warn(`[moneyswitch] notify: giving up on approval ${row.id} after ${made} failed delivery attempts`);
      } else {
        result.failed++;
        runtime.log.warn(`[moneyswitch] notify: approval ${row.id} delivery attempt ${made}/${runtime.maxAttempts} failed, will retry`);
      }
    }
    return result;
  }

  return {
    tick,
    /** Runs one tick unless one is already running (interval driver). */
    tickGuarded(): Promise<TickResult | null> {
      if (inFlight || stopped) return Promise.resolve(null);
      const p = tick()
        .catch((e) => {
          if (!stopped) runtime.log.warn(`[moneyswitch] notify: outbox tick failed: ${e instanceof Error ? e.message : "error"}`);
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = p;
      return p;
    },
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      if (inFlight) await inFlight.catch(() => undefined);
    },
  };
}

/**
 * Starts the background loop (every `intervalMs`, default 2.5s; 0 disables).
 * The timer is unref'd so it never keeps the process alive. `stop()` aborts
 * in-flight sends and resolves once the running tick has finished, so the
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
