import type { NotifyLogger, NotifyRuntimeOptions, SendDeps } from "./types.js";

export const DEFAULT_SEND_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LANE_CONCURRENCY = 4;
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

/** 15s, 30s, 60s, 120s, ... after attempt n started. All of it fits inside the 10 minute approval lifetime. */
export function defaultBackoffMs(attemptsMade: number): number {
  return 15_000 * 2 ** Math.max(0, attemptsMade - 1);
}

export const consoleLogger: NotifyLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

export interface NotifyRuntime {
  env: NodeJS.ProcessEnv;
  log: NotifyLogger;
  maxAttempts: number;
  backoffMs: (attemptsMade: number) => number;
  now: () => Date;
  /** Builds SendDeps; `signal` aborts in-flight sends (shutdown). */
  deps(signal?: AbortSignal): SendDeps;
}

export function resolveRuntime(opts: NotifyRuntimeOptions | undefined): NotifyRuntime {
  const now = opts?.now ?? (() => new Date());
  return {
    env: opts?.env ?? process.env,
    log: opts?.log ?? consoleLogger,
    maxAttempts: opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: opts?.retryBackoffMs ?? defaultBackoffMs,
    now,
    deps: (signal) => ({
      // Late-bound so the proxy-aware global dispatcher installed by @moneyswitch/net (and test stubs) always apply.
      fetch: opts?.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      timeoutMs: opts?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      signal,
      telegramApiBase: opts?.telegramApiBase ?? DEFAULT_TELEGRAM_API_BASE,
      now,
    }),
  };
}
