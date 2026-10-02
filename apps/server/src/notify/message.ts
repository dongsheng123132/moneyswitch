import type { NotifyEvent } from "./types.js";

/**
 * Per-event-type rendering. `RENDERERS` is keyed by every member of the
 * NotifyEvent union, so adding an event type without a renderer is a compile
 * error. Channels (channels.ts) only consume what comes out of here.
 */
type EventOf<T extends NotifyEvent["type"]> = Extract<NotifyEvent, { type: T }>;

interface Renderer<E extends NotifyEvent> {
  /** Short zh text for chat channels (Feishu / WeCom / Telegram). */
  text(event: E, now: Date): string;
  /** Body for the generic webhook. */
  json(event: E, now: Date): Record<string, unknown>;
}

/** Keeps free-form strings (key names are chosen by whoever created the key, possibly an agent) from forging extra lines or markup. */
export function cleanInline(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : flat;
}

/** Host (with port) and path of a URL. Never the query string, fragment or userinfo. */
export function splitHostPath(rawUrl: string): { host: string; path: string } {
  try {
    const u = new URL(rawUrl);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: "unknown", path: "" };
  }
}

function minutesLeft(expiresAt: string, now: Date): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 60_000));
}

function linkLine(approveUrl: string | null): string {
  return approveUrl ? `去审批：${approveUrl}` : "去审批：请打开 MoneySwitch Dashboard 的「审批」页面";
}

const RENDERERS: { [T in NotifyEvent["type"]]: Renderer<EventOf<T>> } = {
  approval_required: {
    text(event, now) {
      const a = event.approval;
      return [
        "[MoneySwitch] 有一笔付款等你审批",
        `Key：${cleanInline(a.keyName, 60)}`,
        `金额：${a.amount} ${a.currency}`,
        `去向：${cleanInline(a.host + a.path, 200)}`,
        `方法：${cleanInline(a.method, 12)}`,
        `有效期：${minutesLeft(a.expiresAt, now)} 分钟内处理，过期自动作废`,
        `审批编号：${cleanInline(a.id, 64)}`,
        linkLine(event.approveUrl),
      ].join("\n");
    },
    json(event) {
      const a = event.approval;
      return {
        event: "approval_required",
        approval: {
          id: a.id,
          key_name: a.keyName,
          key_prefix: a.keyPrefix,
          amount: a.amount,
          currency: a.currency,
          host: a.host,
          path: a.path,
          method: a.method,
          expires_at: a.expiresAt,
        },
        approve_url: event.approveUrl,
      };
    },
  },
  test: {
    text(event) {
      return ["[MoneySwitch] 这是一条测试通知", "收到这条消息，说明这个通知渠道已经配置成功。", linkLine(event.approveUrl)].join("\n");
    },
    json(event) {
      return { event: "test", approval: null, approve_url: event.approveUrl };
    },
  },
};

export function renderText(event: NotifyEvent, now: Date): string {
  return (RENDERERS[event.type] as Renderer<NotifyEvent>).text(event, now);
}

export function renderJson(event: NotifyEvent, now: Date): Record<string, unknown> {
  return (RENDERERS[event.type] as Renderer<NotifyEvent>).json(event, now);
}
