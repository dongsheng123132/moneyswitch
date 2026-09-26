import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Loader2, ExternalLink } from "lucide-react";
import { listModelsForKey, sendChatCompletion, ChatApiError, ChatMessage } from "../api";
import { formatUsdc } from "../money";
import { useT, TFunction } from "../i18n";
import { playgroundStrings } from "../i18n/strings/playground";
import TxLink from "./TxLink";
import "../styles/playground.css";

type PgStrings = TFunction<keyof typeof playgroundStrings.en>;

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "approval" | "error";
  content: string;
  cost?: string;
  txHash?: string;
  tokens?: number;
  approvalId?: string | null;
  /** Snapshot of the conversation sent when this approval/error happened, for "Continue". */
  pendingHistory?: ChatMessage[];
  stillWaiting?: boolean;
  resending?: boolean;
  rawCode?: string | null;
  errLink?: React.ReactNode;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${seq}`;
}

const KEY_COMPLETE_RE = /^mk_live_.{32,}/;

interface PlaygroundChatProps {
  apiKey: string;
  /** admin: editable key input; employee: omitted (masked chip). */
  onApiKeyChange?: (v: string) => void;
  rightPanel: React.ReactNode;
  autoLoadModels?: boolean;
  /** default "admin"; tailors approval/error copy. */
  audience?: "admin" | "employee";
  /** admin: "/approvals" */
  approvalsLinkTo?: string;
  onMessageSettled?: () => void;
}

/** Maps a chat gateway error code to a friendly sentence (docs/ux-audit.md B-3/B-4/B-6). */
function friendlyErrorText(t: PgStrings, code: string | null, audience: "admin" | "employee"): { title: string; link?: React.ReactNode } {
  switch ((code || "").toUpperCase()) {
    case "DAILY_BUDGET_EXCEEDED":
      return { title: t("err_dailyBudget") };
    case "TOTAL_BUDGET_EXCEEDED":
      return { title: t("err_totalBudget") };
    case "PER_REQUEST_LIMIT_EXCEEDED":
      return { title: t("err_perRequest") };
    case "RATE_LIMITED":
      return { title: t("err_rateLimited") };
    case "KEY_REVOKED":
      return { title: t("err_keyRevoked") };
    case "KEY_EXPIRED":
      return { title: t("err_keyExpired") };
    case "KEY_INVALID":
      return { title: t("err_keyInvalid") };
    case "WALLET_LOCKED":
      return audience === "employee"
        ? { title: t("err_walletLockedEmployee") }
        : {
            title: t("err_walletLockedAdmin"),
            link: (
              <Link to="/wallet" className="btn small secondary">
                {t("walletPageLink")}
                <ExternalLink size={12} />
              </Link>
            ),
          };
    case "MODEL_NOT_ALLOWED":
      return { title: t("err_modelNotAllowed") };
    case "MODEL_NOT_FOUND":
      return { title: t("err_modelNotFound") };
    case "PAYMENT_FAILED":
      return { title: t("err_paymentFailed") };
    case "UPSTREAM_ERROR":
      return { title: t("err_upstreamError") };
    default:
      return { title: t("err_generic") };
  }
}

export default function PlaygroundChat({
  apiKey,
  onApiKeyChange,
  rightPanel,
  autoLoadModels,
  audience = "admin",
  approvalsLinkTo,
  onMessageSettled,
}: PlaygroundChatProps) {
  const t = useT(playgroundStrings);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedForKeyRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function loadModels() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setModelsError(t("pasteKeyFirst"));
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await listModelsForKey(trimmed);
      loadedForKeyRef.current = trimmed;
      setModels(list);
      if (list.length > 0) setModel((prev) => prev || list[0]);
    } catch (e) {
      setModelsError(e instanceof ChatApiError ? `${e.code ?? e.status}: ${e.message}` : e instanceof Error ? e.message : "models_failed");
    } finally {
      setLoadingModels(false);
    }
  }

  // Immediate load for callers that already have a full key on mount (employee view).
  useEffect(() => {
    if (autoLoadModels && apiKey.trim() && loadedForKeyRef.current !== apiKey.trim()) {
      loadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadModels, apiKey]);

  // Debounced auto-load once the key looks complete, for admin too (docs/ux-audit.md A-7 spirit: don't wait for an explicit click).
  useEffect(() => {
    const trimmed = apiKey.trim();
    if (!KEY_COMPLETE_RE.test(trimmed) || loadedForKeyRef.current === trimmed) return;
    const timer = setTimeout(() => {
      loadModels();
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  function historyFor(msgs: DisplayMessage[]): ChatMessage[] {
    return msgs
      .filter((m): m is DisplayMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setModelsError(t("pasteKeyFirst"));
      return;
    }
    if (!model) {
      setModelsError(t("pickModelFirst"));
      return;
    }
    const userMsg: DisplayMessage = { id: nextId(), role: "user", content: text };
    const nextMsgs = [...messages, userMsg];
    const chatHistory = historyFor(nextMsgs);
    setMessages(nextMsgs);
    setInput("");
    setSending(true);
    try {
      const res = await sendChatCompletion(trimmedKey, model, chatHistory);
      const choice = res.choices?.[0];
      const assistantMsg: DisplayMessage = {
        id: nextId(),
        role: "assistant",
        content: choice?.message?.content ?? "",
        cost: res.moneyswitch?.cost,
        txHash: res.moneyswitch?.tx_hash,
        tokens: res.usage?.total_tokens,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      const err = e instanceof ChatApiError ? e : null;
      if (err && (err.code || "").toUpperCase() === "APPROVAL_REQUIRED") {
        const approvalMsg: DisplayMessage = {
          id: nextId(),
          role: "approval",
          content: t("approvalNeeded"),
          approvalId: err.approvalId,
          pendingHistory: chatHistory,
        };
        setMessages((prev) => [...prev, approvalMsg]);
      } else {
        const friendly = friendlyErrorText(t, err?.code ?? null, audience);
        const ancestorHint = err?.limitScope === "ancestor" && err.limitKeyPrefix ? t("limitScopeAncestorHint", { prefix: err.limitKeyPrefix }) : "";
        const errMsg: DisplayMessage = {
          id: nextId(),
          role: "error",
          content: (err ? friendly.title : e instanceof Error ? t("err_network") : t("err_generic")) + ancestorHint,
          rawCode: err?.code ?? (err ? String(err.status) : null),
          errLink: err ? friendly.link : undefined,
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      setSending(false);
      onMessageSettled?.();
    }
  }

  async function continueApproval(msgId: string) {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || !msg.pendingHistory) return;
    const trimmedKey = apiKey.trim();
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, resending: true } : m)));
    try {
      const res = await sendChatCompletion(trimmedKey, model, msg.pendingHistory, msg.approvalId ?? undefined);
      const choice = res.choices?.[0];
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                role: "assistant",
                content: choice?.message?.content ?? "",
                cost: res.moneyswitch?.cost,
                txHash: res.moneyswitch?.tx_hash,
                tokens: res.usage?.total_tokens,
                resending: false,
                stillWaiting: false,
              }
            : m
        )
      );
    } catch (e) {
      const err = e instanceof ChatApiError ? e : null;
      if (err && (err.code || "").toUpperCase() === "APPROVAL_REQUIRED") {
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, resending: false, stillWaiting: true, approvalId: err.approvalId ?? m.approvalId } : m))
        );
      } else {
        const friendly = friendlyErrorText(t, err?.code ?? null, audience);
        const ancestorHint = err?.limitScope === "ancestor" && err.limitKeyPrefix ? t("limitScopeAncestorHint", { prefix: err.limitKeyPrefix }) : "";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  role: "error",
                  content: (err ? friendly.title : e instanceof Error ? t("err_network") : t("err_generic")) + ancestorHint,
                  rawCode: err?.code ?? (err ? String(err.status) : null),
                  errLink: err ? friendly.link : undefined,
                  resending: false,
                }
              : m
          )
        );
      }
    } finally {
      onMessageSettled?.();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="grid-2 pg-grid">
      <div className="card pg-chat-card">
        <div className="pg-chat-toolbar">
          {onApiKeyChange ? (
            <input
              className="mono pg-key-input"
              placeholder={t("keyPlaceholder")}
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              aria-label={t("keyPlaceholder")}
            />
          ) : (
            <span className="mono wallet-chip pg-key-chip" title={apiKey}>
              {apiKey ? `${apiKey.slice(0, 12)}••••` : ""}
            </span>
          )}
          <select className="pg-model-select" value={model} onChange={(e) => setModel(e.target.value)} aria-label={t("loadModels")}>
            {models.length === 0 && <option value="">{t("noModelsYet")}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button type="button" className="btn secondary small" onClick={loadModels} disabled={loadingModels}>
            {loadingModels ? t("loading") : t("loadModels")}
          </button>
        </div>
        {modelsError && (
          <div className="error-banner" style={{ margin: "10px 14px 0" }}>
            {modelsError}
          </div>
        )}

        <div ref={scrollRef} className="pg-messages" aria-live="polite">
          {messages.length === 0 && <div className="empty-state">{t("emptyHint")}</div>}
          {messages.map((m) => (
            <div key={m.id} className={`pg-msg-row ${m.role}`}>
              <div className={`pg-bubble ${m.role}`}>
                {m.content}
                {m.role === "approval" && (
                  <div className="pg-approval-actions">
                    {m.approvalId && <span className="mono faint">{t("approvalId", { id: m.approvalId })}</span>}
                    <span>{audience === "employee" ? t("approvalWaitingEmployee") : t("approvalWaitingAdmin")}</span>
                  </div>
                )}
                {m.role === "approval" && (
                  <div className="pg-approval-actions">
                    <button type="button" className="btn small" onClick={() => continueApproval(m.id)} disabled={m.resending}>
                      {m.resending ? <Loader2 size={12} className="spin" /> : t("continueBtn")}
                    </button>
                    {audience === "admin" && approvalsLinkTo && (
                      <Link to={approvalsLinkTo} className="btn small secondary">
                        {t("goApprovals")}
                        <ExternalLink size={12} />
                      </Link>
                    )}
                  </div>
                )}
                {m.role === "approval" && m.stillWaiting && <div className="pg-bubble-code">{t("stillWaiting")}</div>}
                {m.role === "error" && (
                  <>
                    {m.errLink && <div className="pg-approval-actions">{m.errLink}</div>}
                    {m.rawCode && <div className="pg-bubble-code mono">{t("rawCodeLine", { code: m.rawCode })}</div>}
                  </>
                )}
                {m.role === "assistant" && (m.cost || m.txHash || m.tokens != null) && (
                  <div className="pg-bubble-meta num">
                    {m.cost && <>${formatUsdc(m.cost, { maxDecimals: 4 })}</>}
                    {m.txHash && (
                      <>
                        {" · "}
                        <TxLink txHash={m.txHash} />
                      </>
                    )}
                    {m.tokens != null && <> · {t("tokensLabel", { n: m.tokens })}</>}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="pg-msg-row assistant">
              <div className="pg-typing">
                <Loader2 size={14} className="spin" />
              </div>
            </div>
          )}
        </div>

        <div className="pg-input-row">
          <textarea
            rows={2}
            className="pg-textarea"
            placeholder={t("inputPlaceholder")}
            aria-label={t("inputAriaLabel")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
          />
          <button type="button" className="btn pg-send-btn" onClick={send} disabled={sending || !input.trim()}>
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {t("send")}
          </button>
        </div>
      </div>

      <div className="pg-right-panel">{rightPanel}</div>
    </div>
  );
}
