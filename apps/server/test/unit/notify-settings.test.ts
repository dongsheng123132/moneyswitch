import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import {
  applyPatch,
  buildAdminView,
  hasAnyChannel,
  maskToken,
  maskUrl,
  parsePatch,
  resolveSettings,
  secretsOf,
  toNotifyConfig,
} from "../../src/notify/settings.js";
import { NotifyInputError } from "../../src/notify/types.js";

const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7777-4bc4-97a0-0ec2sifa5aaa";
const TG_TOKEN = "123456789:AAE-abcdefghijklmnopqrstuvwxyz012345";

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = openDb({ filePath: ":memory:" }).sqlite;
});
afterEach(() => sqlite.close());

describe("masking", () => {
  it("maskUrl keeps only the origin and the last 4 characters", () => {
    const masked = maskUrl(FEISHU);
    expect(masked).toBe("https://open.feishu.cn/••••6789");
    expect(masked).not.toContain("0a1b2c3d");
    expect(maskUrl(WECOM)).toBe("https://qyapi.weixin.qq.com/••••5aaa");
    expect(maskUrl(WECOM)).not.toContain("693a91f6");
  });

  it("maskUrl never reveals a short URL's tail and survives garbage", () => {
    expect(maskUrl("http://a.io/x")).toBe("http://a.io/••••");
    expect(maskUrl("nonsense")).toBe("••••••••");
  });

  it("maskToken shows at most the last 4 characters", () => {
    expect(maskToken(TG_TOKEN)).toBe("••••2345");
    expect(maskToken("short")).toBe("••••");
  });
});

describe("parsePatch validation", () => {
  it("accepts a full valid patch and trims", () => {
    expect(
      parsePatch({
        feishu: { webhook: `  ${FEISHU} `, secret: "s3cret" },
        wecom: { webhook: WECOM },
        telegram: { bot_token: TG_TOKEN, chat_id: "-1001234567890" },
        webhook: { url: "http://127.0.0.1:9/hook" },
      })
    ).toEqual({
      feishu_webhook: FEISHU,
      feishu_secret: "s3cret",
      wecom_webhook: WECOM,
      telegram_bot_token: TG_TOKEN,
      telegram_chat_id: "-1001234567890",
      webhook_url: "http://127.0.0.1:9/hook",
    });
  });

  it("empty string and null clear a field", () => {
    expect(parsePatch({ feishu: { webhook: "", secret: null } })).toEqual({ feishu_webhook: null, feishu_secret: null });
  });

  it("rejects non-http(s) URLs, garbage, unknown fields, wrong types", () => {
    const bad = (body: unknown) => {
      try {
        parsePatch(body);
      } catch (e) {
        return e as NotifyInputError;
      }
      throw new Error("expected parsePatch to throw");
    };
    expect(bad({ feishu: { webhook: "file:///etc/passwd" } })).toMatchObject({ code: "INVALID_URL", field: "feishu.webhook" });
    expect(bad({ wecom: { webhook: "javascript:alert(1)" } })).toMatchObject({ code: "INVALID_URL", field: "wecom.webhook" });
    expect(bad({ webhook: { url: "not a url" } })).toMatchObject({ field: "webhook.url" });
    expect(bad({ telegram: { bot_token: "../x" } })).toMatchObject({ code: "INVALID_TELEGRAM_BOT_TOKEN" });
    expect(bad({ telegram: { chat_id: "abc def" } })).toMatchObject({ field: "telegram.chat_id" });
    expect(bad({ nope: { x: "y" } })).toMatchObject({ code: "UNKNOWN_FIELD", field: "nope.x" });
    expect(bad({ feishu: { webhook: 5 } })).toMatchObject({ code: "INVALID_VALUE" });
    expect(bad({ feishu: "str" })).toMatchObject({ code: "INVALID_BODY" });
    expect(bad(null)).toMatchObject({ code: "INVALID_BODY" });
    expect(bad({ feishu: { secret: "has space" } })).toMatchObject({ field: "feishu.secret" });
  });
});

describe("storage + env override", () => {
  it("applyPatch upserts and clears; resolveSettings reads it back", () => {
    applyPatch(sqlite, { feishu_webhook: FEISHU, feishu_secret: "s3cret", webhook_url: "http://x.io/h" }, {});
    expect(resolveSettings(sqlite, {}).values).toEqual({ feishu_webhook: FEISHU, feishu_secret: "s3cret", webhook_url: "http://x.io/h" });
    applyPatch(sqlite, { feishu_secret: null, webhook_url: "http://y.io/h" }, {});
    const { values, sources } = resolveSettings(sqlite, {});
    expect(values).toEqual({ feishu_webhook: FEISHU, webhook_url: "http://y.io/h" });
    expect(sources).toEqual({ feishu_webhook: "db", webhook_url: "db" });
  });

  it("env vars override the stored value per field and are reported as source env", () => {
    applyPatch(sqlite, { feishu_webhook: FEISHU, wecom_webhook: WECOM }, {});
    const env = {
      MONEYSWITCH_NOTIFY_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/FROM-ENV",
      MONEYSWITCH_NOTIFY_TELEGRAM_BOT_TOKEN: TG_TOKEN,
      MONEYSWITCH_NOTIFY_TELEGRAM_CHAT_ID: " 42 ",
      MONEYSWITCH_NOTIFY_WEBHOOK_URL: "   ",
    };
    const { values, sources } = resolveSettings(sqlite, env);
    expect(values.feishu_webhook).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/FROM-ENV");
    expect(values.wecom_webhook).toBe(WECOM);
    expect(values.telegram_chat_id).toBe("42");
    expect(values.webhook_url).toBeUndefined();
    expect(sources).toMatchObject({ feishu_webhook: "env", wecom_webhook: "db", telegram_bot_token: "env", telegram_chat_id: "env" });
    expect(toNotifyConfig(values).telegram).toEqual({ botToken: TG_TOKEN, chatId: "42" });
  });

  it("MONEYSWITCH_NOTIFY_FEISHU_SECRET, _WECOM_WEBHOOK and _WEBHOOK_URL are all honoured", () => {
    const { values } = resolveSettings(sqlite, {
      MONEYSWITCH_NOTIFY_FEISHU_WEBHOOK: FEISHU,
      MONEYSWITCH_NOTIFY_FEISHU_SECRET: "envsecret",
      MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: WECOM,
      MONEYSWITCH_NOTIFY_WEBHOOK_URL: "https://hooks.example.com/x",
    });
    const cfg = toNotifyConfig(values);
    expect(cfg.feishu).toEqual({ webhook: FEISHU, secret: "envsecret" });
    expect(cfg.wecom).toEqual({ webhook: WECOM });
    expect(cfg.webhook).toEqual({ url: "https://hooks.example.com/x" });
    expect(cfg.telegram).toBeNull();
  });

  it("a patch touching an env-supplied field is refused whole and nothing is written", () => {
    const env = { MONEYSWITCH_NOTIFY_WECOM_WEBHOOK: WECOM };
    expect(() => applyPatch(sqlite, { feishu_webhook: FEISHU, wecom_webhook: "http://x.io/y" }, env)).toThrowError(
      expect.objectContaining({ code: "FIELD_FROM_ENV", field: "wecom.webhook" })
    );
    expect(resolveSettings(sqlite, {}).values).toEqual({});
  });

  it("telegram needs both token and chat id to count as configured", () => {
    applyPatch(sqlite, { telegram_bot_token: TG_TOKEN }, {});
    expect(hasAnyChannel(toNotifyConfig(resolveSettings(sqlite, {}).values))).toBe(false);
    applyPatch(sqlite, { telegram_chat_id: "7" }, {});
    expect(hasAnyChannel(toNotifyConfig(resolveSettings(sqlite, {}).values))).toBe(true);
  });
});

describe("admin view never contains a full secret", () => {
  it("masks URLs/tokens, hides the Feishu secret entirely, shows the chat id", () => {
    applyPatch(
      sqlite,
      {
        feishu_webhook: FEISHU,
        feishu_secret: "SuperSecretSigningKey",
        wecom_webhook: WECOM,
        telegram_bot_token: TG_TOKEN,
        telegram_chat_id: "-100777",
        webhook_url: "https://hooks.example.com/services/T000/B000/XXXXXXXXXXXXXXXX",
      },
      {}
    );
    const { values, sources } = resolveSettings(sqlite, {});
    const view = buildAdminView(values, sources);
    const json = JSON.stringify(view);
    for (const secret of secretsOf(toNotifyConfig(values))) expect(json).not.toContain(secret);
    expect(json).not.toContain("SuperSecretSigningKey");
    expect(json).not.toContain("0a1b2c3d-4e5f");
    expect(json).not.toContain("693a91f6");
    expect(json).not.toContain("AAE-abcdefghijklmnopqrstuvwxyz");
    expect(json).not.toContain("XXXXXXXXXXXXXXXX");
    expect(view.channels.feishu).toEqual({
      configured: true,
      webhook: { set: true, masked: "https://open.feishu.cn/••••6789", source: "db" },
      secret: { set: true, masked: null, source: "db" },
    });
    expect(view.channels.telegram.chat_id).toEqual({ set: true, masked: null, value: "-100777", source: "db" });
    expect(view.channels.telegram.bot_token.masked).toBe("••••2345");
  });

  it("an empty configuration reports every channel unconfigured", () => {
    const view = buildAdminView({}, {});
    expect(Object.values(view.channels).map((c) => c.configured)).toEqual([false, false, false, false]);
    expect(view.channels.feishu.webhook).toEqual({ set: false, masked: null, source: null });
  });
});
