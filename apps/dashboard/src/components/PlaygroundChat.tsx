import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Loader2, ExternalLink } from "lucide-react";
import { listModelsForKey, sendChatCompletion, ChatApiError, ChatMessage } from "../api";
import { formatUsdc } from "../money";

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system-error";
  content: string;
  cost?: string;
  txHash?: string;
  tokens?: number;
  approvalId?: string | null;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${seq}`;
}

export interface PlaygroundChatLabels {
  keyPlaceholder: string;
  loadModels: string;
  loading: string;
  noModelsYet: string;
  emptyHint: string;
  inputPlaceholder: string;
  send: string;
  pasteKeyFirst: string;
  pickModelFirst: string;
  waitingApproval: string;
  goApprovals: string;
}

const DEFAULT_LABELS: PlaygroundChatLabels = {
  keyPlaceholder: "mk_live_… (stored only in this browser tab)",
  loadModels: "Load models",
  loading: "Loading...",
  noModelsYet: "No models loaded",
  emptyHint: "Paste a Money Key, load models, and start chatting. Every message is a real x402 payment.",
  inputPlaceholder: "Message the model — Enter to send, Shift+Enter for newline",
  send: "Send",
  pasteKeyFirst: "Paste a Money Key first.",
  pickModelFirst: "Pick a model first.",
  waitingApproval: "Waiting for approval",
  goApprovals: "Go to Approvals",
};

interface PlaygroundChatProps {
  apiKey: string;
  onApiKeyChange?: (v: string) => void;
  rightPanel: React.ReactNode;
  autoLoadModels?: boolean;
  labels?: Partial<PlaygroundChatLabels>;
  approvalsLinkTo?: string;
  /** Called after every send attempt (success or failure) so the caller can refresh its own "key status" panel data. */
  onMessageSettled?: () => void;
}

export default function PlaygroundChat({
  apiKey,
  onApiKeyChange,
  rightPanel,
  autoLoadModels,
  labels: labelsOverride,
  approvalsLinkTo,
  onMessageSettled,
}: PlaygroundChatProps) {
  const labels = { ...DEFAULT_LABELS, ...labelsOverride };
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function loadModels() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setModelsError(labels.pasteKeyFirst);
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await listModelsForKey(trimmed);
      setModels(list);
      if (list.length > 0) setModel((prev) => prev || list[0]);
    } catch (e) {
      setModelsError(e instanceof ChatApiError ? `${e.code ?? e.status}: ${e.message}` : e instanceof Error ? e.message : "models_failed");
    } finally {
      setLoadingModels(false);
    }
  }

  useEffect(() => {
    if (autoLoadModels && apiKey.trim() && !autoLoadedRef.current) {
      autoLoadedRef.current = true;
      loadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadModels, apiKey]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setModelsError(labels.pasteKeyFirst);
      return;
    }
    if (!model) {
      setModelsError(labels.pickModelFirst);
      return;
    }
    const userMsg: DisplayMessage = { id: nextId(), role: "user", content: text };
    const chatHistory: ChatMessage[] = [...messages, userMsg]
      .filter((m): m is DisplayMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg]);
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
      const errMsg: DisplayMessage = {
        id: nextId(),
        role: "system-error",
        content: err ? `${err.code ?? err.status}: ${err.message}` : e instanceof Error ? e.message : "request_failed",
        approvalId: err?.approvalId ?? null,
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setSending(false);
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
    <div className="grid-2" style={{ alignItems: "stretch" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 150px)", padding: 0, overflow: "hidden" }}>
        <div style={{ padding: 14, borderBottom: "1px solid var(--panel-border-soft)", display: "flex", gap: 10, flexWrap: "wrap" }}>
          {onApiKeyChange ? (
            <input
              className="mono"
              style={{ flex: "1 1 260px", background: "var(--bg)", border: "1px solid var(--panel-border)", borderRadius: 7, padding: "7px 10px", color: "var(--text)", fontSize: 12.5 }}
              placeholder={labels.keyPlaceholder}
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
            />
          ) : (
            <span
              className="mono wallet-chip"
              style={{ flex: "1 1 260px", justifyContent: "flex-start" }}
              title={apiKey}
            >
              {apiKey ? `${apiKey.slice(0, 12)}••••` : ""}
            </span>
          )}
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ minWidth: 180 }}>
            {models.length === 0 && <option value="">{labels.noModelsYet}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button type="button" className="btn secondary small" onClick={loadModels} disabled={loadingModels}>
            {loadingModels ? labels.loading : labels.loadModels}
          </button>
        </div>
        {modelsError && (
          <div className="error-banner" style={{ margin: "10px 14px 0" }}>
            {modelsError}
          </div>
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.length === 0 && <div className="empty-state">{labels.emptyHint}</div>}
          {messages.map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div
                style={{
                  maxWidth: "78%",
                  padding: "9px 13px",
                  borderRadius: 12,
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background: m.role === "user" ? "var(--accent)" : m.role === "system-error" ? "var(--red-bg)" : "var(--panel-2)",
                  color: m.role === "user" ? "#fff" : m.role === "system-error" ? "var(--red)" : "var(--text)",
                  border: m.role === "assistant" ? "1px solid var(--panel-border)" : "none",
                }}
              >
                {m.content}
                {m.role === "system-error" && m.approvalId && approvalsLinkTo && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 650, marginBottom: 4 }}>{labels.waitingApproval}</div>
                    <Link to={approvalsLinkTo} className="btn small secondary">
                      {labels.goApprovals}
                      <ExternalLink size={12} />
                    </Link>
                  </div>
                )}
                {m.role === "assistant" && (m.cost || m.txHash || m.tokens != null) && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-faint)" }} className="num">
                    {m.cost && <>${formatUsdc(m.cost, { maxDecimals: 4 })}</>}
                    {m.txHash && (
                      <>
                        {" · tx "}
                        <a href={`https://testnet.monadvision.com/tx/${m.txHash}`} target="_blank" rel="noreferrer">
                          {m.txHash.slice(0, 8)}…{m.txHash.slice(-4)} ↗
                        </a>
                      </>
                    )}
                    {m.tokens != null && <> · {m.tokens} tokens</>}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div style={{ padding: "9px 13px", borderRadius: 12, background: "var(--panel-2)", border: "1px solid var(--panel-border)" }}>
                <Loader2 size={14} className="spin" />
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: 12, borderTop: "1px solid var(--panel-border-soft)", display: "flex", gap: 8 }}>
          <textarea
            rows={2}
            style={{ flex: 1, resize: "none", background: "var(--bg)", border: "1px solid var(--panel-border)", borderRadius: 8, padding: "8px 10px", color: "var(--text)", fontSize: 13, fontFamily: "inherit" }}
            placeholder={labels.inputPlaceholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
          />
          <button type="button" className="btn" onClick={send} disabled={sending || !input.trim()} style={{ alignSelf: "flex-end" }}>
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {labels.send}
          </button>
        </div>
      </div>

      {rightPanel}
    </div>
  );
}
