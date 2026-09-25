import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, KeyRound } from "lucide-react";
import { usePolling } from "../usePolling";
import { listKeys, createKey, revokeKey, listChannels, ApiError, ChannelRow, CreateMoneyKeyResponse, MoneyKeyRow } from "../api";
import { toMicros, ratioMicros, formatUsdc } from "../money";
import CopyButton from "../components/CopyButton";
import Avatar from "../components/Avatar";
import Pill from "../components/Pill";
import ProgressBar from "../components/ProgressBar";
import Drawer from "../components/Drawer";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import Term from "../components/Term";
import Snippet from "../components/Snippet";
import { SkeletonTable } from "../components/Skeleton";
import { useT, useLang, Lang } from "../i18n";
import { useRelativeTime } from "../i18n/format";
import { common } from "../i18n/strings/common";
import { keysStrings } from "../i18n/strings/keys";
import { useAdminMeta } from "../useAdminMeta";
import {
  useCliSource,
  connectCommand,
  claudeMcpCommand,
  codexToml,
  openaiBase,
  openaiPython,
  openaiNode,
  openaiCurl,
  newApiSnippet,
  employeeMessage,
} from "../snippets";
import "../styles/keys.css";

const PLAYGROUND_KEY_STORAGE = "moneyswitch_playground_key";
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
  allowed_models: string[];
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
    allowed_models: [],
  };
}

const PRESETS: Array<{ key: keyof typeof keysStrings.en; patch: Partial<FormState> }> = [
  { key: "presetTrial", patch: { daily_budget: "0.50", per_request_limit: "0.20", approval_threshold: "0.10", total_budget: "5" } },
  { key: "presetTight", patch: { daily_budget: "0.10", per_request_limit: "0.02", approval_threshold: "0.05", total_budget: "1" } },
  { key: "presetGenerous", patch: { daily_budget: "5", per_request_limit: "1", approval_threshold: "", total_budget: "50" } },
];

function deriveAllowedHosts(
  channels: ChannelRow[] | undefined | null,
  demoSellerUrl: string | null | undefined
): { hosts: string; hint: "derived" | "demo" | "empty" } {
  const set = new Set<string>();
  for (const c of channels ?? []) {
    if (!c.enabled) continue;
    try {
      const u = new URL(c.base_url);
      set.add(u.port ? `${u.hostname}:${u.port}` : u.hostname);
    } catch {
      // malformed base_url — skip rather than poison the allow-list
    }
  }
  if (set.size > 0) return { hosts: Array.from(set).join(", "), hint: "derived" };
  if (demoSellerUrl) {
    try {
      const u = new URL(demoSellerUrl);
      return { hosts: u.port ? `${u.hostname}:${u.port}` : u.hostname, hint: "demo" };
    } catch {
      // fall through
    }
  }
  return { hosts: "", hint: "empty" };
}

function isPositiveDecimal(v: string): boolean {
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) > 0;
}

function isNonNegativeDecimalOrEmpty(v: string): boolean {
  if (!v.trim()) return true;
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) >= 0;
}

export default function MoneyKeysPage() {
  const t = useT(keysStrings);
  const tc = useT(common);
  const { lang } = useLang();
  const relTime = useRelativeTime();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const meta = useAdminMeta();
  const src = useCliSource(meta);

  const { data: keys, error, loading, refresh } = usePolling(listKeys);
  const { data: channels } = usePolling(listChannels);
  const allModelOptions = Array.from(new Set((channels ?? []).flatMap((c) => c.models))).sort();
  const hostsDefault = useMemo(() => deriveAllowedHosts(channels, meta?.demo_seller_url), [channels, meta]);
  const firstModel = useMemo(() => {
    for (const c of channels ?? []) {
      if (c.enabled && c.models.length > 0) return c.models[0];
    }
    return "moneyswitch-demo-chat";
  }, [channels]);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(""));
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateMoneyKeyResponse | null>(null);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<"connect" | "claude" | "codex" | "openai" | "employee">("connect");
  const [employeeLang, setEmployeeLang] = useState<Lang | null>(null);

  useEffect(() => {
    if (!revokeSuccess) return;
    const timer = setTimeout(() => setRevokeSuccess(null), 4000);
    return () => clearTimeout(timer);
  }, [revokeSuccess]);

  function openCreate() {
    setForm(emptyForm(hostsDefault.hosts));
    setCreateError(null);
    setCreated(null);
    setTab("connect");
    setEmployeeLang(null);
    setShowCreate(true);
  }

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      openCreate();
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeDrawer() {
    setShowCreate(false);
    setCreated(null);
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
        allowed_hosts: form.allowed_hosts
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean),
        max_payments_per_minute: form.max_payments_per_minute ? Number(form.max_payments_per_minute) : undefined,
        expires_at: expiresIso,
        allowed_models: form.allowed_models.length > 0 ? form.allowed_models : null,
      });
      setCreated(res);
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

  function tryInPlayground(key: string) {
    sessionStorage.setItem(PLAYGROUND_KEY_STORAGE, key);
    navigate("/playground");
  }

  const apiBase = window.location.origin;
  const noChannelsYet = Boolean(channels && channels.length === 0);

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
          noChannelsYet ? (
            <EmptyState
              icon={<KeyRound size={28} />}
              title={t("emptyNoChannelsTitle")}
              action={
                <div style={{ display: "flex", gap: 8 }}>
                  <Link to="/channels" className="btn small secondary">
                    {t("actionAddChannel")}
                  </Link>
                  <button type="button" className="btn small" onClick={openCreate}>
                    {t("actionCreateAnyway")}
                  </button>
                </div>
              }
            >
              {t("emptyNoChannelsBody")}
            </EmptyState>
          ) : (
            <EmptyState
              icon={<KeyRound size={28} />}
              title={t("emptyNoKeysTitle")}
              action={
                <button type="button" className="btn small" onClick={openCreate}>
                  {t("actionCreateFirst")}
                </button>
              }
            >
              {t("emptyNoKeysBody")}
            </EmptyState>
          )
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colAgent")}</th>
                <th>{t("colKeyPrefix")}</th>
                <th>
                  <Term k="dailyBudget">{t("colToday")}</Term>
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
              {keys.map((k: MoneyKeyRow) => {
                const usedMicros = toMicros(k.used_today);
                const dMicros = toMicros(k.daily_budget);
                const r = ratioMicros(usedMicros, dMicros);
                const expired = Boolean(k.expires_at && new Date(k.expires_at).getTime() < Date.now());
                const status = !k.enabled ? "revoked" : expired ? "expired" : "active";
                const statusTone = status === "active" ? "green" : status === "expired" ? "yellow" : "red";
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
                      <Pill tone={statusTone}>{t(`status${status[0].toUpperCase()}${status.slice(1)}` as keyof typeof keysStrings.en)}</Pill>
                    </td>
                    <td>
                      {k.enabled &&
                        (revokeConfirmId === k.id ? (
                          <div className="keys-revoke-confirm">
                            <span>{t("revokeConfirmText")}</span>
                            <button type="button" className="btn small danger" onClick={() => onRevoke(k.id)} disabled={revokingId === k.id}>
                              {revokingId === k.id ? "…" : t("revokeBtn")}
                            </button>
                            <button type="button" className="btn small secondary" onClick={() => setRevokeConfirmId(null)}>
                              {tc("cancel")}
                            </button>
                          </div>
                        ) : (
                          <button type="button" className="btn small danger" onClick={() => setRevokeConfirmId(k.id)}>
                            {t("revokeBtn")}
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Drawer open={showCreate} onClose={closeDrawer} title={created ? t("drawerTitleCreated") : t("drawerTitleCreate")} width={520}>
        {!created ? (
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
                  <Term k="allowedHosts">{t("allowedHostsLabel")}</Term>
                </label>
                <textarea
                  rows={2}
                  value={form.allowed_hosts}
                  onChange={(e) => setForm({ ...form, allowed_hosts: e.target.value })}
                  placeholder={t("allowedHostsPlaceholder")}
                />
                {hostsDefault.hint === "derived" && <div className="field-hint">{t("allowedHostsHintDerived")}</div>}
                {hostsDefault.hint === "demo" && <div className="field-hint">{t("allowedHostsHintDemo")}</div>}
                {hostsDefault.hint === "empty" && <Callout tone="warn">{t("allowedHostsHintEmpty")}</Callout>}
              </div>
              <div className="field">
                <label>
                  <Term k="allowedModels">{t("allowedModelsLabel")}</Term>
                </label>
                {allModelOptions.length === 0 ? (
                  <div className="field-hint">{t("allowedModelsEmptyHint")}</div>
                ) : (
                  <div className="model-chip-row">
                    {allModelOptions.map((m) => {
                      const active = form.allowed_models.includes(m);
                      return (
                        <button
                          type="button"
                          key={m}
                          className={`pill model-chip ${active ? "pill-blue" : "pill-gray"}`}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              allowed_models: active ? f.allowed_models.filter((x) => x !== m) : [...f.allowed_models, m],
                            }))
                          }
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
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
          <div>
            <div className="key-once-banner">{t("createdBanner")}</div>
            <div className="field">
              <label>{t("keyFieldLabel")}</label>
              <div className="key-big">{created.key}</div>
              <CopyButton text={created.key} />
            </div>

            <div className="next-heading">{t("nextHeading")}</div>

            <div className="tabs">
              <button type="button" className={`tab-btn ${tab === "connect" ? "active" : ""}`} onClick={() => setTab("connect")}>
                {t("tabConnect")}
              </button>
              <button type="button" className={`tab-btn ${tab === "claude" ? "active" : ""}`} onClick={() => setTab("claude")}>
                {t("tabClaude")}
              </button>
              <button type="button" className={`tab-btn ${tab === "codex" ? "active" : ""}`} onClick={() => setTab("codex")}>
                {t("tabCodex")}
              </button>
              <button type="button" className={`tab-btn ${tab === "openai" ? "active" : ""}`} onClick={() => setTab("openai")}>
                {t("tabOpenai")}
              </button>
              <button type="button" className={`tab-btn ${tab === "employee" ? "active" : ""}`} onClick={() => setTab("employee")}>
                {t("tabEmployee")}
              </button>
            </div>

            {tab === "connect" && (
              <div>
                <Snippet title={t("connectRecommended")} code={connectCommand(src, apiBase, created.key, true)} note={t("connectNote")} />
                <Snippet title={t("connectDryRunLabel")} code={connectCommand(src, apiBase, created.key, false)} />
                {src.kind === "tarball" && <div className="connect-source-note">{t("sourceNoteTarball")}</div>}
                {src.kind === "local" && <div className="connect-source-note">{t("sourceNoteLocal")}</div>}
                {src.kind === "npm" && <Callout tone="warn" title={t("sourceNoteNpmTitle")}>{t("sourceNoteNpm")}</Callout>}
              </div>
            )}
            {tab === "claude" && <Snippet title={t("tabClaude")} code={claudeMcpCommand(src, apiBase, created.key)} note={t("claudeNote")} />}
            {tab === "codex" && <Snippet title={t("tabCodex")} code={codexToml(src, apiBase, created.key)} note={t("codexNote")} />}
            {tab === "openai" && (
              <div>
                <Snippet title={t("baseUrlLabel")} code={openaiBase(apiBase)} />
                <Snippet title={t("apiKeyLabel")} code={created.key} />
                <Snippet title={t("pythonLabel")} code={openaiPython(apiBase, created.key, firstModel)} />
                <Snippet title={t("nodeLabel")} code={openaiNode(apiBase, created.key, firstModel)} />
                <Snippet title={t("curlLabel")} code={openaiCurl(apiBase, created.key, firstModel)} />
                <Snippet title={t("newApiLabel")} code={newApiSnippet(apiBase, created.key)} />
              </div>
            )}
            {tab === "employee" && (
              <div>
                <div className="field-hint employee-toggle">{t("employeeHint")}</div>
                <button
                  type="button"
                  className="btn small secondary employee-toggle"
                  onClick={() => setEmployeeLang((employeeLang ?? lang) === "zh" ? "en" : "zh")}
                >
                  {t("employeeToggleLang", { lang: (employeeLang ?? lang) === "zh" ? t("langEn") : t("langZh") })}
                </button>
                <Snippet
                  code={employeeMessage(employeeLang ?? lang, {
                    origin: apiBase,
                    name: created.name || t("tabEmployee"),
                    key: created.key,
                    src,
                  })}
                />
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => tryInPlayground(created.key)}>
                {t("tryPlaygroundBtn")}
              </button>
              <button type="button" className="btn" onClick={closeDrawer}>
                {tc("done")}
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
