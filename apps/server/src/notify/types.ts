/**
 * Push notifications (approval needed -> operator's phone).
 *
 * Shape of the feature, so the next event type is an addition, not a rewrite:
 *
 *   outbox.ts      finds work (today: pending approvals) and builds a NotifyEvent
 *   message.ts     one renderer per event type: zh text for chat channels + JSON for the generic webhook
 *   channels.ts    one sender per channel; they only ever see rendered text / JSON, never an event type
 *   dispatcher.ts  fan-out to every configured channel, one failing channel never blocks the others
 *
 * Adding e.g. a `payment_unknown` event = extend `NotifyEvent` below, add its
 * renderer in message.ts (the compiler refuses to build until you do) and make
 * something produce it. Channels and the dispatcher are not touched.
 */

export const NOTIFY_CHANNELS = ["feishu", "wecom", "telegram", "webhook"] as const;
export type NotifyChannelId = (typeof NOTIFY_CHANNELS)[number];

/** Flat setting keys as stored in `notify_settings` (and overridable by env vars, see settings.ts). */
export const NOTIFY_SETTING_KEYS = [
  "feishu_webhook",
  "feishu_secret",
  "wecom_webhook",
  "telegram_bot_token",
  "telegram_chat_id",
  "webhook_url",
] as const;
export type NotifySettingKey = (typeof NOTIFY_SETTING_KEYS)[number];

/** Resolved, ready-to-use channel configuration (a channel is null when it is not configured). */
export interface NotifyConfig {
  feishu: { webhook: string; secret: string | null } | null;
  wecom: { webhook: string } | null;
  telegram: { botToken: string; chatId: string } | null;
  webhook: { url: string } | null;
}

/** What an approval notification is allowed to say. Host + path only: never the query string, headers or body. */
export interface ApprovalNotifyInfo {
  id: string;
  keyName: string;
  keyPrefix: string;
  /** Decimal USDC string, e.g. "0.15". */
  amount: string;
  currency: "USDC";
  host: string;
  path: string;
  method: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export type NotifyEvent =
  | { type: "approval_required"; approval: ApprovalNotifyInfo; approveUrl: string | null }
  /** Sent by POST /v1/admin/notify/test. */
  | { type: "test"; approveUrl: string | null };

export interface ChannelResult {
  channel: NotifyChannelId;
  ok: boolean;
  /** Short, secret-free reason when !ok. */
  error?: string;
}

export interface NotifyLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Everything a sender needs besides its own channel config. */
export interface SendDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  /** Aborts in-flight sends (server shutdown). */
  signal?: AbortSignal;
  /** Overridable for tests; default https://api.telegram.org */
  telegramApiBase: string;
  now: () => Date;
}

/**
 * Optional knobs on AppContext (`ctx.notify`). Production leaves it unset;
 * tests inject a fake fetch / env / clock.
 */
export interface NotifyRuntimeOptions {
  fetch?: typeof fetch;
  /** Where MONEYSWITCH_NOTIFY_* are read from. Defaults to process.env (read live on every use). */
  env?: NodeJS.ProcessEnv;
  log?: NotifyLogger;
  telegramApiBase?: string;
  /** Per-channel HTTP timeout. Default 8000. */
  sendTimeoutMs?: number;
  /** Delivery attempts per approval before giving up. Default 5. */
  maxAttempts?: number;
  /** Wait before attempt n+1 after attempt n started (n >= 1), ms. Default 15s, 30s, 60s, 120s... */
  retryBackoffMs?: (attemptsMade: number) => number;
  now?: () => Date;
}

/** Thrown by senders; `message` is always safe to log and to return to the admin. */
export class NotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyError";
  }
}

/** Thrown by settings validation; `field` is the dotted API field, e.g. "feishu.webhook". */
export class NotifyInputError extends Error {
  constructor(
    public readonly code: string,
    public readonly field: string
  ) {
    super(`${code}: ${field}`);
    this.name = "NotifyInputError";
  }
}
