import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import {
  getStatus,
  listMyChildKeys,
  createMyChildKey,
  revokeMyChildKey,
  ChatApiError,
  ChildKeyRow,
  CreateChildKeyResponse,
  StatusResponse,
} from "../../api";
import { toMicros, ratioMicros, formatUsdc, fromMicros } from "../../money";
import { openaiBase } from "../../snippets";
import ProgressBar from "../../components/ProgressBar";
import Pill from "../../components/Pill";
import Drawer from "../../components/Drawer";
import Callout from "../../components/Callout";
import EmptyState from "../../components/EmptyState";
import CopyButton from "../../components/CopyButton";
import Snippet from "../../components/Snippet";
import SkillForAi from "../../components/SkillForAi";
import SecretNotice from "../../components/SecretNotice";
import { SkeletonCard, SkeletonTable } from "../../components/Skeleton";
import { useT } from "../../i18n";
import { common } from "../../i18n/strings/common";
import { subkeysStrings } from "../../i18n/strings/subkeys";
import { keysStrings } from "../../i18n/strings/keys";
import { employeeStrings } from "../../i18n/strings/employee";
import { skillStrings } from "../../i18n/strings/skill";
import { skillBaseUrl } from "../../skillText";
import "../../styles/subkeys.css";

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;

function isPositiveDecimal(v: string): boolean {
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) > 0;
}

function isNonNegativeDecimalOrEmpty(v: string): boolean {
  if (!v.trim()) return true;
  return DECIMAL_RE.test(v.trim()) && parseFloat(v) >= 0;
}

interface FormState {
  name: string;
  daily_budget: string;
  per_request_limit: string;
  total_budget: string;
  approval_threshold: string;
  can_delegate: boolean;
}

function defaultForm(status: StatusResponse | null): FormState {
  const dailyMicros = status?.daily_budget ? toMicros(status.daily_budget) : 0n;
  const remainingMicros = status?.remaining_today ? toMicros(status.remaining_today) : 0n;
  // Default to half of what I can actually still spend today (effective
  // remaining, already bounded by my ancestors), never more than my daily budget.
  const cap = remainingMicros > 0n && remainingMicros < dailyMicros ? remainingMicros : dailyMicros > 0n ? dailyMicros : remainingMicros;
  // Roughly half of whichever cap we have, as a friendly default — the
  // server (and client validation below) is what actually enforces the max.
  const half = cap > 0n ? cap / 2n : 0n;
  return {
    name: "",
    daily_budget: half > 0n ? fromMicros(half) : "0.10",
    per_request_limit: status?.per_request_limit ?? "0.05",
    total_budget: status?.total_budget ?? "1",
    approval_threshold: "",
    can_delegate: false,
  };
}

async function fetchMySubKeys(key: string) {
  const [status, children] = await Promise.all([getStatus(key), listMyChildKeys(key)]);
  return { status, children };
}

/**
 * What a key holder sees right after creating a sub-key. One key per agent is the
 * point of sub-keys, so the skill for that agent (with THIS new key, not the
 * holder's own) comes first; the raw key and the OpenAI base URL are the other way.
 * Exported for render tests.
 */
export function SubKeyCreated({ created, origin, onDone }: { created: CreateChildKeyResponse; origin: string; onDone: () => void }) {
  const t = useT(subkeysStrings);
  const te = useT(employeeStrings);
  const ts = useT(skillStrings);
  return (
    <div>
      <div className="key-once-banner">{t("createdBanner")}</div>
      <SecretNotice>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{t("keyFieldLabel")}</label>
          <div className="key-big">{created.key}</div>
          <CopyButton text={created.key} />
        </div>
      </SecretNotice>
      <SkillForAi baseUrl={skillBaseUrl(null, origin)} secret={created.key} keyName={created.name} />
      <div className="skill-other-intro">{ts("tabOther")}</div>
      <Snippet title={te("baseUrlLabel")} code={openaiBase(origin)} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onDone}>
          {t("doneBtn")}
        </button>
      </div>
    </div>
  );
}

export default function MySubKeysPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const t = useT(subkeysStrings);
  const tc = useT(common);
  const tk = useT(keysStrings);

  const { data, error, loading, refresh } = usePolling(() => fetchMySubKeys(key));
  const status = data?.status ?? null;
  const children = data?.children ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(() => defaultForm(null));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<React.ReactNode>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [created, setCreated] = useState<CreateChildKeyResponse | null>(null);

  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // A server-side rejection refers to the values that were submitted; drop it
  // as soon as the user edits the form so it never sits next to a different value.
  useEffect(() => {
    setFieldError(null);
    setCreateError(null);
  }, [form]);

  const canCreateChildren = status?.can_create_children ?? false;
  const depth = status?.depth ?? 0;
  const maxDepth = status?.max_depth;
  const canOfferDelegate = canCreateChildren && (maxDepth == null || depth + 1 < maxDepth);

  function openCreate() {
    setForm(defaultForm(status));
    setCreateError(null);
    setFieldError(null);
    setCreated(null);
    setShowCreate(true);
  }

  function closeDrawer() {
    setShowCreate(false);
    setCreated(null);
  }

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = t("errRequired");
    if (!isPositiveDecimal(form.daily_budget)) e.daily_budget = t("errDecimal");
    if (!isPositiveDecimal(form.per_request_limit)) e.per_request_limit = t("errDecimal");
    if (!isPositiveDecimal(form.total_budget)) e.total_budget = t("errDecimal");
    if (!isNonNegativeDecimalOrEmpty(form.approval_threshold)) e.approval_threshold = t("errDecimal");
    else if (
      form.approval_threshold.trim() &&
      isPositiveDecimal(form.per_request_limit) &&
      toMicros(form.approval_threshold) > toMicros(form.per_request_limit)
    ) {
      e.approval_threshold = t("errThresholdOverPerReq");
    }
    // Client-side hints only — the server is the real source of truth (SPEC-v0.4.md §A).
    if (status?.daily_budget != null && isPositiveDecimal(form.daily_budget) && toMicros(form.daily_budget) > toMicros(status.daily_budget)) {
      e.daily_budget = t("errExceedsMineDaily", { value: formatUsdc(status.daily_budget, { maxDecimals: 4 }) });
    }
    if (
      status?.per_request_limit != null &&
      isPositiveDecimal(form.per_request_limit) &&
      toMicros(form.per_request_limit) > toMicros(status.per_request_limit)
    ) {
      e.per_request_limit = t("errExceedsMinePerReq", { value: formatUsdc(status.per_request_limit, { maxDecimals: 4 }) });
    }
    if (status?.total_budget != null && isPositiveDecimal(form.total_budget) && toMicros(form.total_budget) > toMicros(status.total_budget)) {
      e.total_budget = t("errExceedsMineTotal", { value: formatUsdc(status.total_budget, { maxDecimals: 4 }) });
    }
    return e;
  }, [form, status, t]);
  const hasErrors = Object.keys(errors).length > 0;

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (hasErrors) return;
    setCreating(true);
    setCreateError(null);
    setFieldError(null);
    try {
      const res = await createMyChildKey(key, {
        name: form.name.trim(),
        daily_budget: form.daily_budget,
        total_budget: form.total_budget,
        per_request_limit: form.per_request_limit,
        approval_threshold: form.approval_threshold.trim() ? form.approval_threshold.trim() : null,
        can_delegate: canOfferDelegate ? form.can_delegate : undefined,
      });
      setCreated(res);
      refresh();
    } catch (err) {
      if (err instanceof ChatApiError) {
        const fieldKey = `field_${err.field}`;
        const label = err.field && fieldKey in subkeysStrings.en ? t(fieldKey as keyof typeof subkeysStrings.en) : err.field ?? "";
        if (err.code === "CHILD_EXCEEDS_PARENT" && err.field) {
          const valueText = Array.isArray(err.parentValue) ? err.parentValue.join(", ") : err.parentValue ?? "";
          setFieldError({ field: err.field, message: t("errFieldExceedsParent", { field: label, value: valueText }) });
        } else if (err.code === "INVALID_REQUEST" && err.field) {
          setFieldError({ field: err.field, message: t("errFieldInvalid", { field: label, message: err.message }) });
        } else if (err.code === "DELEGATION_NOT_ALLOWED") {
          setCreateError(t("errDelegationNotAllowed"));
        } else if (err.code === "MAX_DEPTH_EXCEEDED") {
          setCreateError(t("errMaxDepthExceeded"));
        } else if (err.code === "CHILDREN_LIMIT_REACHED") {
          setCreateError(t("errChildrenLimitReached"));
        } else {
          setCreateError(err.message);
        }
      } else {
        setCreateError(err instanceof Error ? err.message : "create_failed");
      }
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeMyChildKey(key, id);
      setRevokeConfirmId(null);
      refresh();
    } catch (e) {
      setRevokeError(e instanceof ChatApiError ? e.message : e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setRevokingId(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="grid-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const origin = window.location.origin;

  return (
    <div>
      {error && (
        <Callout tone="error" title={tc("requestFailed", { message: error })}>
          {tc("serverUnreachable")}
        </Callout>
      )}
      {revokeError && <Callout tone="error">{revokeError}</Callout>}

      <div className="card subkeys-header-card">
        <div>
          <div className="stat-label">{t("headerRemainingToday")}</div>
          <div className="stat-value num">{status ? formatUsdc(status.remaining_today, { maxDecimals: 4 }) : "-"}</div>
          {status?.remaining_today_scope === "ancestor" && <div className="stat-sub">{t("remainingBoundByParent")}</div>}
        </div>
        <div>
          <div className="stat-label">{t("headerRemainingTotal")}</div>
          <div className="stat-value num">{status ? formatUsdc(status.remaining_total, { maxDecimals: 4 }) : "-"}</div>
        </div>
        <div className="subkeys-header-status">
          {canCreateChildren ? (
            <Callout tone="success">{t("headerCanDelegateYes")}</Callout>
          ) : maxDepth != null && depth >= maxDepth ? (
            <Callout tone="warn">{t("headerMaxDepthReached", { depth: maxDepth })}</Callout>
          ) : (
            <Callout tone="warn">{t("headerCanDelegateNo")}</Callout>
          )}
        </div>
      </div>

      <p className="subkeys-share-note">{t("shareNote")}</p>

      <div className="toolbar">
        <div />
        <button type="button" className="btn" disabled={!canCreateChildren} onClick={openCreate}>
          {t("createBtn")}
        </button>
      </div>

      <div className="card">
        {loading && !data ? (
          <SkeletonTable rows={3} cols={5} />
        ) : children.length === 0 ? (
          <EmptyState title={t("emptyTitle")} action={canCreateChildren ? <button type="button" className="btn small" onClick={openCreate}>{t("createBtn")}</button> : undefined}>
            {t("emptyBody")}
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colName")}</th>
                <th>{t("colKeyPrefix")}</th>
                <th>{t("colToday")}</th>
                <th className="num">{t("colPerRequest")}</th>
                <th className="num">{t("colTotal")}</th>
                <th>{t("colStatus")}</th>
                <th>{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {children.map((c: ChildKeyRow) => {
                const usedMicros = toMicros(c.used_today);
                const dMicros = toMicros(c.daily_budget);
                const r = ratioMicros(usedMicros, dMicros);
                const statusTone = c.status === "active" ? "green" : c.status === "expired" || c.status === "ancestor_expired" ? "yellow" : "red";
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="agent-row" style={{ gap: 6 }}>
                        <span className="agent-name">{c.name}</span>
                        {c.can_delegate && <Pill tone="blue">{tk("canDelegatePill")}</Pill>}
                      </div>
                    </td>
                    <td className="mono">{c.key_prefix}••••</td>
                    <td style={{ minWidth: 130 }}>
                      <div className="num" style={{ fontSize: 12 }}>
                        {formatUsdc(c.used_today, { maxDecimals: 4 })} / {formatUsdc(c.daily_budget, { maxDecimals: 4 })}
                      </div>
                      <ProgressBar ratio={r} />
                    </td>
                    <td className="num">{formatUsdc(c.per_request_limit, { maxDecimals: 4 })}</td>
                    <td className="num">
                      {formatUsdc(c.used_total, { maxDecimals: 4 })} / {formatUsdc(c.total_budget, { maxDecimals: 4 })}
                    </td>
                    <td>
                      <Pill tone={statusTone}>{tk(`status${c.status[0].toUpperCase()}${c.status.slice(1)}` as never)}</Pill>
                    </td>
                    <td>
                      {c.status === "active" &&
                        (revokeConfirmId === c.id ? (
                          <div className="keys-revoke-confirm">
                            <span>{t("revokeConfirmText")}</span>
                            <button type="button" className="btn small danger" onClick={() => onRevoke(c.id)} disabled={revokingId === c.id}>
                              {revokingId === c.id ? "…" : t("revokeBtn")}
                            </button>
                            <button type="button" className="btn small secondary" onClick={() => setRevokeConfirmId(null)}>
                              {tc("cancel")}
                            </button>
                          </div>
                        ) : (
                          <button type="button" className="btn small danger" onClick={() => setRevokeConfirmId(c.id)}>
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

      <Drawer open={showCreate} onClose={closeDrawer} title={created ? t("drawerTitleCreated") : t("drawerTitleCreate")} width={480}>
        {!created ? (
          <form onSubmit={submitCreate}>
            <div className="field">
              <label>{t("nameLabel")}</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("namePlaceholder")} />
              {errors.name && <div className="field-error">{errors.name}</div>}
            </div>

            <div className="field">
              <label>{t("lblDaily")}</label>
              <input inputMode="decimal" value={form.daily_budget} onChange={(e) => setForm({ ...form, daily_budget: e.target.value })} />
              {status?.daily_budget != null && (
                <div className="field-hint">{t("maxHintDaily", {
                    limit: formatUsdc(status.daily_budget, { maxDecimals: 4 }),
                    remaining: formatUsdc(status.remaining_today, { maxDecimals: 4 }),
                  })}</div>
              )}
              {errors.daily_budget && <div className="field-error">{errors.daily_budget}</div>}
              {fieldError?.field === "daily_budget" && <div className="field-error">{fieldError.message}</div>}
            </div>

            <div className="field">
              <label>{t("lblPerReq")}</label>
              <input inputMode="decimal" value={form.per_request_limit} onChange={(e) => setForm({ ...form, per_request_limit: e.target.value })} />
              {status?.per_request_limit != null && (
                <div className="field-hint">{t("maxHintPerReq", { limit: formatUsdc(status.per_request_limit, { maxDecimals: 4 }) })}</div>
              )}
              {errors.per_request_limit && <div className="field-error">{errors.per_request_limit}</div>}
              {fieldError?.field === "per_request_limit" && <div className="field-error">{fieldError.message}</div>}
            </div>

            <div className="field">
              <label>{t("lblTotal")}</label>
              <input inputMode="decimal" value={form.total_budget} onChange={(e) => setForm({ ...form, total_budget: e.target.value })} />
              {status?.total_budget != null && (
                <div className="field-hint">{t("maxHintTotal", {
                    limit: formatUsdc(status.total_budget, { maxDecimals: 4 }),
                    remaining: formatUsdc(status.remaining_total, { maxDecimals: 4 }),
                  })}</div>
              )}
              {errors.total_budget && <div className="field-error">{errors.total_budget}</div>}
              {fieldError?.field === "total_budget" && <div className="field-error">{fieldError.message}</div>}
            </div>

            <div className="field">
              <label>{t("lblThreshold")}</label>
              <input
                inputMode="decimal"
                placeholder="—"
                value={form.approval_threshold}
                onChange={(e) => setForm({ ...form, approval_threshold: e.target.value })}
              />
              <div className="field-hint">
                {status?.approval_threshold
                  ? t("thresholdHintWithValue", { value: formatUsdc(status.approval_threshold, { maxDecimals: 4 }) })
                  : t("thresholdHint")}
              </div>
              {errors.approval_threshold && <div className="field-error">{errors.approval_threshold}</div>}
              {fieldError?.field === "approval_threshold" && <div className="field-error">{fieldError.message}</div>}
            </div>

            {canOfferDelegate ? (
              <label className="keys-can-delegate-toggle">
                <input type="checkbox" checked={form.can_delegate} onChange={(e) => setForm({ ...form, can_delegate: e.target.checked })} />
                <span>{t("canDelegateLabel")}</span>
              </label>
            ) : (
              canCreateChildren && <div className="field-hint">{t("canDelegateUnavailable")}</div>
            )}

            {fieldError && !["daily_budget", "per_request_limit", "total_budget", "approval_threshold"].includes(fieldError.field) && (
              <Callout tone="error">{fieldError.message}</Callout>
            )}
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
          <SubKeyCreated created={created} origin={origin} onDone={closeDrawer} />
        )}
      </Drawer>
    </div>
  );
}
