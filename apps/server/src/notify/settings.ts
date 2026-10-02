import type Database from "better-sqlite3";
import { isValidTelegramChatId, isValidTelegramToken } from "./channels.js";
import {
  NOTIFY_SETTING_KEYS,
  NotifyInputError,
  type NotifyConfig,
  type NotifySettingKey,
} from "./types.js";

/**
 * Channel configuration: admin-editable rows in `notify_settings`, overridden
 * per field by MONEYSWITCH_NOTIFY_* environment variables (headless deploys).
 * The environment is read live on every call, so nothing is cached that could
 * go stale, and env values are never written to the database.
 *
 * Webhook URLs, the Feishu signing secret and the Telegram bot token are
 * secrets. They are stored as plain text in the local SQLite file (same trust
 * boundary as the key hashes and audit log next to them), never logged, and
 * only ever leave this module masked (see `buildAdminView`).
 */

export const ENV_FOR_KEY: Record<NotifySettingKey, string> = {
  feishu_webhook: "MONEYSWITCH_NOTIFY_FEISHU_WEBHOOK",
  feishu_secret: "MONEYSWITCH_NOTIFY_FEISHU_SECRET",
  wecom_webhook: "MONEYSWITCH_NOTIFY_WECOM_WEBHOOK",
  telegram_bot_token: "MONEYSWITCH_NOTIFY_TELEGRAM_BOT_TOKEN",
  telegram_chat_id: "MONEYSWITCH_NOTIFY_TELEGRAM_CHAT_ID",
  webhook_url: "MONEYSWITCH_NOTIFY_WEBHOOK_URL",
};

export type SettingValues = Partial<Record<NotifySettingKey, string>>;
export type SettingSources = Partial<Record<NotifySettingKey, "env" | "db">>;

export function resolveSettings(
  sqlite: Database.Database,
  env: NodeJS.ProcessEnv = process.env
): { values: SettingValues; sources: SettingSources } {
  const values: SettingValues = {};
  const sources: SettingSources = {};
  const rows = sqlite.prepare(`SELECT key, value FROM notify_settings`).all() as { key: string; value: string }[];
  for (const row of rows) {
    if ((NOTIFY_SETTING_KEYS as readonly string[]).includes(row.key) && row.value) {
      values[row.key as NotifySettingKey] = row.value;
      sources[row.key as NotifySettingKey] = "db";
    }
  }
  for (const key of NOTIFY_SETTING_KEYS) {
    const fromEnv = env[ENV_FOR_KEY[key]]?.trim();
    if (fromEnv) {
      values[key] = fromEnv;
      sources[key] = "env";
    }
  }
  return { values, sources };
}

export function toNotifyConfig(values: SettingValues): NotifyConfig {
  return {
    feishu: values.feishu_webhook ? { webhook: values.feishu_webhook, secret: values.feishu_secret ?? null } : null,
    wecom: values.wecom_webhook ? { webhook: values.wecom_webhook } : null,
    telegram:
      values.telegram_bot_token && values.telegram_chat_id
        ? { botToken: values.telegram_bot_token, chatId: values.telegram_chat_id }
        : null,
    webhook: values.webhook_url ? { url: values.webhook_url } : null,
  };
}

export function hasAnyChannel(config: NotifyConfig): boolean {
  return Boolean(config.feishu || config.wecom || config.telegram || config.webhook);
}

/** Every secret string in the config; used to scrub error text before it is logged or returned. */
export function secretsOf(config: NotifyConfig): string[] {
  const out: string[] = [];
  if (config.feishu) out.push(config.feishu.webhook, ...(config.feishu.secret ? [config.feishu.secret] : []));
  if (config.wecom) out.push(config.wecom.webhook);
  if (config.telegram) out.push(config.telegram.botToken);
  if (config.webhook) out.push(config.webhook.url);
  return out.filter(Boolean);
}

// --- masking ----------------------------------------------------------------------

const DOTS = "••••";

/**
 * Hides the host's identifying part. Webhook URLs are often secret in the
 * host too (Pipedream endpoint ids, tunnel subdomains, a private domain), so
 * only the last two labels of a host with three or more labels survive
 * (`open.feishu.cn` -> `••••.feishu.cn`); IP addresses, single-label and
 * two-label hosts (the name itself may be the secret) are hidden entirely.
 */
function maskHost(hostname: string): string {
  const isIp = hostname.includes(":") || /^\d+(\.\d+){3}$/.test(hostname);
  const labels = hostname.split(".");
  if (isIp || labels.length < 3) return DOTS;
  return `${DOTS}.${labels.slice(-2).join(".")}`;
}

/**
 * `https://••••.example.com/••••abcd`: scheme, the masked host (see maskHost)
 * and the last 4 characters of the path + query when those are long enough to
 * make that safe. No port, no userinfo. Tokens can sit anywhere in the URL, so
 * nothing else is shown.
 */
export function maskUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return DOTS + DOTS;
  }
  const rest = u.pathname + u.search;
  const tail = rest.length > 12 ? rest.slice(-4) : "";
  return `${u.protocol}//${maskHost(u.hostname)}/${DOTS}${tail}`;
}

export function maskToken(token: string): string {
  return token.length >= 16 ? `${DOTS}${token.slice(-4)}` : DOTS;
}

// --- admin view -------------------------------------------------------------------

export interface FieldView {
  set: boolean;
  /** Masked secret, or null (not set, or not meant to be shown at all). */
  masked: string | null;
  /** Plain value, only for non-secret fields (Telegram chat id). */
  value?: string | null;
  source: "env" | "db" | null;
}

export interface NotifyAdminView {
  channels: {
    feishu: { configured: boolean; webhook: FieldView; secret: FieldView };
    wecom: { configured: boolean; webhook: FieldView };
    telegram: { configured: boolean; bot_token: FieldView; chat_id: FieldView };
    webhook: { configured: boolean; url: FieldView };
  };
}

export function buildAdminView(values: SettingValues, sources: SettingSources): NotifyAdminView {
  const f = (key: NotifySettingKey, mask: ((v: string) => string) | "none" | "plain"): FieldView => {
    const v = values[key];
    const set = Boolean(v);
    const base: FieldView = { set, masked: null, source: set ? (sources[key] ?? null) : null };
    if (!set || !v) return mask === "plain" ? { ...base, value: null } : base;
    if (mask === "plain") return { ...base, value: v };
    if (mask === "none") return base;
    return { ...base, masked: mask(v) };
  };
  const config = toNotifyConfig(values);
  return {
    channels: {
      feishu: { configured: Boolean(config.feishu), webhook: f("feishu_webhook", maskUrl), secret: f("feishu_secret", "none") },
      wecom: { configured: Boolean(config.wecom), webhook: f("wecom_webhook", maskUrl) },
      telegram: {
        configured: Boolean(config.telegram),
        bot_token: f("telegram_bot_token", maskToken),
        chat_id: f("telegram_chat_id", "plain"),
      },
      webhook: { configured: Boolean(config.webhook), url: f("webhook_url", maskUrl) },
    },
  };
}

// --- updates ----------------------------------------------------------------------

/** `null` = clear the setting. */
export type SettingsPatch = Partial<Record<NotifySettingKey, string | null>>;

const FIELD_OF_KEY: Record<NotifySettingKey, string> = {
  feishu_webhook: "feishu.webhook",
  feishu_secret: "feishu.secret",
  wecom_webhook: "wecom.webhook",
  telegram_bot_token: "telegram.bot_token",
  telegram_chat_id: "telegram.chat_id",
  webhook_url: "webhook.url",
};

const KEY_OF_FIELD = Object.fromEntries(Object.entries(FIELD_OF_KEY).map(([k, v]) => [v, k as NotifySettingKey])) as Record<
  string,
  NotifySettingKey
>;

function validateValue(key: NotifySettingKey, value: string): void {
  const field = FIELD_OF_KEY[key];
  // Values were trimmed by parsePatch; none of these fields can legitimately contain whitespace or control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) throw new NotifyInputError("INVALID_VALUE", field);
  switch (key) {
    case "feishu_webhook":
    case "wecom_webhook":
    case "webhook_url": {
      if (value.length > 2048) throw new NotifyInputError("INVALID_URL", field);
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        throw new NotifyInputError("INVALID_URL", field);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new NotifyInputError("INVALID_URL", field);
      return;
    }
    case "feishu_secret":
      // eslint-disable-next-line no-control-regex
      if (value.length > 256) throw new NotifyInputError("INVALID_VALUE", field);
      return;
    case "telegram_bot_token":
      if (!isValidTelegramToken(value)) throw new NotifyInputError("INVALID_TELEGRAM_BOT_TOKEN", field);
      return;
    case "telegram_chat_id":
      if (!isValidTelegramChatId(value)) throw new NotifyInputError("INVALID_TELEGRAM_CHAT_ID", field);
      return;
  }
}

/**
 * Turns a PUT body into a validated patch. Body shape (everything optional;
 * an absent field is left alone, `""` or null clears it):
 *   { feishu:{webhook,secret}, wecom:{webhook}, telegram:{bot_token,chat_id}, webhook:{url} }
 */
export function parsePatch(body: unknown): SettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new NotifyInputError("INVALID_BODY", "body");
  const patch: SettingsPatch = {};
  for (const [group, fields] of Object.entries(body as Record<string, unknown>)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new NotifyInputError("INVALID_BODY", group);
    for (const [name, raw] of Object.entries(fields as Record<string, unknown>)) {
      const field = `${group}.${name}`;
      const key = KEY_OF_FIELD[field];
      if (!key) throw new NotifyInputError("UNKNOWN_FIELD", field);
      if (raw !== null && typeof raw !== "string") throw new NotifyInputError("INVALID_VALUE", field);
      const value = raw === null ? "" : raw.trim();
      if (value === "") {
        patch[key] = null;
        continue;
      }
      validateValue(key, value);
      patch[key] = value;
    }
  }
  return patch;
}

/**
 * Writes a validated patch in one transaction. Fields currently supplied by an
 * environment variable are read-only (the env value would win anyway), so a
 * patch touching one is refused as a whole.
 */
export function applyPatch(
  sqlite: Database.Database,
  patch: SettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): NotifySettingKey[] {
  const keys = Object.keys(patch) as NotifySettingKey[];
  for (const key of keys) {
    if (env[ENV_FOR_KEY[key]]?.trim()) throw new NotifyInputError("FIELD_FROM_ENV", FIELD_OF_KEY[key]);
  }
  const upsert = sqlite.prepare(
    `INSERT INTO notify_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const remove = sqlite.prepare(`DELETE FROM notify_settings WHERE key = ?`);
  sqlite.transaction(() => {
    for (const key of keys) {
      const v = patch[key];
      if (v == null) remove.run(key);
      else upsert.run(key, v, now.toISOString());
    }
  })();
  return keys;
}

export function fieldName(key: NotifySettingKey): string {
  return FIELD_OF_KEY[key];
}
