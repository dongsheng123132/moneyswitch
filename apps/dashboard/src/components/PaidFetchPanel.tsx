import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Eye, EyeOff, ExternalLink, Loader2 } from "lucide-react";
import { paidFetch, ApiError, PaidFetchResponse, PaidFetchInput } from "../api";
import { formatUsdc } from "../money";
import { useT, TFunction } from "../i18n";
import { playgroundStrings } from "../i18n/strings/playground";
import { useKeyInputGuard } from "./KeyInputGuard";
import SecretNotice from "./SecretNotice";
import TxLink from "./TxLink";
import "../styles/playground.css";

type PgStrings = TFunction<keyof typeof playgroundStrings.en>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

const RESPONSE_BODY_CAP = 20_000;

function hostPort(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return urlStr;
  }
}

/** Maps a paid-fetch denial/error code to a friendly sentence (SPEC-v0.5.md §3). */
function deniedText(t: PgStrings, code: string | null, url: string): string {
  switch ((code || "").toUpperCase()) {
    case "HOST_NOT_ALLOWED":
      return t("fetchErr_HOST_NOT_ALLOWED", { host: hostPort(url) });
    case "SSRF_BLOCKED":
      return t("fetchErr_SSRF_BLOCKED");
    case "PER_REQUEST_LIMIT_EXCEEDED":
      return t("err_perRequest");
    case "DAILY_BUDGET_EXCEEDED":
      return t("err_dailyBudget");
    case "TOTAL_BUDGET_EXCEEDED":
      return t("err_totalBudget");
    case "MAX_PRICE_EXCEEDED":
      return t("fetchErr_MAX_PRICE_EXCEEDED");
    case "RATE_LIMITED":
      return t("err_rateLimited");
    case "UNSUPPORTED_PAYMENT":
      return t("fetchErr_UNSUPPORTED_PAYMENT");
    default:
      return t("fetchErr_generic", { code: code ?? "" });
  }
}

function prettyBody(body: string | null): string {
  if (!body) return "";
  let out = body;
  try {
    out = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // not JSON — show as-is
  }
  return out.length > RESPONSE_BODY_CAP ? out.slice(0, RESPONSE_BODY_CAP) : out;
}

export interface PaidFetchPanelProps {
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  initialUrl?: string;
  initialMethod?: string;
  /** Key status card shown on the right (same as the chat tab). */
  rightPanel?: React.ReactNode;
  /** Called after every completed request so the status card can refresh. */
  onDone?: () => void;
}

export default function PaidFetchPanel({ apiKey, onApiKeyChange, initialUrl, initialMethod, rightPanel, onDone }: PaidFetchPanelProps) {
  const t = useT(playgroundStrings);
  const guard = useKeyInputGuard();
  const [showKey, setShowKey] = useState(false);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [method, setMethod] = useState<Method>((initialMethod as Method) && METHODS.includes(initialMethod as Method) ? (initialMethod as Method) : "GET");
  const [bodyText, setBodyText] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PaidFetchResponse | null>(null);
  const [thrownError, setThrownError] = useState<ApiError | null>(null);
  const [lastInput, setLastInput] = useState<PaidFetchInput | null>(null);

  const trimmedKey = apiKey.trim();

  async function run(input: PaidFetchInput) {
    setSending(true);
    setFormError(null);
    setThrownError(null);
    try {
      const res = await paidFetch(trimmedKey, input);
      setResult(res);
      setLastInput(input);
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError) setThrownError(e);
      else setFormError(e instanceof Error ? e.message : "request_failed");
    } finally {
      setSending(false);
      onDone?.();
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedKey) {
      setFormError(t("fetchKeyRequired"));
      return;
    }
    if (!url.trim()) {
      setFormError(t("fetchUrlRequired"));
      return;
    }
    let body: unknown;
    if (method !== "GET" && bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        setBodyError(t("fetchBodyInvalidJson"));
        return;
      }
    }
    setBodyError(null);
    await run({ url: url.trim(), method, ...(body !== undefined ? { body } : {}) });
  }

  async function continueWithApproval(approvalId: string) {
    if (!lastInput) return;
    await run({ ...lastInput, approval_id: approvalId });
  }

  const showBodyField = method !== "GET";

  return (
    <div className="grid-2 pg-grid">
      <div className="card pg-fetch-card">
        <form onSubmit={submit} className="pg-fetch-form">
          <p className="stat-sub" style={{ marginTop: 0 }}>
            {t("fetchIntro")}
          </p>

          <SecretNotice compact>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t("fetchKeyLabel")}</label>
              <div className="input-with-action">
                <input
                  className="mono"
                  type={showKey ? "text" : "password"}
                  placeholder={t("keyPlaceholder")}
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(guard.filter(e.target.value))}
                  aria-label={t("fetchKeyLabel")}
                />
                <button
                  type="button"
                  className="input-action"
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? t("fetchKeyHide") : t("fetchKeyShow")}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {guard.message}
            </div>
          </SecretNotice>

          <div className="field">
            <label>{t("fetchUrlLabel")}</label>
            <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("fetchUrlPlaceholder")} />
          </div>

          <div className="field">
            <label>{t("fetchMethodLabel")}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {showBodyField && (
            <div className="field">
              <label>{t("fetchBodyLabel")}</label>
              <textarea
                rows={4}
                className="mono"
                value={bodyText}
                onChange={(e) => {
                  setBodyText(e.target.value);
                  setBodyError(null);
                }}
                placeholder={t("fetchBodyPlaceholder")}
              />
              {bodyError && <div className="field-error">{bodyError}</div>}
            </div>
          )}

          {formError && <div className="error-banner">{formError}</div>}

          <button type="submit" className="btn" disabled={sending}>
            {sending ? (
              <>
                <Loader2 size={14} className="spin" /> {t("fetchSubmitting")}
              </>
            ) : (
              t("fetchSubmitBtn")
            )}
          </button>
        </form>

        <PaidFetchResult
          t={t}
          url={url}
          result={result}
          thrownError={thrownError}
          onContinueApproval={continueWithApproval}
          resending={sending}
        />
      </div>

      <div className="pg-right-panel">
        {rightPanel ?? (
          <div className="card">
            <div className="card-header">
              <h3>{t("keyStatusTitle")}</h3>
            </div>
            <div className="empty-state">{t("fetchKeyStatusEmptyHint")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function PaidFetchResult({
  t,
  url,
  result,
  thrownError,
  onContinueApproval,
  resending,
}: {
  t: PgStrings;
  url: string;
  result: PaidFetchResponse | null;
  thrownError: ApiError | null;
  onContinueApproval: (approvalId: string) => void;
  resending: boolean;
}) {
  const bodyPretty = useMemo(() => prettyBody(result?.body ?? null), [result?.body]);
  const truncated = (result?.body?.length ?? 0) > RESPONSE_BODY_CAP;

  if (!result && !thrownError) return null;

  return (
    <div className="pg-fetch-result">
      <div className="card-header">
        <h3>{t("fetchResultTitle")}</h3>
      </div>

      {thrownError && <ThrownErrorBanner err={thrownError} t={t} />}

      {result && (
        <div>
          {result.status === "ok" && result.payment && (
            <div className="callout callout-success" role="status">
              <div className="callout-body">
                <div className="callout-text">
                  {t("fetchResultPaid", { amount: formatUsdc(result.payment.amount, { maxDecimals: 4 }), status: result.http_status ?? "" })}{" "}
                  {result.payment.tx_hash && <TxLink txHash={result.payment.tx_hash} mock={result.payment.mock} />}
                </div>
              </div>
            </div>
          )}
          {result.status === "ok" && !result.payment && (result.http_status ?? 0) < 400 && (
            <div className="callout callout-info" role="status">
              <div className="callout-body">
                <div className="callout-text">{t("fetchResultFree", { status: result.http_status ?? "" })}</div>
              </div>
            </div>
          )}
          {result.status === "ok" && !result.payment && (result.http_status ?? 0) >= 400 && (
            <div className="callout callout-warn" role="status">
              <div className="callout-body">
                <div className="callout-text">{t("fetchResultUpstreamError", { status: result.http_status ?? "" })}</div>
              </div>
            </div>
          )}
          {result.status === "denied" && (
            <div className="callout callout-error" role="alert">
              <div className="callout-body">
                <div className="callout-text">{deniedText(t, result.code, url)}</div>
              </div>
            </div>
          )}
          {result.status === "payment_failed" && (
            <div className="callout callout-error" role="alert">
              <div className="callout-body">
                <div className="callout-text">{t("fetchResultPaymentFailed")}</div>
              </div>
            </div>
          )}
          {result.status === "approval_required" && result.approval_id && (
            <div className="callout callout-warn" role="status">
              <div className="callout-body">
                <div className="callout-text">{t("fetchApprovalRequired", { id: result.approval_id })}</div>
                <div className="pg-approval-actions">
                  <Link to="/approvals" className="btn small secondary">
                    {t("fetchApprovalGoApprovals")}
                    <ExternalLink size={12} />
                  </Link>
                  <button type="button" className="btn small" disabled={resending} onClick={() => onContinueApproval(result.approval_id as string)}>
                    {resending ? <Loader2 size={12} className="spin" /> : t("fetchApprovalContinue")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {result.status === "error" && <FetchErrorCallout t={t} code={result.code} />}

          <div className="stat-sub" style={{ marginTop: 10 }}>
            {t("fetchRemainingToday", { amount: formatUsdc(result.remaining_today, { maxDecimals: 4 }) })}
          </div>

          {result.body != null && (
            <div className="form-section" style={{ marginTop: 14 }}>
              <div className="form-section-title">{t("fetchResponseBodyTitle")}</div>
              <pre className="pg-fetch-response mono">{bodyPretty}</pre>
              {truncated && <div className="field-hint">{t("fetchResponseBodyTruncated")}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FetchErrorCallout({ t, code }: { t: PgStrings; code: string | null }) {
  const upper = (code || "").toUpperCase();
  if (upper === "WALLET_LOCKED") {
    return (
      <div className="callout callout-error" role="alert">
        <div className="callout-body">
          <div className="callout-text">{t("fetchErr_WALLET_LOCKED")}</div>
          <div className="pg-approval-actions">
            <Link to="/wallet" className="btn small secondary">
              {t("walletPageLink")}
              <ExternalLink size={12} />
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="callout callout-error" role="alert">
      <div className="callout-body">
        <div className="callout-text">{t("fetchErr_generic", { code: upper })}</div>
      </div>
    </div>
  );
}

function ThrownErrorBanner({ err, t }: { err: ApiError; t: PgStrings }) {
  const upper = (err.code || "").toUpperCase();
  if (upper === "KEY_INVALID") {
    const isAddress = (err.reason || "").toUpperCase() === "LOOKS_LIKE_ADDRESS";
    return (
      <div className="callout callout-error" role="alert">
        <div className="callout-body">
          <div className="callout-text">{isAddress ? t("fetchErr_KEY_INVALID_ADDRESS") : t("fetchErr_KEY_INVALID_generic")}</div>
        </div>
      </div>
    );
  }
  if (upper === "WALLET_LOCKED") {
    return (
      <div className="callout callout-error" role="alert">
        <div className="callout-body">
          <div className="callout-text">{t("fetchErr_WALLET_LOCKED")}</div>
          <div className="pg-approval-actions">
            <Link to="/wallet" className="btn small secondary">
              {t("walletPageLink")}
              <ExternalLink size={12} />
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="callout callout-error" role="alert">
      <div className="callout-body">
        <div className="callout-text">{t("fetchErr_generic", { code: err.code ?? String(err.status) })}</div>
      </div>
    </div>
  );
}
