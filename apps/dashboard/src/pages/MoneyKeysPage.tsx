import React, { useEffect, useMemo, useState } from "react";
import { Plus, KeyRound } from "lucide-react";
import { usePolling } from "../usePolling";
import { listKeys, createKey, revokeKey, rotateKey, ApiError } from "../api";
import { toMicros, ratioMicros, formatUsdc } from "../money";
import Avatar from "../components/Avatar";
import Pill from "../components/Pill";
import ProgressBar from "../components/ProgressBar";
import Drawer from "../components/Drawer";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Term from "../components/Term";
import AllowedHostsField from "../components/AllowedHostsField";
import KeyHandoff from "../components/KeyHandoff";
import KeyRowActions from "../components/KeyRowActions";
import ConfirmDialog from "../components/ConfirmDialog";
import { SkeletonTable } from "../components/Skeleton";
import { useT } from "../i18n";
import { useRelativeTime } from "../i18n/format";
import { common } from "../i18n/strings/common";
import { keysStrings } from "../i18n/strings/keys";
import { skillStrings } from "../i18n/strings/skill";
import { skillBaseUrl, testPaymentAvailable, withTestHost } from "../skillText";
import { handoffFromCreated, rotateToHandoff, type Handoff } from "../keyHandoff";
import { useAdminMeta } from "../useAdminMeta";
import "../styles/keys.css";

const CALL_PRICE_MICROS = toMicros("0.01");
const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;

interface FormState {
  name: string;
  total_budget: string;
  daily_budget: string;
  per_request_limit: string;
  approval_threshold: string;
  allowed_hosts: string;
  max_payments_per_minute: string;
  expires_at: string; // yyyy-mm-dd from <input type="date">
  /** Ticked by default where the test payment is on offer (a testnet): adds the test receiver's host to the allowed hosts. */
  allow_test_endpoint: boolean;
}

function emptyForm(hosts: string): FormState {
  return {
    name: "",
    total_budget: "5",
    daily_budget: "0.50",
    per_request_limit: "0.20",
    approval_threshold: "",
    allowed_hosts: hosts,
    max_payments_per_minute: "10",
    expires_at: "",
    allow_test_endpoint: true,
  };
}

const PRESETS: Array<{ key: keyof typeof keysStrings.en; patch: Partial<FormState> }> = [
  { key: "presetTrial", patch: { daily_budget: "0.50", per_request_limit: "0.20", approval_threshold: "0.10", total_budget: "5" } },
  { key: "presetTight", patch: { daily_budget: "0.10", per_request_limit: "0.02", approval_threshold: "0.05", total_budget: "1" } },
  { key: "presetGenerous", patch: { daily_budget: "5", per_request_limit: "1", approval_threshold: "", total_budget: "50" } },
];

function isPositiveDecimal(v: string): boolean {
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) > 0;
}

function isNonNegativeDecimalOrEmpty(v: string): boolean {
  if (!v.trim()) return true;
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) >= 0;
}

/** What the Keys page shows before the first key exists: one button, the thing the owner does next (SPEC.md §2: first use is login, create the wallet, issue a key). */
export function NoKeysYet({ onCreate }: { onCreate: () => void }) {
  const t = useT(keysStrings);
  return (
    <EmptyState
      icon={<KeyRound size={28} />}
      title={t("emptyNoKeysTitle")}
      action={
        <button type="button" className="btn small" onClick={onCreate}>
          {t("actionCreateFirst")}
        </button>
      }
    >
      {t("emptyNoKeysBody")}
    </EmptyState>
  );
}

export default function MoneyKeysPage() {
  const t = useT(keysStrings);
  const ts = useT(skillStrings);
  const tc = useT(common);
  const relTime = useRelativeTime();
  const meta = useAdminMeta();
  // The ten-minute path: on a testnet the form offers the test payment endpoint (SPEC.md §0).
  const testAvailable = testPaymentAvailable(meta);

  const { data: keys, error, loading, refresh } = usePolling(listKeys);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(""));
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The secret that was just handed out (a new key, or the new secret of "Reset secret"); null while the create form is shown.
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState<string | null>(null);
  // "Reset secret and copy skill": the confirm dialog target (the new secret then becomes the handoff).
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  useEffect(() => {
    if (!revokeSuccess) return;
    const timer = setTimeout(() => setRevokeSuccess(null), 4000);
    return () => clearTimeout(timer);
  }, [revokeSuccess]);

  function openCreate() {
    setForm(emptyForm(""));
    setCreateError(null);
    setHandoff(null);
    setShowCreate(true);
  }

  function closeDrawer() {
    setShowCreate(false);
    setHandoff(null);
  }

  function applyPreset(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = t("errRequired");
    if (!isPositiveDecimal(form.daily_budget)) e.daily_budget = t("errDecimal");
    if (!isPositiveDecimal(form.per_request_limit)) e.per_request_limit = t("errDecimal");
    if (!isPositiveDecimal(form.total_budget)) e.total_budget = t("errDecimal");
    if (!isNonNegativeDecimalOrEmpty(form.approval_threshold)) e.approval_threshold = t("errDecimalOptional");
    return e;
  }, [form, t]);
  const hasErrors = Object.keys(errors).length > 0;

  const dailyMicros = toMicros(form.daily_budget);
  const totalMicros = toMicros(form.total_budget);
  const perReqMicros = toMicros(form.per_request_limit);
  const thresholdMicros = form.approval_threshold.trim() ? toMicros(form.approval_threshold) : null;
  const callsPerDay = CALL_PRICE_MICROS > 0n ? dailyMicros / CALL_PRICE_MICROS : 0n;
  const callsTotal = CALL_PRICE_MICROS > 0n ? totalMicros / CALL_PRICE_MICROS : 0n;
  const perReqBelowPrice = perReqMicros > 0n && perReqMicros < CALL_PRICE_MICROS;
  const thresholdBelowPrice = thresholdMicros !== null && thresholdMicros <= CALL_PRICE_MICROS;
  const dailyAboveTotal = dailyMicros > 0n && totalMicros > 0n && dailyMicros > totalMicros;
  const thresholdAbovePerReq = thresholdMicros !== null && perReqMicros > 0n && thresholdMicros > perReqMicros;

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (hasErrors) return;
    setCreating(true);
    setCreateError(null);
    try {
      const expiresIso = form.expires_at.trim() ? `${form.expires_at.trim()}T23:59:59.000Z` : null;
      const res = await createKey({
        name: form.name.trim(),
        total_budget: form.total_budget,
        daily_budget: form.daily_budget,
        per_request_limit: form.per_request_limit,
        approval_threshold: form.approval_threshold.trim() ? form.approval_threshold.trim() : null,
        allowed_hosts: withTestHost(form.allowed_hosts.split(","), testAvailable && form.allow_test_endpoint),
        max_payments_per_minute: form.max_payments_per_minute ? Number(form.max_payments_per_minute) : undefined,
        expires_at: expiresIso,
      });
      setHandoff(handoffFromCreated(res));
      refresh();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "create_failed");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeKey(id);
      setRevokeConfirmId(null);
      setRevokeSuccess(t("revokeSuccessText"));
      refresh();
    } catch (e) {
      setRevokeError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setRevokingId(null);
    }
  }

  async function onRotate() {
    if (!rotateTarget) return;
    setRotating(true);
    setRotateError(null);
    const outcome = await rotateToHandoff(rotateTarget.id, rotateKey);
    if (outcome.ok) {
      // The new secret replaces whatever was shown before; the old one is dead.
      setRotateTarget(null);
      setHandoff(outcome.handoff);
      setShowCreate(true);
      refresh();
    } else {
      setRotateError(ts("rotateFailed", { message: outcome.message }));
    }
    setRotating(false);
  }

  const apiBase = window.location.origin;
  const skillBase = skillBaseUrl(meta, apiBase);

  return (
    <div>
      <div className="toolbar">
        <div />
        <button className="btn" onClick={openCreate}>
          <Plus size={15} />
          {t("createKeyBtn")}
        </button>
      </div>
      <div className="keys-intro">
        {t("pageIntroPre")}
        <Term k="moneyKey">{t("pageIntroTerm")}</Term>
        {t("pageIntroPost")}
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      {revokeError && <Callout tone="error">{revokeError}</Callout>}
      {revokeSuccess && <Callout tone="success">{revokeSuccess}</Callout>}

      <div className="card">
        {loading && !keys ? (
          <SkeletonTable rows={4} cols={9} />
        ) : !keys || keys.length === 0 ? (
          <NoKeysYet onCreate={openCreate} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colAgent")}</th>
                <th>{t("colKeyPrefix")}</th>
                <th>
                  <Term k="subtreeUsage">{t("colToday")}</Term>
                </th>
                <th className="num">
                  <Term k="perRequestLimit">{t("colPerRequest")}</Term>
                </th>
                <th className="num">
                  <Term k="totalBudget">{t("colTotal")}</Term>
                </th>
                <th className="num">
                  <Term k="approvalThreshold">{t("colApproval")}</Term>
                </th>
                <th>{t("colLastUsed")}</th>
                <th>{t("colStatus")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const usedMicros = toMicros(k.used_today);
                const dMicros = toMicros(k.daily_budget);
                const r = ratioMicros(usedMicros, dMicros);
                // The server's status already accounts for a parent that was revoked or expired
                // (active / revoked / expired / ancestor_revoked / ancestor_expired).
                const status = k.status;
                const statusTone = status === "active" ? "green" : status === "expired" || status === "ancestor_expired" ? "yellow" : "red";
                const isAncestorDisabled = status === "ancestor_revoked" || status === "ancestor_expired";
                return (
                  <tr key={k.id}>
                    <td>
                      <div className="agent-row">
                        <Avatar name={k.name} size={24} />
                        <span className="agent-name">{k.name}</span>
                      </div>
                    </td>
                    <td className="mono">{k.key_prefix}••••</td>
                    <td style={{ minWidth: 130 }}>
                      <div className="num" style={{ fontSize: 12 }}>
                        {formatUsdc(k.used_today, { maxDecimals: 4 })} / {formatUsdc(k.daily_budget, { maxDecimals: 4 })}
                      </div>
                      <ProgressBar ratio={r} />
                    </td>
                    <td className="num">{formatUsdc(k.per_request_limit, { maxDecimals: 4 })}</td>
                    <td className="num">
                      {formatUsdc(k.used_total, { maxDecimals: 4 })} / {formatUsdc(k.total_budget, { maxDecimals: 4 })}
                    </td>
                    <td className="num">{k.approval_threshold ? formatUsdc(k.approval_threshold, { maxDecimals: 4 }) : t("approvalNone")}</td>
                    <td>{k.last_used_at ? relTime(k.last_used_at) : t("lastUsedNever")}</td>
                    <td>
                      {isAncestorDisabled ? (
                        <Term k={status === "ancestor_revoked" ? "ancestorRevoked" : "ancestorExpired"}>
                          <Pill tone={statusTone}>{t(`status${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof keysStrings.en)}</Pill>
                        </Term>
                      ) : (
                        <Pill tone={statusTone}>{t(`status${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof keysStrings.en)}</Pill>
                      )}
                    </td>
                    <td>
                      <KeyRowActions
                        status={k.status}
                        childrenCount={k.children_count}
                        confirmingRevoke={revokeConfirmId === k.id}
                        revoking={revokingId === k.id}
                        onRotate={() => {
                          setRotateError(null);
                          setRotateTarget({ id: k.id, name: k.name });
                        }}
                        onAskRevoke={() => setRevokeConfirmId(k.id)}
                        onRevoke={() => onRevoke(k.id)}
                        onCancelRevoke={() => setRevokeConfirmId(null)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Drawer
        open={showCreate}
        onClose={closeDrawer}
        title={handoff?.kind === "rotated" ? ts("rotateDrawerTitle") : handoff ? t("drawerTitleCreated") : t("drawerTitleCreate")}
        width={520}
      >
        {!handoff ? (
          <form onSubmit={submitCreate}>
            <div className="preset-row">
              {PRESETS.map((p) => (
                <button type="button" key={p.key} className="preset-btn" onClick={() => applyPreset(p.patch)}>
                  {t(p.key)}
                </button>
              ))}
            </div>

            <div className="field">
              <label>{t("nameLabel")}</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("namePlaceholder")} />
              <div className="field-hint">{t("nameHint")}</div>
              {errors.name && <div className="field-error">{errors.name}</div>}
            </div>

            <AllowedHostsField
              value={form.allowed_hosts}
              onChange={(allowed_hosts) => setForm({ ...form, allowed_hosts })}
              testAvailable={testAvailable}
              allowTest={form.allow_test_endpoint}
              onAllowTestChange={(allow_test_endpoint) => setForm({ ...form, allow_test_endpoint })}
            />

            <div className="sentence-form">
              {t("sentencePart1")}
              <input
                className="sentence-input"
                inputMode="decimal"
                aria-label={t("lblDaily")}
                value={form.daily_budget}
                onChange={(e) => setForm({ ...form, daily_budget: e.target.value })}
              />
              {t("sentencePart2")}
              <input
                className="sentence-input"
                inputMode="decimal"
                aria-label={t("lblPerReq")}
                value={form.per_request_limit}
                onChange={(e) => setForm({ ...form, per_request_limit: e.target.value })}
              />
              {t("sentencePart3")}
              <input
                className="sentence-input"
                inputMode="decimal"
                aria-label={t("lblThreshold")}
                placeholder="—"
                value={form.approval_threshold}
                onChange={(e) => setForm({ ...form, approval_threshold: e.target.value })}
              />
              {t("sentencePart4")}
              <input
                className="sentence-input"
                inputMode="decimal"
                aria-label={t("lblTotal")}
                value={form.total_budget}
                onChange={(e) => setForm({ ...form, total_budget: e.target.value })}
              />
              {t("sentencePart5")}
            </div>
            <div className="threshold-hint">{t("thresholdHint")}</div>
            <div className="sentence-legend">
              <Term k="dailyBudget">{t("lblDaily")}</Term>
              <Term k="perRequestLimit">{t("lblPerReq")}</Term>
              <Term k="approvalThreshold">{t("lblThreshold")}</Term>
              <Term k="totalBudget">{t("lblTotal")}</Term>
            </div>
            {(errors.daily_budget || errors.per_request_limit || errors.total_budget || errors.approval_threshold) && (
              <div className="field-error">
                {errors.daily_budget || errors.per_request_limit || errors.total_budget || errors.approval_threshold}
              </div>
            )}

            <div className="preview-box">
              <div className="preview-title">{t("previewTitle")}</div>
              <div className="preview-line num">{t("previewCallsPerDay", { n: callsPerDay.toString() })}</div>
              <div className="preview-line num">{t("previewCallsTotal", { n: callsTotal.toString() })}</div>
            </div>
            {perReqBelowPrice && (
              <div className="preview-note">
                <Callout tone="error">{t("errorPerReqBelowPrice")}</Callout>
              </div>
            )}
            {!perReqBelowPrice && thresholdBelowPrice && (
              <div className="preview-note">
                <Callout tone="warn">{t("warnThresholdBelowPrice")}</Callout>
              </div>
            )}
            {dailyAboveTotal && (
              <div className="preview-note">
                <Callout tone="warn">{t("warnDailyGtTotal")}</Callout>
              </div>
            )}
            {thresholdAbovePerReq && (
              <div className="preview-note">
                <Callout tone="warn">{t("warnThresholdGtPerReq")}</Callout>
              </div>
            )}

            <details className="advanced-details">
              <summary>{t("advancedTitle")}</summary>
              <div className="field">
                <label>
                  <Term k="rateLimit">{t("rateLimitLabel")}</Term>
                </label>
                <input value={form.max_payments_per_minute} onChange={(e) => setForm({ ...form, max_payments_per_minute: e.target.value })} />
              </div>
              <div className="field">
                <label>
                  <Term k="expiresAt">{t("expiresLabel")}</Term>
                </label>
                <input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
                <div className="field-hint">{t("expiresNever")}</div>
              </div>
            </details>

            {createError && <Callout tone="error">{createError}</Callout>}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={closeDrawer}>
                {tc("cancel")}
              </button>
              <button type="submit" className="btn" disabled={creating || hasErrors}>
                {creating ? t("submitting") : t("submitBtn")}
              </button>
            </div>
          </form>
        ) : (
          <KeyHandoff
            key={handoff.id}
            handoff={handoff}
            skillBase={skillBase}
            apiBase={apiBase}
            testnet={testAvailable}
            onDone={closeDrawer}
          />
        )}
      </Drawer>

      <ConfirmDialog
        open={rotateTarget !== null}
        title={ts("rotateTitle", { name: rotateTarget?.name ?? "" })}
        confirmLabel={rotating ? ts("rotating") : ts("rotateConfirm")}
        busy={rotating}
        error={rotateError}
        onConfirm={onRotate}
        onCancel={() => {
          setRotateTarget(null);
          setRotateError(null);
        }}
      >
        {ts("rotateBody")}
      </ConfirmDialog>
    </div>
  );
}
