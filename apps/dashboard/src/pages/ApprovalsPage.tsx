import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldCheck, Check, X } from "lucide-react";
import { usePolling } from "../usePolling";
import {
  listApprovals,
  approveApproval,
  denyApproval,
  getApprovalByLink,
  decideWithPin,
  listKeys,
  ApiError,
  type AdminMeta,
  type ApprovalLink,
  type ApprovalRow,
  type MoneyKeyRow,
} from "../api";
import { useAdminMeta } from "../useAdminMeta";
import { loginUrlFor } from "../authRedirect";
import { PIN_MAX_FAILURES, PIN_RE } from "../approvalPin";
import { formatUsdc, shortAddr } from "../money";
import { SkeletonBlock } from "../components/Skeleton";
import Avatar from "../components/Avatar";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import LangSwitch from "../components/LangSwitch";
import Pill from "../components/Pill";
import NetworkKindPill from "../components/NetworkKindPill";
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

/** The text under the cards when Approve / Deny fails. The two refusals of a new host's DNS look (SPEC.md §3) are said in the page's own language. */
export function decisionErrorMessage(e: unknown, decision: Decision, t: (key: "errHostPrivate" | "errHostUnresolved") => string): string {
  if (e instanceof ApiError && e.error === "ALLOW_HOST_PRIVATE_HOST") return t("errHostPrivate");
  if (e instanceof ApiError && e.error === "ALLOW_HOST_UNRESOLVED") return t("errHostUnresolved");
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : `${decision}_failed`;
}

/**
 * What a request is: which key asks, for what (the price, or the new host), on which chain, from which URL, and how long it stands. Shared by the
 * administrator's cards and the approval link (SPEC.md §3), so both say it the same way.
 */
function ApprovalSummary({
  approval: a,
  keyLabel,
  keyKnown,
  now,
  chainLabel,
}: {
  approval: Pick<ApprovalRow, "kind" | "host" | "amount" | "network_kind" | "url" | "pay_to" | "expires_at">;
  keyLabel: string;
  /** false = the label is only the start of a key id (the key's name is not known to this page), so it is set in monospace. */
  keyKnown: boolean;
  now: number;
  /** The name of the chain the price is on (CAIP-2 when the server does not list it any more). */
  chainLabel: string;
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  // A request to a host outside the key's list (SPEC.md §3): no price yet, so the host:port stands where the amount does. The server
  // computes it (the value approving adds to the list); the page only shows it.
  const isHost = a.kind === "host";
  const hostPort = a.host ?? "";
  const diffMs = new Date(a.expires_at).getTime() - now;
  const countdown =
    diffMs <= 0
      ? t("countdownExpired")
      : t("countdownLeft", { m: Math.floor(diffMs / 60_000), s: (Math.floor(diffMs / 1000) % 60).toString().padStart(2, "0") });
  return (
    <>
      <div className="approval-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={keyLabel} size={22} />
        <span className={keyKnown ? undefined : "mono"}>{keyLabel}</span>
      </div>
      {isHost ? (
        <div className="approval-host" data-testid="host-approval">
          <Pill tone="blue">{t("hostBadge")}</Pill>
          <span className="mono">{hostPort}</span>
        </div>
      ) : (
        <div className="approval-amount num">
          {formatUsdc(a.amount, { maxDecimals: 4 })} {tc("usdc")}
        </div>
      )}
      {!isHost && (
        <div className="approval-chain" data-testid="approval-chain">
          <span>{chainLabel}</span> <NetworkKindPill kind={a.network_kind} />
        </div>
      )}
      <div className="approval-url">
        {isHost && <span className="dim">{t("hostSource")} </span>}
        {a.url}
      </div>
      {isHost && <div className="approval-host-note">{t("hostNote", { host: hostPort })}</div>}
      <div className="approval-meta">
        {!isHost && <span>{t("payTo", { addr: shortAddr(a.pay_to) })}</span>}
        <span>{countdown}</span>
      </div>
    </>
  );
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
  chainLabel,
}: {
  approval: ApprovalRow;
  key_: MoneyKeyRow | undefined;
  highlight: boolean;
  acting: boolean;
  success: "approved" | "denied" | null;
  now: number;
  onAct: (id: string, decision: Decision) => void;
  /** The name of the chain the price is on (CAIP-2 when the server does not list it any more). */
  chainLabel: string;
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlight]);

  return (
    <div
      className={`approval-card${highlight ? " approval-highlight" : ""}`}
      ref={ref}
      id={`approval-${a.id}`}
      data-approval-id={a.id}
      data-highlight={highlight ? "true" : undefined}
      aria-current={highlight ? "true" : undefined}
    >
      <ApprovalSummary approval={a} keyLabel={key_?.name ?? a.key_id.slice(0, 8)} keyKnown={Boolean(key_)} now={now} chainLabel={chainLabel} />
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
  networks,
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
  /** The chains the server enables (GET /v1/admin/meta), for the chain names. */
  networks?: AdminMeta["networks"];
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();
  const chainLabels = useMemo(() => new Map((networks ?? []).map((n) => [n.network, n.network_label] as const)), [networks]);
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
              chainLabel={chainLabels.get(a.network) ?? a.network}
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
                  {a.kind === "host" ? (
                    <span className="mono">{a.host}</span>
                  ) : (
                    <span className="num">{formatUsdc(a.amount, { maxDecimals: 4 })}</span>
                  )}
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
  const t = useT(approvalsStrings);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("id");
  const { data: pending, error, refresh } = usePolling(() => listApprovals("pending"));
  const { data: all } = usePolling(() => listApprovals());
  const { data: keys } = usePolling(listKeys);
  const meta = useAdminMeta();
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
      setActionError(decisionErrorMessage(e, decision, t));
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
      networks={meta?.networks}
    />
  );
}

// ---------------------------------------------------------------------------
// The approval link for the person who holds the key (SPEC.md §3): no login, the one request, and the key's PIN
// ---------------------------------------------------------------------------

export { PIN_RE }; // (4 to 6 digits: the server checks it too)

type ApprovalsKey = keyof typeof approvalsStrings.en;

/** The text under the PIN form when the server refuses (SPEC.md §3), in the page's language; a new host's DNS refusals fall back to decisionErrorMessage. */
export function pinErrorMessage(e: unknown, decision: Decision, t: (key: ApprovalsKey, vars?: Record<string, string | number>) => string): string {
  if (e instanceof ApiError) {
    switch (e.error) {
      case "APPROVAL_PIN_WRONG":
        return t("pinWrong", { n: e.attemptsLeft ?? 0 });
      case "APPROVAL_PIN_LOCKED":
        return t("pinLocked");
      case "APPROVAL_PIN_NOT_SET":
        return t("pinNotSet");
      case "APPROVAL_PIN_INVALID":
        return t("pinFormat");
      case "APPROVAL_KEY_NOT_ACTIVE":
        return t("keyNotActive");
      case "APPROVAL_NOT_PENDING":
        return t("alreadyHandled");
    }
  }
  return decisionErrorMessage(e, decision, t);
}

/** The approval link's page for given data (split from the polling shell so it can be rendered with a given state). */
export function ApprovalLinkView({
  approval,
  error,
  now,
  pin,
  onPinChange,
  acting,
  outcome,
  actionError,
  onDecide,
  loginHref,
  origin,
}: {
  /** The request the link points at; null while it loads. */
  approval: ApprovalLink | null;
  error: string | null;
  now: number;
  pin: string;
  onPinChange: (pin: string) => void;
  acting: boolean;
  /** What this visitor just did (the page says so at once, before the next poll shows the new status). */
  outcome: "approved" | "denied" | null;
  actionError: string | null;
  onDecide: (decision: Decision) => void;
  /** Where the administrator signs in to come back to this request. */
  loginHref: string;
  /** The address this page was opened at (window.location.origin): shown above the PIN field, so a person can see it is the right site. */
  origin: string;
}) {
  const t = useT(approvalsStrings);
  const tc = useT(common);
  const notFound = error === "not_found";
  const validPin = PIN_RE.test(pin);

  let footer: React.ReactNode = null;
  if (approval) {
    if (outcome) {
      footer = <Callout tone="success">{outcome === "approved" ? t("successApproved") : t("successDenied")}</Callout>;
    } else if (approval.status !== "pending") {
      footer = (
        <div data-testid="linked-already">
          <Callout tone="info" title={t("linkedTitle")}>
            {t("linkedAlready", { status: t(DECIDED_STATUS_KEY[approval.status] ?? "statusExpired") })}
          </Callout>
        </div>
      );
    } else if (approval.pin_state === "none") {
      footer = (
        <div data-testid="pin-not-set">
          <Callout tone="warn">{t("pinNotSet")}</Callout>
        </div>
      );
    } else if (approval.pin_state === "locked") {
      footer = (
        <div data-testid="pin-locked">
          <Callout tone="warn">{t("pinLocked")}</Callout>
        </div>
      );
    } else {
      footer = (
        // (no implicit submit: Enter in the field decides nothing, so a deny is never an approve by a stray key)
        <form onSubmit={(e) => e.preventDefault()} noValidate>
          <div data-testid="pin-warning">
            <Callout tone="warn">
              {t("pinWarning")}
              <div className="mono" data-testid="pin-origin">
                {t("pinOrigin", { origin })}
              </div>
            </Callout>
          </div>
          {approval.pin_failures > 0 && (
            <div data-testid="pin-failures">
              <Callout tone="warn">{t("pinFailures", { n: approval.pin_failures, max: PIN_MAX_FAILURES })}</Callout>
            </div>
          )}
          <div className="field">
            <label htmlFor="approval-pin">{t("pinLabel")}</label>
            <input
              id="approval-pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="off"
              spellCheck={false}
              value={pin}
              onChange={(e) => onPinChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("pinPlaceholder")}
            />
            <div className="field-hint">{t("pinHint")}</div>
          </div>
          {actionError && <Callout tone="error">{actionError}</Callout>}
          <div className="approval-actions">
            <button type="button" className="btn danger" disabled={acting || !validPin} onClick={() => onDecide("deny")}>
              <X size={14} />
              {t("deny")}
            </button>
            <button type="button" className="btn success" disabled={acting || !validPin} onClick={() => onDecide("approve")}>
              <Check size={14} />
              {t("approve")}
            </button>
          </div>
        </form>
      );
    }
  }

  return (
    <div className="login-shell">
      <div className="login-topright">
        <LangSwitch />
      </div>
      <div className="login-stack">
        <div className="card login-card">
          <div className="login-brand">
            <div className="brand-mark">M</div>
            <div>
              <h1>MoneySwitch</h1>
            </div>
          </div>
          <p className="login-tagline">{t("linkLead")}</p>
          {error && !notFound && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
          {notFound && (
            <div data-testid="linked-not-found">
              <Callout tone="warn">{t("linkedNotFound")}</Callout>
            </div>
          )}
          {!approval && !error && (
            <div className="approval-card">
              <SkeletonBlock height={16} width={180} />
              <div style={{ height: 10 }} />
              <SkeletonBlock height={12} width={240} />
            </div>
          )}
          {approval && (
            <div className="approval-card" data-approval-id={approval.id} data-testid="approval-link-card">
              <ApprovalSummary
                approval={approval}
                keyLabel={approval.key_name ?? "—"}
                keyKnown
                now={now}
                chainLabel={approval.network_label ?? approval.network}
              />
              {footer}
            </div>
          )}
          <div className="login-footnote">
            <Link to={loginHref}>{t("adminSignIn")}</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** /approvals?id=… without a login: the request and the PIN form. The administrator signs in instead, and gets the Approvals page. */
export function ApprovalLinkPage() {
  const t = useT(approvalsStrings);
  const [searchParams] = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { data: approval, error, refresh } = usePolling(() => getApprovalByLink(id), 5000);
  const [pin, setPin] = useState("");
  const [acting, setActing] = useState(false);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function decide(decision: Decision) {
    setActing(true);
    setActionError(null);
    try {
      await decideWithPin(id, decision, pin);
      setOutcome(decision === "approve" ? "approved" : "denied");
    } catch (e) {
      setActionError(pinErrorMessage(e, decision, t));
    } finally {
      setPin(""); // a wrong PIN is typed again, never resubmitted as it was
      setActing(false);
      refresh(); // (a locked PIN, a request decided meanwhile, ...: the page shows what is true now)
    }
  }

  return (
    <ApprovalLinkView
      approval={approval}
      error={error}
      now={now}
      pin={pin}
      onPinChange={setPin}
      acting={acting}
      outcome={outcome}
      actionError={actionError}
      onDecide={decide}
      loginHref={loginUrlFor("/approvals", `?id=${encodeURIComponent(id)}`)}
      origin={window.location.origin}
    />
  );
}
