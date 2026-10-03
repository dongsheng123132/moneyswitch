import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldCheck, Check, X } from "lucide-react";
import { usePolling } from "../usePolling";
import { listApprovals, approveApproval, denyApproval, listKeys, ApiError, type ApprovalRow, type MoneyKeyRow } from "../api";
import { formatUsdc, shortAddr } from "../money";
import { SkeletonBlock } from "../components/Skeleton";
import Avatar from "../components/Avatar";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Pill from "../components/Pill";
import Term from "../components/Term";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { approvalsStrings } from "../i18n/strings/approvals";
import { useRelativeTime } from "../i18n/format";
import "../styles/approvals.css";

const DECIDED_STATUS_KEY: Record<string, "statusApproved" | "statusDenied" | "statusExpired" | "statusUsed"> = {
  approved: "statusApproved",
  denied: "statusDenied",
  expired: "statusExpired",
  used: "statusUsed",
};

const DECIDED_TONE: Record<string, "green" | "red" | "gray" | "blue"> = {
  approved: "green",
  denied: "red",
  expired: "gray",
  used: "blue",
};

export type Decision = "approve" | "deny";

/** What the Approve / Deny buttons do: one authenticated call to the admin API (POST /v1/approvals/:id/approve|deny). */
export async function submitDecision(id: string, decision: Decision): Promise<"approved" | "denied"> {
  if (decision === "approve") await approveApproval(id);
  else await denyApproval(id);
  return decision === "approve" ? "approved" : "denied";
}

/** One pending request. The one the AI's link points at (?id=…) is marked and scrolled into view once. */
function ApprovalCard({
  approval: a,
  key_,
  highlight,
  acting,
  success,
  now,
  onAct,
}: {
  approval: ApprovalRow;
  key_: MoneyKeyRow | undefined;
  highlight: boolean;
  acting: boolean;
  success: "approved" | "denied" | null;
  now: number;
  onAct: (id: string, decision: Decision) => void;
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlight]);

  const keyLabel = key_?.name ?? a.key_id.slice(0, 8);
  const diffMs = new Date(a.expires_at).getTime() - now;
  const countdown =
    diffMs <= 0
      ? t("countdownExpired")
      : t("countdownLeft", { m: Math.floor(diffMs / 60_000), s: (Math.floor(diffMs / 1000) % 60).toString().padStart(2, "0") });

  return (
    <div
      className={`approval-card${highlight ? " approval-highlight" : ""}`}
      ref={ref}
      id={`approval-${a.id}`}
      data-approval-id={a.id}
      data-highlight={highlight ? "true" : undefined}
      aria-current={highlight ? "true" : undefined}
    >
      <div className="approval-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={keyLabel} size={22} />
        <span className={key_ ? undefined : "mono"}>{keyLabel}</span>
      </div>
      <div className="approval-amount num">
        {formatUsdc(a.amount, { maxDecimals: 4 })} {tc("usdc")}
      </div>
      <div className="approval-url">{a.url}</div>
      <div className="approval-meta">
        <span>{t("payTo", { addr: shortAddr(a.pay_to) })}</span>
        <span>{countdown}</span>
      </div>
      {key_ && (
        <div className="approval-key-context">
          <div>{t("keyContextUsed", { used: formatUsdc(key_.used_today, { maxDecimals: 4 }), daily: formatUsdc(key_.daily_budget, { maxDecimals: 4 }) })}</div>
          <div>
            <Term k="approvalThreshold">{t("keyContextThreshold")}</Term>:{" "}
            {key_.approval_threshold != null ? formatUsdc(key_.approval_threshold, { maxDecimals: 4 }) : tc("none")}
          </div>
          <div>
            <Term k="perRequestLimit">{t("keyContextPerRequest")}</Term>: {formatUsdc(key_.per_request_limit, { maxDecimals: 4 })}
          </div>
        </div>
      )}

      {success ? (
        <Callout tone="success">{success === "approved" ? t("successApproved") : t("successDenied")}</Callout>
      ) : (
        <div className="approval-actions">
          <button className="btn danger" disabled={acting} onClick={() => onAct(a.id, "deny")}>
            <X size={14} />
            {t("deny")}
          </button>
          <button className="btn success" disabled={acting} onClick={() => onAct(a.id, "approve")}>
            <Check size={14} />
            {t("approve")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The Approvals page for given data (split from the polling shell so it can be rendered with a given state). */
export function ApprovalsView({
  pending,
  all,
  keys,
  highlightId,
  actingId,
  successMsg,
  actionError,
  error,
  now,
  onAct,
}: {
  /** Pending requests; null while they load. */
  pending: ApprovalRow[] | null;
  /** Every request (to find the linked one when it is no longer pending, and for "recently decided"). */
  all: ApprovalRow[] | null;
  keys: MoneyKeyRow[] | null;
  /** ?id= of the link the AI sent. */
  highlightId: string | null;
  actingId: string | null;
  successMsg: { id: string; kind: "approved" | "denied" } | null;
  actionError: string | null;
  error: string | null;
  now: number;
  onAct: (id: string, decision: Decision) => void;
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();
  const keyById = useMemo(() => new Map((keys ?? []).map((k) => [k.id, k] as const)), [keys]);

  const recentlyDecided = (all ?? [])
    .filter((a) => a.status !== "pending")
    .sort((a, b) => new Date(b.decided_at ?? b.created_at).getTime() - new Date(a.decided_at ?? a.created_at).getTime())
    .slice(0, 10);

  if (pending === null && !error) {
    return (
      <div className="approval-grid">
        <div className="approval-card">
          <SkeletonBlock height={16} width={180} />
          <div style={{ height: 10 }} />
          <SkeletonBlock height={12} width={240} />
        </div>
      </div>
    );
  }

  // The request the link points at, when it is not (or no longer) in the pending list: say what became of it instead of showing nothing.
  const linkedPending = highlightId !== null && (pending ?? []).some((a) => a.id === highlightId);
  const linked = highlightId !== null && !linkedPending ? (all ?? []).find((a) => a.id === highlightId) : undefined;

  return (
    <div>
      <Callout tone="info" title={t("introTitle")}>
        {t("introBody")}
      </Callout>

      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
      {actionError && <Callout tone="error">{actionError}</Callout>}
      {/* Page-level confirmation: the decided card leaves the pending list on the next poll, so feedback must not live only inside it. */}
      {successMsg && !(pending ?? []).some((a) => a.id === successMsg.id) && (
        <Callout tone="success">{successMsg.kind === "approved" ? t("successApproved") : t("successDenied")}</Callout>
      )}
      {linked && (
        <div data-testid="linked-already">
          <Callout tone="info" title={t("linkedTitle")}>
            {t("linkedAlready", { status: t(DECIDED_STATUS_KEY[linked.status] ?? "statusExpired") })}
          </Callout>
        </div>
      )}
      {highlightId !== null && !linkedPending && !linked && all !== null && (
        <div data-testid="linked-not-found">
          <Callout tone="warn">{t("linkedNotFound")}</Callout>
        </div>
      )}

      {!pending || pending.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<ShieldCheck size={28} />}
            title={t("emptyTitle")}
            action={
              <Link className="btn small" to="/keys">
                {t("emptyAction")}
              </Link>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        </div>
      ) : (
        <div className="approval-grid">
          {pending.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              key_={keyById.get(a.key_id)}
              highlight={a.id === highlightId}
              acting={actingId === a.id}
              success={successMsg?.id === a.id ? successMsg.kind : null}
              now={now}
              onAct={onAct}
            />
          ))}
        </div>
      )}

      {recentlyDecided.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h3>{t("recentDecidedTitle")}</h3>
          </div>
          <div className="decided-list">
            {recentlyDecided.map((a) => {
              const key = keyById.get(a.key_id);
              const keyLabel = key?.name ?? a.key_id.slice(0, 8);
              const statusKey = DECIDED_STATUS_KEY[a.status] ?? "statusExpired";
              const tone = DECIDED_TONE[a.status] ?? "gray";
              return (
                <div className="decided-row" key={a.id}>
                  <Avatar name={keyLabel} size={20} />
                  <span className={key ? undefined : "mono"} style={{ flexShrink: 0 }}>
                    {keyLabel}
                  </span>
                  <span className="num">{formatUsdc(a.amount, { maxDecimals: 4 })}</span>
                  <Pill tone={tone}>{t(statusKey)}</Pill>
                  <span className="dim" style={{ marginLeft: "auto" }}>
                    {relTime(a.decided_at ?? a.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("id");
  const { data: pending, error, refresh } = usePolling(() => listApprovals("pending"));
  const { data: all } = usePolling(() => listApprovals());
  const { data: keys } = usePolling(listKeys);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<{ id: string; kind: "approved" | "denied" } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!successMsg) return;
    const id = setTimeout(() => setSuccessMsg(null), 4000);
    return () => clearTimeout(id);
  }, [successMsg]);

  async function act(id: string, decision: Decision) {
    setActingId(id);
    setActionError(null);
    try {
      setSuccessMsg({ id, kind: await submitDecision(id, decision) });
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : `${decision}_failed`);
    } finally {
      setActingId(null);
    }
  }

  return (
    <ApprovalsView
      pending={pending}
      all={all}
      keys={keys}
      highlightId={highlightId}
      actingId={actingId}
      successMsg={successMsg}
      actionError={actionError}
      error={error}
      now={now}
      onAct={act}
    />
  );
}
