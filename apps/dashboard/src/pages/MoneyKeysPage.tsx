import React, { useEffect, useMemo, useState } from "react";
import { Plus, KeyRound, Search } from "lucide-react";
import { usePolling } from "../usePolling";
import { listKeys, createKey, revokeKey, rotateKey, setApprovalPin, ApiError, type NetworkMode } from "../api";
import { toMicros, ratioMicros, formatUsdc } from "../money";
import Avatar from "../components/Avatar";
import Pill from "../components/Pill";
import { pinProblem } from "../approvalPin";
import ApprovalPinField from "../components/ApprovalPinField";
import ApprovalPinNotice from "../components/ApprovalPinNotice";
import KeyNetworkBadge from "../components/KeyNetworkBadge";
import KeyPinState from "../components/KeyPinState";
import NetworkModeField from "../components/NetworkModeField";
import ProgressBar from "../components/ProgressBar";
import KeyDialog from "../components/KeyDialog";
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
import { effectiveNetworkMode, enabledNetworkKinds, realMoneyConfirmed } from "../networkMode";
import "../styles/keys.css";

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
  /** Ticked by default where the test payment is on offer (a testnet key): adds the test receiver's host to the allowed hosts. */
  allow_test_endpoint: boolean;
  /** The kind of chain the key pays on; null = not chosen yet, which is the one kind the instance enables, else the testnet. */
  network_mode: NetworkMode | null;
  /** A mainnet key must be confirmed: it spends real money. */
  confirm_real_money: boolean;
  /** The approval PIN for the person who holds the key (SPEC.md §3): 4-6 digits, or empty for a random one. */
  approval_pin: string;
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
    network_mode: null,
    confirm_real_money: false,
    approval_pin: "",
  };
}

const PRESETS: Array<{ key: keyof typeof keysStrings.en; patch: Partial<FormState> }> = [
  { key: "presetTrial", patch: { daily_budget: "0.50", per_request_limit: "0.20", approval_threshold: "0.10", total_budget: "5" } },
  { key: "presetTight", patch: { daily_budget: "0.10", per_request_limit: "0.02", approval_threshold: "0.01", total_budget: "1" } },
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

  const { data: keys, error, loading, refresh } = usePolling(listKeys);

  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
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
  // "Set confirmation code" (the key's approval PIN, SPEC.md §3): the dialog target and what it typed, then the new PIN shown once.
  const [pinTarget, setPinTarget] = useState<{ id: string; name: string } | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinSetting, setPinSetting] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinNotice, setPinNotice] = useState<{ name: string; pin: string } | null>(null);
  // The network type the form is on (SPEC.md §2): only the kinds the instance enables are offered, the testnet first.
  const kinds = enabledNetworkKinds(meta);
  const networkMode = effectiveNetworkMode(kinds, form.network_mode);
  // The ten-minute path: a testnet key's form offers the test payment endpoint (SPEC.md §0); a mainnet key's never does.
  const testAvailable = testPaymentAvailable(meta, networkMode);
  const chainLabels = new Map((meta?.networks ?? []).map((n) => [n.network, n.network_label] as const));
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
    if (creating) return;
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
    if (!e.approval_threshold && !e.per_request_limit && form.approval_threshold.trim() && toMicros(form.approval_threshold) > toMicros(form.per_request_limit)) {
      e.approval_threshold = t("warnThresholdGtPerReq");
    }
    if (!/^\d+$/.test(form.max_payments_per_minute) || !Number.isSafeInteger(Number(form.max_payments_per_minute)) || Number(form.max_payments_per_minute) < 1) {
      e.max_payments_per_minute = t("errRateLimit");
    }
    if (!realMoneyConfirmed(networkMode, form.confirm_real_money)) e.confirm_real_money = t("errRealMoney");
    const pinIssue = pinProblem(form.approval_pin);
    if (pinIssue) e.approval_pin = pinIssue === "weak" ? t("pinWeak") : t("errPin");
    return e;
  }, [form, networkMode, t]);
  const hasErrors = Object.keys(errors).length > 0;

  const dailyMicros = toMicros(form.daily_budget);
  const totalMicros = toMicros(form.total_budget);
  const dailyAboveTotal = dailyMicros > 0n && totalMicros > 0n && dailyMicros > totalMicros;
  const searchTerm = search.trim().toLocaleLowerCase();
  const filteredKeys = (keys ?? []).filter((key) => !searchTerm || key.name.toLocaleLowerCase().includes(searchTerm) || key.key_prefix.toLocaleLowerCase().includes(searchTerm));

  function moneyField(field: "daily_budget" | "total_budget" | "per_request_limit" | "approval_threshold", label: "lblDaily" | "lblTotal" | "lblPerReq" | "lblThreshold") {
    const id = `key-${field}`;
    return (
      <div className="field">
        <label htmlFor={id}>{t(label)}</label>
        <div className="key-money-input">
          <span aria-hidden="true">$</span>
          <input id={id} inputMode="decimal" value={form[field]} required={field !== "approval_threshold"}
            placeholder={field === "approval_threshold" ? t("thresholdOptional") : undefined}
            aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${id}-error` : undefined}
            onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
        </div>
        {errors[field] && <div id={`${id}-error`} className="field-error">{errors[field]}</div>}
      </div>
    );
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (hasErrors) return;
    if (creating) return;
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
        network_mode: networkMode,
        approval_pin: form.approval_pin ? form.approval_pin : undefined,
      });
      setHandoff(handoffFromCreated(res));
      refresh();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        setCreateError(t("createTimedOut"));
        refresh();
      } else {
        setCreateError(err instanceof ApiError && err.error === "APPROVAL_PIN_WEAK" ? t("pinWeak") : err instanceof ApiError ? err.message : err instanceof Error ? err.message : "create_failed");
      }
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

  async function onSetPin() {
    if (!pinTarget) return;
    const pinIssue = pinProblem(pinInput);
    if (pinIssue) {
      setPinError(pinIssue === "weak" ? t("pinWeak") : t("errPin"));
      return;
    }
    setPinSetting(true);
    setPinError(null);
    try {
      const res = await setApprovalPin(pinTarget.id, pinInput || undefined);
      setPinNotice({ name: pinTarget.name, pin: res.approval_pin });
      setPinTarget(null);
      setPinInput("");
      refresh();
    } catch (e) {
      setPinError(
        e instanceof ApiError && e.error === "APPROVAL_PIN_WEAK"
          ? t("pinWeak")
          : t("pinSetFailed", { message: e instanceof ApiError ? e.message : e instanceof Error ? e.message : "set_failed" })
      );
    } finally {
      setPinSetting(false);
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
    <div className="keys-page">
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
      {pinNotice && (
        <Callout
          tone="success"
          title={t("pinSetDoneTitle", { name: pinNotice.name })}
          action={
            <button type="button" className="btn small secondary" onClick={() => setPinNotice(null)}>
              {tc("done")}
            </button>
          }
        >
          <ApprovalPinNotice pin={pinNotice.pin} />
        </Callout>
      )}

      <div className="card keys-card">
        {!!keys?.length && (
          <div className="keys-table-toolbar">
            <div className="keys-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" aria-label={t("searchKeys")} placeholder={t("searchKeys")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <span className="keys-count">{t("keysCount", { n: filteredKeys.length })}</span>
          </div>
        )}
        {loading && !keys ? (
          <SkeletonTable rows={4} cols={7} />
        ) : !keys || keys.length === 0 ? (
          <NoKeysYet onCreate={openCreate} />
        ) : (
          <div className="keys-table-scroll"><table className="keys-table">
            <thead>
              <tr>
                <th>{t("colKeyPrefix")}</th>
                <th>
                  <Term k="subtreeUsage">{t("colToday")}</Term>
                </th>
                <th className="num">
                  <Term k="totalBudget">{t("colTotal")}</Term>
                </th>
                <th>{t("colPaymentRules")}</th>
                <th>{t("expiresDateLabel")}</th>
                <th>{t("colLastUsed")}</th>
                <th><span className="sr-only">{t("colActions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredKeys.map((k) => {
                const usedMicros = toMicros(k.used_today);
                const dMicros = toMicros(k.daily_budget);
                const r = ratioMicros(usedMicros, dMicros);
                // The server's status already accounts for a parent that was revoked or expired
                // (active / revoked / expired / ancestor_revoked / ancestor_expired).
                const status = k.status;
                const statusTone = status === "active" ? "green" : status === "expired" || status === "ancestor_expired" ? "yellow" : "red";
                const isAncestorDisabled = status === "ancestor_revoked" || status === "ancestor_expired";
                return (
                  <tr key={k.id} className={status !== "active" ? "is-inactive" : undefined}>
                    <td className="key-identity">
                      <div className="agent-row">
                        <Avatar name={k.name} size={24} />
                        <span className="agent-name">{k.name}</span>
                      </div>
                      <div className="mono key-prefix">{k.key_prefix}••••</div>
                      <div className="key-network">
                        <KeyNetworkBadge compact mode={k.network_mode} active={k.status === "active"} chains={(k.networks ?? []).map((c) => chainLabels.get(c) ?? c)} />
                        {isAncestorDisabled ? (
                          <Term k={status === "ancestor_revoked" ? "ancestorRevoked" : "ancestorExpired"}>
                            <Pill tone={statusTone}>{t(`status${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof keysStrings.en)}</Pill>
                          </Term>
                        ) : (
                          <Pill tone={statusTone}>{t(`status${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof keysStrings.en)}</Pill>
                        )}
                      </div>
                      {k.status === "active" && <KeyPinState state={k.approval_pin_state} failures={k.approval_pin_failures} />}
                    </td>
                    <td style={{ minWidth: 130 }}>
                      <div className="num" style={{ fontSize: 12 }}>
                        {formatUsdc(k.used_today, { maxDecimals: 4 })} / {formatUsdc(k.daily_budget, { maxDecimals: 4 })}
                      </div>
                      <ProgressBar ratio={r} />
                    </td>
                    <td className="num">
                      {formatUsdc(k.used_total, { maxDecimals: 4 })} / {formatUsdc(k.total_budget, { maxDecimals: 4 })}
                      <ProgressBar ratio={ratioMicros(toMicros(k.used_total), toMicros(k.total_budget))} />
                    </td>
                    <td>
                      <div className="key-rule-line"><span className="key-rule-label">{t("colPerRequest")}</span> ${formatUsdc(k.per_request_limit, { maxDecimals: 4 })}</div>
                      <div className="key-rule-line key-rule-label">{k.approval_threshold != null ? t("ruleApproval", { amount: formatUsdc(k.approval_threshold, { maxDecimals: 4 }) }) : t("ruleNoAmountApproval")}</div>
                    </td>
                    <td>{k.expires_at ? <time dateTime={k.expires_at} title={new Date(k.expires_at).toISOString()}>{new Date(k.expires_at).toLocaleDateString(undefined, { timeZone: "UTC" })}</time> : t("expiresNever")}</td>
                    <td>{k.last_used_at ? relTime(k.last_used_at) : t("lastUsedNever")}</td>
                    <td>
                      <KeyRowActions
                        compact
                        status={k.status}
                        childrenCount={k.children_count}
                        confirmingRevoke={revokeConfirmId === k.id}
                        revoking={revokingId === k.id}
                        onRotate={() => {
                          setRotateError(null);
                          setRotateTarget({ id: k.id, name: k.name });
                        }}
                        onSetPin={
                          k.parent_id == null
                            ? () => {
                                setPinError(null);
                                setPinInput("");
                                setPinTarget({ id: k.id, name: k.name });
                              }
                            : undefined
                        }
                        onAskRevoke={() => setRevokeConfirmId(k.id)}
                        onRevoke={() => onRevoke(k.id)}
                        onCancelRevoke={() => setRevokeConfirmId(null)}
                      />
                    </td>
                  </tr>
                );
              })}
              {filteredKeys.length === 0 && <tr><td colSpan={7}>{t("searchEmpty")}</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>

      <KeyDialog
        open={showCreate}
        onClose={closeDrawer}
        title={handoff?.kind === "rotated" ? ts("rotateDrawerTitle") : handoff ? t("drawerTitleCreated") : t("drawerTitleCreate")}
        busy={creating}
      >
        {!handoff ? (
          <form className="key-create-form" onSubmit={submitCreate}>
            <NetworkModeField
              kinds={kinds}
              value={networkMode}
              onChange={(network_mode) => setForm({ ...form, network_mode, confirm_real_money: false })}
              confirmed={form.confirm_real_money}
              onConfirmedChange={(confirm_real_money) => setForm({ ...form, confirm_real_money })}
              error={errors.confirm_real_money}
            />

            <div className="key-field-grid">
              <div className="field">
                <label htmlFor="key-name">{t("nameLabel")}</label>
                <input id="key-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("namePlaceholder")} />
                <div className="field-hint">{t("nameHint")}</div>
              </div>
              <div className="field">
                <label htmlFor="key-expires-at">{t("expiresDateLabel")}</label>
                <input id="key-expires-at" type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
                <div className="field-hint">{t("expiresHint")}</div>
              </div>
            </div>

            <section className="key-form-section" aria-labelledby="key-budget-heading">
              <h3 id="key-budget-heading">{t("budgetHeading")}</h3>
              <div className="preset-row key-budget-presets" role="group" aria-label={t("budgetPresets")}>
                {PRESETS.map((p) => {
                  const selected = Object.entries(p.patch).every(([field, value]) => form[field as keyof FormState] === value);
                  return <button type="button" key={p.key} className={`preset-btn${selected ? " is-active" : ""}`} aria-pressed={selected} onClick={() => applyPreset(p.patch)}>{t(p.key)}</button>;
                })}
              </div>
              <div className="key-field-grid">
                {moneyField("daily_budget", "lblDaily")}
                {moneyField("total_budget", "lblTotal")}
              </div>
              <p className="key-form-note">{t("budgetHint")}</p>
              {dailyAboveTotal && <Callout tone="warn">{t("warnDailyGtTotal")}</Callout>}
            </section>

            <details className="key-controls">
              <summary className="key-controls-summary">
                  <span>{t("paymentControls")}</span>
                  <small>{t("controlSummary", { amount: form.per_request_limit || "—" })} · {form.approval_threshold.trim() ? t("ruleApproval", { amount: form.approval_threshold }) : t("ruleNoAmountApproval")}</small>
              </summary>
              <div className="key-controls-body">
                <div className="key-field-grid">
                  {moneyField("per_request_limit", "lblPerReq")}
                  {moneyField("approval_threshold", "lblThreshold")}
                </div>
                <p className="key-form-note">{t("thresholdHint")}</p>
                <AllowedHostsField
                  value={form.allowed_hosts}
                  onChange={(allowed_hosts) => setForm({ ...form, allowed_hosts })}
                  testAvailable={testAvailable}
                  allowTest={form.allow_test_endpoint}
                  onAllowTestChange={(allow_test_endpoint) => setForm({ ...form, allow_test_endpoint })}
                />
                <ApprovalPinField
                  id="key-approval-pin"
                  value={form.approval_pin}
                  onChange={(approval_pin) => setForm({ ...form, approval_pin })}
                  error={errors.approval_pin}
                  hint
                />
                <div className="field">
                  <label htmlFor="key-rate-limit">{t("rateLimitLabel")}</label>
                  <input id="key-rate-limit" type="number" min="1" step="1" required value={form.max_payments_per_minute} aria-invalid={!!errors.max_payments_per_minute} onChange={(e) => setForm({ ...form, max_payments_per_minute: e.target.value })} />
                  {errors.max_payments_per_minute && <div className="field-error">{errors.max_payments_per_minute}</div>}
                </div>
              </div>
            </details>
            <p className="key-form-note">{t("siteApprovalSummary")} {testAvailable && form.allow_test_endpoint ? t("testEndpointSummary") : ""}</p>
            <p className="key-form-note">{t("pinAutoSummary")}</p>
            {(errors.per_request_limit || errors.approval_threshold || errors.approval_pin || errors.max_payments_per_minute) && (
              <div className="field-error" role="alert">{t("controlsInvalid")}</div>
            )}

            {createError && <Callout tone="error">{createError}</Callout>}
            <div className="modal-actions key-form-footer">
              <button type="button" className="btn secondary" onClick={closeDrawer} disabled={creating}>
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
            testnet={testPaymentAvailable(meta, handoff.networkMode)}
            onDone={closeDrawer}
          />
        )}
      </KeyDialog>

      <ConfirmDialog
        open={pinTarget !== null}
        title={t("pinSetTitle", { name: pinTarget?.name ?? "" })}
        confirmLabel={pinSetting ? t("pinSetting") : t("pinSetConfirm")}
        busy={pinSetting}
        danger={false}
        error={pinError}
        onConfirm={onSetPin}
        onCancel={() => {
          setPinTarget(null);
          setPinError(null);
        }}
      >
        <p>{t("pinSetBody")}</p>
        <ApprovalPinField id="set-approval-pin" value={pinInput} onChange={setPinInput} error={pinProblem(pinInput) === "weak" ? t("pinWeak") : undefined} />
      </ConfirmDialog>

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
