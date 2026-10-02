import { createHmac } from "node:crypto";
import { cleanInline } from "./message.js";
import { NotifyError, type NotifyConfig, type NotifyChannelId, type SendDeps } from "./types.js";

/**
 * One sender per channel. Every payload format below was checked against the
 * vendor documentation (URLs in docs/notifications.md):
 *
 *  - Feishu custom bot  POST <webhook>  {"msg_type":"text","content":{"text":...}}
 *    with signing enabled also {"timestamp":"<unix s>","sign":"..."} where
 *    sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, message = "")).
 *    HTTP 200 with {"code":0} is success; failures such as 19021 (bad sign) or
 *    19024 (keyword missing) come back as a JSON `code` != 0.
 *  - WeCom group bot    POST <webhook>  {"msgtype":"text","text":{"content":...}}
 *    content <= 2048 bytes (UTF-8); success is {"errcode":0,"errmsg":"ok"}.
 *  - Telegram Bot API   POST https://api.telegram.org/bot<token>/sendMessage
 *    {"chat_id":...,"text":...} (<= 4096 chars); response always has a boolean `ok`.
 *  - Generic webhook    POST <url> with the JSON built by message.ts; any 2xx is success.
 */

const MAX_RESPONSE_BYTES = 8192;
const WECOM_MAX_BYTES = 2048;
const TELEGRAM_MAX_CHARS = 4096;

// --- payload builders (pure) ---------------------------------------------------

/** Feishu signature: base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = "")). */
export function feishuSign(timestampSec: number | string, secret: string): string {
  return createHmac("sha256", `${timestampSec}\n${secret}`).update("").digest("base64");
}

export function buildFeishuPayload(text: string, secret: string | null, nowSec: number): Record<string, unknown> {
  const body = { msg_type: "text", content: { text } };
  if (!secret) return body;
  return { timestamp: String(nowSec), sign: feishuSign(nowSec, secret), ...body };
}

/** Cuts to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

export function buildWecomPayload(text: string): Record<string, unknown> {
  return { msgtype: "text", text: { content: truncateUtf8(text, WECOM_MAX_BYTES) } };
}

const TELEGRAM_TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{10,}$/;
const TELEGRAM_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export function isValidTelegramToken(token: string): boolean {
  return TELEGRAM_TOKEN_RE.test(token);
}

export function isValidTelegramChatId(chatId: string): boolean {
  return TELEGRAM_CHAT_RE.test(chatId);
}

export function buildTelegramRequest(
  botToken: string,
  chatId: string,
  text: string,
  apiBase: string
): { url: string; body: Record<string, unknown> } {
  if (!isValidTelegramToken(botToken)) throw new NotifyError("invalid Telegram bot token format");
  if (!isValidTelegramChatId(chatId)) throw new NotifyError("invalid Telegram chat id format");
  const chars = Array.from(text);
  return {
    url: `${apiBase.replace(/\/+$/, "")}/bot${botToken}/sendMessage`,
    body: {
      // Numeric ids go out as numbers (what the Bot API documents); anything beyond 2^53 or an @channelname stays a string.
      chat_id: /^-?\d+$/.test(chatId) && Number.isSafeInteger(Number(chatId)) ? Number(chatId) : chatId,
      text: chars.length > TELEGRAM_MAX_CHARS ? chars.slice(0, TELEGRAM_MAX_CHARS).join("") : text,
      link_preview_options: { is_disabled: true },
    },
  };
}

// --- HTTP plumbing -------------------------------------------------------------

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Network-level failure -> a fixed vocabulary; never the raw error message (it can embed the URL). */
function describeNetworkError(e: unknown): string {
  const err = e as { name?: string; cause?: { code?: string } } | null;
  if (err?.name === "TimeoutError") return "timeout";
  if (err?.name === "AbortError") return "aborted";
  const code = err?.cause?.code;
  return code && /^[A-Z0-9_]{3,40}$/.test(code) ? `network error (${code})` : "network error";
}

interface HttpOutcome {
  status: number;
  ok: boolean;
  json: Record<string, unknown> | null;
}

async function postJson(url: string, body: unknown, deps: SendDeps): Promise<HttpOutcome> {
  const signals: AbortSignal[] = [AbortSignal.timeout(deps.timeoutMs)];
  if (deps.signal) signals.push(deps.signal);
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "user-agent": "MoneySwitch-Notify" },
      body: JSON.stringify(body),
      // A webhook that answers with a redirect is treated as a failure: never follow it somewhere else.
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw new NotifyError(describeNetworkError(e));
  }
  let text = "";
  try {
    text = await readLimited(res, MAX_RESPONSE_BYTES);
  } catch {
    // body unreadable: judge by status alone
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json };
}

function remoteText(v: unknown): string {
  return typeof v === "string" ? ` - ${cleanInline(v, 120)}` : "";
}

// --- senders --------------------------------------------------------------------

export interface Content {
  text: string;
  json: Record<string, unknown>;
}

export async function sendFeishu(cfg: NonNullable<NotifyConfig["feishu"]>, content: Content, deps: SendDeps): Promise<void> {
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const r = await postJson(cfg.webhook, buildFeishuPayload(content.text, cfg.secret, nowSec), deps);
  const code = r.json ? (r.json.code ?? r.json.StatusCode) : undefined;
  if (r.ok && code === 0) return;
  throw new NotifyError(
    `Feishu rejected the message (HTTP ${r.status}${code !== undefined ? `, code ${String(code).slice(0, 12)}` : ""})${remoteText(r.json?.msg)}`
  );
}

export async function sendWecom(cfg: NonNullable<NotifyConfig["wecom"]>, content: Content, deps: SendDeps): Promise<void> {
  const r = await postJson(cfg.webhook, buildWecomPayload(content.text), deps);
  const code = r.json?.errcode;
  if (r.ok && code === 0) return;
  throw new NotifyError(
    `WeCom rejected the message (HTTP ${r.status}${code !== undefined ? `, errcode ${String(code).slice(0, 12)}` : ""})${remoteText(r.json?.errmsg)}`
  );
}

export async function sendTelegram(cfg: NonNullable<NotifyConfig["telegram"]>, content: Content, deps: SendDeps): Promise<void> {
  const req = buildTelegramRequest(cfg.botToken, cfg.chatId, content.text, deps.telegramApiBase);
  const r = await postJson(req.url, req.body, deps);
  if (r.ok && r.json?.ok === true) return;
  const code = r.json?.error_code;
  throw new NotifyError(
    `Telegram rejected the message (HTTP ${r.status}${typeof code === "number" ? `, error_code ${code}` : ""})${remoteText(r.json?.description)}`
  );
}

export async function sendWebhook(cfg: NonNullable<NotifyConfig["webhook"]>, content: Content, deps: SendDeps): Promise<void> {
  const r = await postJson(cfg.url, content.json, deps);
  if (r.ok) return;
  throw new NotifyError(`webhook answered HTTP ${r.status}`);
}

export const CHANNEL_LABEL: Record<NotifyChannelId, string> = {
  feishu: "Feishu",
  wecom: "WeCom",
  telegram: "Telegram",
  webhook: "webhook",
};
