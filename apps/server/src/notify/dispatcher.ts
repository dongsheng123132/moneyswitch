import { CHANNEL_LABEL, sendFeishu, sendTelegram, sendWebhook, sendWecom, type Content } from "./channels.js";
import { renderJson, renderText } from "./message.js";
import { secretsOf } from "./settings.js";
import {
  NOTIFY_CHANNELS,
  type ChannelResult,
  type NotifyChannelId,
  type NotifyConfig,
  type NotifyEvent,
  type NotifyLogger,
  type SendDeps,
} from "./types.js";

/**
 * Removes anything secret-shaped from text that is about to be logged or
 * returned to the admin. Senders already only produce fixed-vocabulary
 * messages plus short remote error text; this is the backstop.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 240 ? out.slice(0, 239) + "…" : out;
}

type Sender = (config: NotifyConfig, content: Content, deps: SendDeps) => Promise<void> | null;

const SENDERS: Record<NotifyChannelId, Sender> = {
  feishu: (c, content, deps) => (c.feishu ? sendFeishu(c.feishu, content, deps) : null),
  wecom: (c, content, deps) => (c.wecom ? sendWecom(c.wecom, content, deps) : null),
  telegram: (c, content, deps) => (c.telegram ? sendTelegram(c.telegram, content, deps) : null),
  webhook: (c, content, deps) => (c.webhook ? sendWebhook(c.webhook, content, deps) : null),
};

/**
 * Sends one event to every configured channel, in parallel. Never throws: a
 * failing (or hanging, or throwing) channel only affects its own result entry,
 * and failures are logged without any secret.
 */
export async function dispatchEvent(
  event: NotifyEvent,
  config: NotifyConfig,
  deps: SendDeps,
  log: NotifyLogger
): Promise<ChannelResult[]> {
  const now = deps.now();
  const content: Content = { text: renderText(event, now), json: renderJson(event, now) };
  const secrets = secretsOf(config);

  const runs = NOTIFY_CHANNELS.map(async (channel): Promise<ChannelResult | null> => {
    let pending: Promise<void> | null;
    try {
      pending = SENDERS[channel](config, content, deps);
    } catch (e) {
      pending = Promise.reject(e);
    }
    if (!pending) return null; // channel not configured
    try {
      await pending;
      return { channel, ok: true };
    } catch (e) {
      const error = scrubSecrets(e instanceof Error ? e.message : "send failed", secrets) || "send failed";
      log.warn(`[moneyswitch] notify: ${CHANNEL_LABEL[channel]} delivery failed: ${error}`);
      return { channel, ok: false, error };
    }
  });

  return (await Promise.all(runs)).filter((r): r is ChannelResult => r !== null);
}
