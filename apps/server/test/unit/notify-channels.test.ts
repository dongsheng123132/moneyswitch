import { describe, it, expect } from "vitest";
import {
  buildFeishuPayload,
  buildTelegramRequest,
  buildWecomPayload,
  feishuSign,
  truncateUtf8,
} from "../../src/notify/channels.js";
import { cleanInline, renderJson, renderText, splitHostPath } from "../../src/notify/message.js";
import type { NotifyEvent } from "../../src/notify/types.js";

const NOW = new Date("2026-10-02T08:00:00.000Z");

function approvalEvent(over: Partial<Extract<NotifyEvent, { type: "approval_required" }>["approval"]> = {}, approveUrl: string | null = "https://pay.example.com/approvals"): NotifyEvent {
  return {
    type: "approval_required",
    approval: {
      id: "11111111-2222-3333-4444-555555555555",
      keyName: "Codex",
      keyPrefix: "mk_live_ab12",
      amount: "0.15",
      currency: "USDC",
      host: "api.example.com",
      path: "/deep-report",
      method: "GET",
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      ...over,
    },
    approveUrl,
  };
}

describe("Feishu signing (https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot, section 'sign')", () => {
  // The doc's own example inputs are timestamp 1599360473 and secret "demo". The expected value below was
  // produced by running the doc's Python reference (hmac.new(f"{ts}\n{secret}".encode(), digestmod=sha256),
  // i.e. HMAC-SHA256 with the empty message, then base64), not by this code.
  it("matches the vector derived from the documented algorithm", () => {
    expect(feishuSign(1599360473, "demo")).toBe("l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=");
    expect(feishuSign(1599360473, "ms-test-secret")).toBe("X66iUG9zClt7NHv4RWHB5CDk+ukbFUz5lWfw7Osb+Ts=");
    expect(feishuSign(1700000000, "密钥-秘密")).toBe("f6jxewsXDEm6yd+3BsZc4dYn+3Q6D65u/LQlZWwZpLE=");
  });

  it("accepts the timestamp as number or string", () => {
    expect(feishuSign("1599360473", "demo")).toBe(feishuSign(1599360473, "demo"));
  });

  it("payload without a secret has no timestamp/sign", () => {
    expect(buildFeishuPayload("hi", null, 1599360473)).toEqual({ msg_type: "text", content: { text: "hi" } });
  });

  it("payload with a secret carries timestamp (string, seconds) + sign next to msg_type/content", () => {
    expect(buildFeishuPayload("hi", "demo", 1599360473)).toEqual({
      timestamp: "1599360473",
      sign: "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=",
      msg_type: "text",
      content: { text: "hi" },
    });
  });
});

describe("WeCom payload (https://developer.work.weixin.qq.com/document/path/91770)", () => {
  it("is {msgtype:'text', text:{content}}", () => {
    expect(buildWecomPayload("hello")).toEqual({ msgtype: "text", text: { content: "hello" } });
  });

  it("caps content at 2048 UTF-8 bytes without cutting a character in half", () => {
    const long = "审".repeat(1000); // 3 bytes each
    const body = buildWecomPayload(long) as { text: { content: string } };
    expect(Buffer.byteLength(body.text.content, "utf8")).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(body.text.content, "utf8")).toBe(2046);
    expect(body.text.content).toBe("审".repeat(682));
    expect(truncateUtf8("abc", 2)).toBe("ab");
    expect(truncateUtf8("short", 100)).toBe("short");
  });
});

describe("Telegram request (https://core.telegram.org/bots/api#sendmessage)", () => {
  const token = "123456789:AAE-abcdefghijklmnopqrstuvwxyz012345";

  it("POSTs to <base>/bot<token>/sendMessage with chat_id + text and no link preview", () => {
    const req = buildTelegramRequest(token, "-1001234567890", "hi", "https://api.telegram.org/");
    expect(req.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(req.body).toEqual({ chat_id: -1001234567890, text: "hi", link_preview_options: { is_disabled: true } });
  });

  it("keeps @channelname chat ids as strings", () => {
    expect(buildTelegramRequest(token, "@my_channel", "hi", "https://api.telegram.org").body.chat_id).toBe("@my_channel");
  });

  it("caps text at 4096 characters", () => {
    const body = buildTelegramRequest(token, "1", "x".repeat(5000), "https://api.telegram.org").body as { text: string };
    expect(body.text).toHaveLength(4096);
  });

  it("refuses a token or chat id that is not shaped like Telegram's (it goes into the URL path)", () => {
    expect(() => buildTelegramRequest("../../evil", "1", "hi", "https://api.telegram.org")).toThrow(/token/);
    expect(() => buildTelegramRequest(token + "/x?y", "1", "hi", "https://api.telegram.org")).toThrow(/token/);
    expect(() => buildTelegramRequest(token, "1; drop", "hi", "https://api.telegram.org")).toThrow(/chat id/);
  });
});

describe("message text (zh)", () => {
  it("states who / how much / where / method / expiry / approval id / link", () => {
    const text = renderText(approvalEvent(), NOW);
    expect(text).toContain("Key：Codex");
    expect(text).toContain("金额：0.15 USDC");
    expect(text).toContain("去向：api.example.com/deep-report");
    expect(text).toContain("方法：GET");
    expect(text).toContain("10 分钟内处理");
    expect(text).toContain("审批编号：11111111-2222-3333-4444-555555555555");
    expect(text).toContain("去审批：https://pay.example.com/approvals");
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("rounds the remaining time up and never says 0 minutes", () => {
    expect(renderText(approvalEvent({ expiresAt: new Date(NOW.getTime() + 61_000).toISOString() }), NOW)).toContain("2 分钟内处理");
    expect(renderText(approvalEvent({ expiresAt: new Date(NOW.getTime() + 1_000).toISOString() }), NOW)).toContain("1 分钟内处理");
  });

  it("without a public URL tells the operator to open the dashboard Approvals page", () => {
    const text = renderText(approvalEvent({}, null), NOW);
    expect(text).toContain("请打开 MoneySwitch Dashboard 的「审批」页面");
    expect(text).not.toContain("http");
  });

  it("splitHostPath drops query string, fragment and userinfo", () => {
    expect(splitHostPath("https://user:pw@api.example.com:8443/v1/x?token=SECRET&a=1#frag")).toEqual({
      host: "api.example.com:8443",
      path: "/v1/x",
    });
    expect(splitHostPath("not a url")).toEqual({ host: "unknown", path: "" });
  });

  it("a key name chosen by an agent cannot forge extra lines or markup", () => {
    const text = renderText(approvalEvent({ keyName: "evil\n金额：0.0001 USDC\n<at user_id=\"all\">x</at>" }), NOW);
    const keyLines = text.split("\n").filter((l) => l.startsWith("Key："));
    expect(keyLines).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.startsWith("金额："))).toEqual(["金额：0.15 USDC"]);
    expect(text).not.toContain("<");
    expect(cleanInline("a".repeat(100), 10)).toBe("aaaaaaaaa…");
  });

  it("test event text", () => {
    expect(renderText({ type: "test", approveUrl: null }, NOW)).toContain("测试通知");
  });
});

describe("generic webhook JSON", () => {
  it("is {event, approval:{id,key_name,key_prefix,amount,currency,host,path,method,expires_at}, approve_url}", () => {
    const ev = approvalEvent();
    expect(renderJson(ev, NOW)).toEqual({
      event: "approval_required",
      approval: {
        id: "11111111-2222-3333-4444-555555555555",
        key_name: "Codex",
        key_prefix: "mk_live_ab12",
        amount: "0.15",
        currency: "USDC",
        host: "api.example.com",
        path: "/deep-report",
        method: "GET",
        expires_at: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      },
      approve_url: "https://pay.example.com/approvals",
    });
  });

  it("test event has approval: null", () => {
    expect(renderJson({ type: "test", approveUrl: null }, NOW)).toEqual({ event: "test", approval: null, approve_url: null });
  });
});
