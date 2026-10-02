import React, { useCallback, useEffect, useState } from "react";
import { BellRing, Send } from "lucide-react";
import {
  ApiError,
  getNotifySettings,
  putNotifySettings,
  testNotify,
  type NotifyChannelId,
  type NotifyFieldView,
  type NotifyPatch,
  type NotifySettingsView,
  type NotifyTestResult,
} from "../api";
import { useT } from "../i18n";
import { notifyStrings } from "../i18n/strings/notify";
import Callout from "./Callout";
import Pill from "./Pill";
import "../styles/notify.css";

type LabelKey = "f_feishu_webhook" | "f_feishu_secret" | "f_wecom_webhook" | "f_telegram_bot_token" | "f_telegram_chat_id" | "f_webhook_url";
type NameKey = "feishuName" | "wecomName" | "telegramName" | "webhookName";
type HelpKey = "helpFeishu" | "helpWecom" | "helpTelegram" | "helpWebhook";

interface FieldDef {
  /** Property name in the API (feishu.webhook, telegram.bot_token, ...). */
  name: string;
  label: LabelKey;
  /** Rendered as a password input (secrets that are not URLs). */
  password?: boolean;
  placeholder: string;
}

const CHANNELS: { id: NotifyChannelId; name: NameKey; help: HelpKey; fields: FieldDef[] }[] = [
  {
    id: "feishu",
    name: "feishuName",
    help: "helpFeishu",
    fields: [
      { name: "webhook", label: "f_feishu_webhook", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
      { name: "secret", label: "f_feishu_secret", password: true, placeholder: "" },
    ],
  },
  {
    id: "wecom",
    name: "wecomName",
    help: "helpWecom",
    fields: [{ name: "webhook", label: "f_wecom_webhook", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." }],
  },
  {
    id: "telegram",
    name: "telegramName",
    help: "helpTelegram",
    fields: [
      { name: "bot_token", label: "f_telegram_bot_token", password: true, placeholder: "123456:ABC-DEF..." },
      { name: "chat_id", label: "f_telegram_chat_id", placeholder: "-1001234567890" },
    ],
  },
  {
    id: "webhook",
    name: "webhookName",
    help: "helpWebhook",
    fields: [{ name: "url", label: "f_webhook_url", placeholder: "https://example.com/hooks/moneyswitch" }],
  },
];

const KNOWN_ERRORS = ["INVALID_URL", "INVALID_VALUE", "INVALID_TELEGRAM_BOT_TOKEN", "INVALID_TELEGRAM_CHAT_ID", "FIELD_FROM_ENV"] as const;

function fieldOf(view: NotifySettingsView, channel: NotifyChannelId, name: string): NotifyFieldView {
  return (view.channels[channel] as unknown as Record<string, NotifyFieldView>)[name];
}

/**
 * Approval push-notification settings (Approvals page): which channels are
 * configured (secrets only ever shown masked), edit, and "send test message".
 * Only fields you touch are sent; an empty box means "leave as is".
 */
export default function NotifySettings() {
  const t = useT(notifyStrings);
  const [view, setView] = useState<NotifySettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<NotifyTestResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await getNotifySettings());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "request_failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function buildPatch(): NotifyPatch | null {
    const patch: Record<string, Record<string, string>> = {};
    let any = false;
    for (const ch of CHANNELS) {
      for (const f of ch.fields) {
        const key = `${ch.id}.${f.name}`;
        const value = cleared[key] ? "" : (draft[key] ?? "").trim();
        if (cleared[key] || value !== "") {
          (patch[ch.id] ??= {})[f.name] = value;
          any = true;
        }
      }
    }
    return any ? (patch as NotifyPatch) : null;
  }

  async function save() {
    const patch = buildPatch();
    if (!patch) {
      setMessage({ tone: "info", text: t("nothingToSave") });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      setView(await putNotifySettings(patch));
      setDraft({});
      setCleared({});
      setResults(null);
      setMessage({ tone: "success", text: t("saved") });
    } catch (e) {
      const code = e instanceof ApiError ? e.error : null;
      const known = KNOWN_ERRORS.find((k) => k === code);
      const text = known
        ? t(`err_${known}` as const, { field: e instanceof ApiError ? (e.field ?? "") : "" })
        : t("err_other", { message: e instanceof Error ? e.message : "request_failed" });
      setMessage({ tone: "error", text });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setResults(null);
    try {
      setResults(await testNotify());
    } catch (e) {
      setMessage({ tone: "error", text: t("err_other", { message: e instanceof Error ? e.message : "request_failed" }) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card notify-card" id="notifications">
      <div className="card-header">
        <h3>
          <BellRing size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {t("title")}
        </h3>
        <span className="card-sub">{t("subtitle")}</span>
      </div>
      <p className="dim notify-intro">{t("intro")}</p>
      {loadError && <Callout tone="error">{loadError}</Callout>}

      {view && (
        <>
          {view.approve_url ? (
            <p className="dim notify-link">
              {t("linkIs")} <span className="mono">{view.approve_url}</span>
            </p>
          ) : (
            <Callout tone="warn">{t("noPublicUrl")}</Callout>
          )}

          {CHANNELS.map((ch) => (
            <section className="notify-channel" key={ch.id}>
              <div className="notify-channel-head">
                <strong>{t(ch.name)}</strong>
                <Pill tone={view.channels[ch.id].configured ? "green" : "gray"}>
                  {view.channels[ch.id].configured ? t("configured") : t("notConfigured")}
                </Pill>
              </div>

              {ch.fields.map((f) => {
                const key = `${ch.id}.${f.name}`;
                const current = fieldOf(view, ch.id, f.name);
                const fromEnv = current.source === "env";
                const isCleared = Boolean(cleared[key]);
                const shown = current.value ?? current.masked;
                return (
                  <div className="field" key={key}>
                    <label htmlFor={`notify-${key}`}>{t(f.label)}</label>
                    <div className="notify-input-row">
                      <input
                        id={`notify-${key}`}
                        type={f.password ? "password" : "text"}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={fromEnv || isCleared}
                        value={draft[key] ?? ""}
                        placeholder={current.set ? (shown ?? "••••") : f.placeholder}
                        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      />
                      {current.set && !fromEnv && !isCleared && (
                        <button type="button" className="btn small secondary" onClick={() => setCleared({ ...cleared, [key]: true })}>
                          {t("clearField")}
                        </button>
                      )}
                      {isCleared && (
                        <button type="button" className="btn small secondary" onClick={() => setCleared({ ...cleared, [key]: false })}>
                          {t("undoClear")}
                        </button>
                      )}
                    </div>
                    <div className="field-hint">
                      {fromEnv
                        ? t("fromEnv")
                        : isCleared
                          ? t("willClear")
                          : current.set
                            ? current.masked
                              ? t("keepHint", { masked: current.masked })
                              : t("keepHintSet")
                            : null}
                    </div>
                  </div>
                );
              })}

              <details className="notify-help">
                <summary>{t("howTo")}</summary>
                <p>{t(ch.help)}</p>
              </details>
            </section>
          ))}

          {message && <Callout tone={message.tone}>{message.text}</Callout>}

          <div className="notify-actions">
            <button type="button" className="btn" onClick={save} disabled={saving}>
              {saving ? t("saving") : t("save")}
            </button>
            <button type="button" className="btn secondary" onClick={sendTest} disabled={testing || saving}>
              <Send size={14} />
              {testing ? t("sending") : t("sendTest")}
            </button>
          </div>

          {results && (
            <div className="notify-results" role="status">
              {results.length === 0 ? (
                <Callout tone="warn">{t("testNone")}</Callout>
              ) : (
                results.map((r) => (
                  <div className="notify-result" key={r.channel}>
                    <Pill tone={r.ok ? "green" : "red"}>{t(CHANNELS.find((c) => c.id === r.channel)!.name)}</Pill>
                    <span className={r.ok ? undefined : "dim"}>{r.ok ? t("testOk") : t("testFailed", { error: r.error ?? "" })}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
