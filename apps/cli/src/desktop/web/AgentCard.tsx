import React, { useEffect, useMemo, useState } from "react";
import { api, ApiError, type AgentPlan, type AgentView, type KeyStatus, type Preset } from "./api";
import { DiffModal } from "./DiffModal";
import { hasKey, useT, type MsgKey } from "./i18n";
import { Callout, CopyButton, Field, money, Pill, Spinner, Switch } from "./ui";

const AVATAR: Record<string, { letter: string; bg: string }> = {
  claude: { letter: "C", bg: "linear-gradient(135deg,#d97757,#b35a3c)" },
  codex: { letter: "X", bg: "linear-gradient(135deg,#3b3f4a,#11141a)" },
  workbuddy: { letter: "W", bg: "linear-gradient(135deg,#2f7cf6,#1d4fbf)" },
  openclaw: { letter: "O", bg: "linear-gradient(135deg,#e5484d,#a4262c)" },
  cherry: { letter: "🍒", bg: "linear-gradient(135deg,#ff7a93,#c2185b)" },
};

export interface CardContext {
  accountStatus: KeyStatus | null;
  hasAccount: boolean;
  spentToday: string | null;
  reload: () => Promise<void>;
  toast: (msg: string, tone?: "ok" | "error") => void;
  defaults: { daily_budget: string; per_request_limit: string; total_budget: string } | null;
}

function errText(t: ReturnType<typeof useT>, e: unknown): string {
  const err = e as ApiError;
  return t("errorGeneric", { message: err?.message ?? String(e) });
}

// --------------------------------------------------------------------- brain

function BrainPanel({ agent, ctx }: { agent: AgentView; ctx: CardContext }) {
  const t = useT();
  const presets = agent.presets;
  const initial = agent.brain;
  const [preset, setPreset] = useState<string>(initial?.preset ?? presets[0]?.id ?? "custom");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? presets[0]?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? presets[0]?.models[0] ?? "");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string; ms: number } | null>(null);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const p: Preset | undefined = presets.find((x) => x.id === preset);
  const dirty = !initial || initial.preset !== preset || initial.baseUrl !== baseUrl || initial.model !== model || apiKey !== "";

  const pick = (id: string) => {
    const np = presets.find((x) => x.id === id);
    setPreset(id);
    if (np) {
      if (np.baseUrl || id !== "custom") setBaseUrl(np.baseUrl);
      setModel(np.models[0] ?? "");
    }
    setTest(null);
  };

  const body = () => ({ preset, baseUrl, apiKey, model });

  const save = async () => {
    setBusy("save");
    setErr(null);
    try {
      await api("PUT", `/api/agents/${agent.id}/brain`, body());
      setApiKey("");
      await ctx.reload();
      ctx.toast(`${agent.name} · ${t("brainTitle")}: ${t("saved")}`);
    } catch (e) {
      const d = (e as ApiError).detail as { field?: string } | undefined;
      setErr({ field: d?.field, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; message: string; ms: number }>("POST", `/api/agents/${agent.id}/brain/test`, body());
      setTest(r);
    } catch (e) {
      const d = (e as ApiError).detail as { field?: string } | undefined;
      setErr({ field: d?.field, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    try {
      await api("PUT", `/api/agents/${agent.id}/brain`, { clear: true });
      await ctx.reload();
    } catch (e) {
      ctx.toast(errText(t, e), "error");
    }
  };

  if (agent.mode === "manual") {
    return (
      <div className="col">
        <div className="col-head">
          <h4>{t("brainTitle")}</h4>
        </div>
        <p className="muted small">{t("brainComingSoon")}</p>
      </div>
    );
  }

  return (
    <div className="col" data-testid={`brain-${agent.id}`}>
      <div className="col-head">
        <h4>{t("brainTitle")}</h4>
        {initial && (
          <button className="btn btn-ghost btn-xs" onClick={clear}>
            {t("brainClear")}
          </button>
        )}
      </div>
      <p className="muted small">{t("brainHelp")}</p>
      <div className="seg" role="radiogroup" aria-label={t("provider")}>
        {presets.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={x.id === preset} className={`seg-btn ${x.id === preset ? "active" : ""}`} onClick={() => pick(x.id)}>
            {x.id === "custom" ? t("presetCustom") : x.label}
          </button>
        ))}
      </div>
      {p?.noteKey && hasKey(p.noteKey) && <p className="note">{t(p.noteKey as MsgKey)}</p>}
      <Field label={t("baseUrl")} error={err?.field === "baseUrl" ? err.message : null}>
        <input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" spellCheck={false} readOnly={preset !== "custom" && Boolean(p?.baseUrl)} />
      </Field>
      <Field label={t("apiKey")} error={err?.field === "apiKey" ? err.message : null} hint={initial?.hasApiKey ? t("apiKeySaved", { masked: initial.apiKeyMasked }) : undefined}>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial?.hasApiKey ? initial.apiKeyMasked : p?.keyHint ?? "sk-…"}
          data-testid={`brain-key-${agent.id}`}
        />
      </Field>
      <Field label={t("model")} error={err?.field === "model" ? err.message : null} hint={agent.id === "claude" ? t("modelOptional") : undefined}>
        <input className="input mono" list={`models-${agent.id}`} value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} data-testid={`brain-model-${agent.id}`} />
        <datalist id={`models-${agent.id}`}>
          {p?.models.map((m) => <option key={m} value={m} />)}
        </datalist>
      </Field>
      {err && !err.field && <Callout tone="error">{err.message}</Callout>}
      {test && (
        <div className={`test-result ${test.ok ? "ok" : "fail"}`} data-testid={`brain-test-${agent.id}`}>
          <span className="dot" /> {test.ok ? t("testOk", { ms: test.ms }) : t("testFail", { message: test.message })}
          {!test.ok && <div className="muted small">{t("testFailContinue")}</div>}
        </div>
      )}
      <div className="row gap">
        <button className="btn btn-sm" onClick={runTest} disabled={busy !== null || !baseUrl}>
          {busy === "test" ? (
            <>
              <Spinner /> {t("testing")}
            </>
          ) : (
            t("testConnection")
          )}
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy !== null || !dirty} data-testid={`brain-save-${agent.id}`}>
          {busy === "save" ? <Spinner /> : dirty ? t("save") : t("saved")}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- wallet

function WalletPanel({ agent, ctx }: { agent: AgentView; ctx: CardContext }) {
  const t = useT();
  const w = agent.wallet;
  const canDelegate = ctx.accountStatus?.can_create_children !== false && ctx.accountStatus?.can_delegate !== false;
  const [tab, setTab] = useState<"child" | "paste">(canDelegate ? "child" : "paste");
  const [daily, setDaily] = useState(ctx.defaults?.daily_budget ?? "");
  const [per, setPer] = useState(ctx.defaults?.per_request_limit ?? "");
  const [total, setTotal] = useState(ctx.defaults?.total_budget ?? "");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!canDelegate) setTab("paste");
  }, [canDelegate]);
  useEffect(() => {
    if (ctx.defaults && !daily) {
      setDaily(ctx.defaults.daily_budget);
      setPer(ctx.defaults.per_request_limit);
      setTotal(ctx.defaults.total_budget);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.defaults]);

  const over = (v: string, limit?: string) => limit !== undefined && v !== "" && Number(v) > Number(limit);
  const parentDaily = ctx.accountStatus?.remaining_today;
  const parentPer = ctx.accountStatus?.per_request_limit;

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("POST", `/api/agents/${agent.id}/wallet/child`, { daily_budget: daily, per_request_limit: per, total_budget: total });
      await ctx.reload();
    } catch (e) {
      const d = (e as ApiError).detail as { field?: string; parent_value?: string } | undefined;
      setErr(`${(e as Error).message}${d?.field ? ` (${d.field}${d.parent_value ? ` ≤ ${d.parent_value}` : ""})` : ""}`);
    } finally {
      setBusy(false);
    }
  };
  const usePasted = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("PUT", `/api/agents/${agent.id}/wallet`, { key: paste });
      setPaste("");
      await ctx.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (revoke: boolean) => {
    if (revoke && !window.confirm(t("walletRevokeConfirm"))) return;
    try {
      await api("DELETE", `/api/agents/${agent.id}/wallet`, { revoke });
      await ctx.reload();
    } catch (e) {
      ctx.toast(errText(t, e), "error");
    }
  };

  return (
    <div className="col" data-testid={`wallet-${agent.id}`}>
      <div className="col-head">
        <h4>{t("walletTitle")}</h4>
      </div>
      <p className="muted small">{t("walletHelp")}</p>
      {w ? (
        <div className="wallet-box">
          <div className="row between">
            <span className="tag">{w.source === "child" ? t("walletChild") : t("walletPasted")}</span>
            <code className="mono" data-testid={`wallet-key-${agent.id}`}>
              {w.keyMasked}
            </code>
          </div>
          {w.name && <div className="muted small">{w.name}</div>}
          <div className="wallet-limits">
            <div>
              <span className="k">{t("daily")}</span>
              <span className="v num">{money(w.dailyBudget)}</span>
            </div>
            <div>
              <span className="k">{t("perReq")}</span>
              <span className="v num">{money(w.perRequestLimit)}</span>
            </div>
            <div>
              <span className="k">{t("spentToday")}</span>
              <span className="v num" data-testid={`wallet-spent-${agent.id}`}>
                {money(ctx.spentToday)}
              </span>
            </div>
          </div>
          <div className="row gap">
            {agent.applied?.parts.wallet ? (
              <span className="muted small">{t("walletTurnOffFirst")}</span>
            ) : (
              <>
                <button className="btn btn-ghost btn-xs" onClick={() => remove(false)}>
                  {t("walletRemove")}
                </button>
                {w.source === "child" && w.childId && (
                  <button className="btn btn-ghost btn-xs danger" onClick={() => remove(true)}>
                    {t("walletRevoke")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ) : !ctx.hasAccount ? (
        <p className="muted small">{t("walletNeedsAccount")}</p>
      ) : (
        <>
          <div className="tabs">
            <button className={`tab ${tab === "child" ? "active" : ""}`} onClick={() => setTab("child")} disabled={!canDelegate}>
              {t("walletNewChild")}
            </button>
            <button className={`tab ${tab === "paste" ? "active" : ""}`} onClick={() => setTab("paste")}>
              {t("walletPaste")}
            </button>
          </div>
          {tab === "child" ? (
            <div className="child-form">
              <div className="grid3">
                <Field label={`${t("daily")} ($)`} error={over(daily, parentDaily) ? `≤ ${money(parentDaily)}` : null}>
                  <input className="input num" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} data-testid={`child-daily-${agent.id}`} />
                </Field>
                <Field label={`${t("perReq")} ($)`} error={over(per, parentPer) ? `≤ ${money(parentPer)}` : null}>
                  <input className="input num" inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} data-testid={`child-per-${agent.id}`} />
                </Field>
                <Field label={`${t("total")} ($)`}>
                  <input className="input num" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} data-testid={`child-total-${agent.id}`} />
                </Field>
              </div>
              <p className="muted small">{t("childHint", { daily: money(parentDaily), per: money(parentPer) })}</p>
              <button className="btn btn-sm btn-primary" onClick={create} disabled={busy || !daily || !per || !total} data-testid={`child-create-${agent.id}`}>
                {busy ? (
                  <>
                    <Spinner /> {t("creating")}
                  </>
                ) : (
                  t("createChild")
                )}
              </button>
            </div>
          ) : (
            <div className="child-form">
              <Field label={t("pasteKeyLabel")}>
                <input className="input mono" type="password" autoComplete="off" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="mk_live_…" />
              </Field>
              <button className="btn btn-sm btn-primary" onClick={usePasted} disabled={busy || !paste.startsWith("mk_live_")}>
                {t("useKey")}
              </button>
            </div>
          )}
          {!canDelegate && tab === "paste" && <p className="note">{t("walletCannotDelegate")}</p>}
          {err && <Callout tone="error">{err}</Callout>}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- manual

function ManualPanel({ agent }: { agent: AgentView }) {
  const t = useT();
  return (
    <div className="manual">
      <p className="muted small">{agent.manual.length ? t("manualIntro") : t("manualNeedsWallet")}</p>
      {agent.manual.map((s) => (
        <div key={s.titleKey} className="manual-step">
          <div className="manual-title">{hasKey(s.titleKey) ? t(s.titleKey as MsgKey) : s.titleKey}</div>
          {s.code && (
            <div className="code-wrap">
              <pre className="cmd">{s.code}</pre>
              {s.copy && <CopyButton text={s.copy} small />}
            </div>
          )}
          {s.rows?.map((r) => (
            <div key={r.labelKey} className="kv">
              <span className="k">{hasKey(r.labelKey) ? t(r.labelKey as MsgKey) : r.labelKey}</span>
              <code className="v">{r.value}</code>
              {r.copy && <CopyButton text={r.copy} small />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------- card

export function AgentCard({ agent, ctx }: { agent: AgentView; ctx: CardContext }) {
  const t = useT();
  const [modal, setModal] = useState<{ action: "enable" | "disable"; plan: AgentPlan; planId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [cardErr, setCardErr] = useState<string | null>(null);
  const av = AVATAR[agent.id];
  const on = agent.status !== "disabled";
  const canEnable = agent.mode === "auto" && agent.detection.installed && (agent.brain || agent.wallet);

  const statusPill = useMemo(() => {
    if (agent.mode === "manual") return <Pill tone="gray">{t("manualBadge")}</Pill>;
    if (agent.status === "enabled") return <Pill tone="green">{t("statusEnabled")}</Pill>;
    if (agent.status === "drifted")
      return (
        <Pill tone="yellow" title={t("statusDriftedHelp")}>
          {t("statusDrifted")}
        </Pill>
      );
    return <Pill tone="gray">{t("statusDisabled")}</Pill>;
  }, [agent.mode, agent.status, t]);

  const openPreview = async (action: "enable" | "disable") => {
    setCardErr(null);
    setModalErr(null);
    try {
      const r = await api<{ plan: AgentPlan; planId: string }>("POST", `/api/agents/${agent.id}/preview`, { action });
      setModal({ action, ...r });
    } catch (e) {
      setCardErr((e as Error).message);
    }
  };

  const confirm = async () => {
    if (!modal) return;
    setBusy(true);
    setModalErr(null);
    try {
      await api("POST", `/api/agents/${agent.id}/apply`, { action: modal.action, planId: modal.planId });
      ctx.toast(modal.action === "enable" ? t("writtenOk", { agent: agent.name }) : t("disabledOk", { agent: agent.name }));
      setModal(null);
      await ctx.reload();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "PLAN_CHANGED") {
        // Re-preview so the user sees what is actually on disk now.
        try {
          const r = await api<{ plan: AgentPlan; planId: string }>("POST", `/api/agents/${agent.id}/preview`, { action: modal.action });
          setModal({ action: modal.action, ...r });
        } catch {
          // keep old
        }
      }
      setModalErr(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`agent-card ${agent.detection.installed ? "" : "not-installed"}`} data-testid={`card-${agent.id}`} data-status={agent.status}>
      <header className="agent-head">
        <div className="agent-avatar" style={{ background: av.bg }}>
          {av.letter}
        </div>
        <div className="agent-title">
          <h3>{agent.name}</h3>
          <div className="muted small" title={agent.detection.via ?? undefined}>
            {agent.detection.installed ? `${t("detected")}${agent.detection.version ? ` · ${agent.detection.version}` : ""}` : t("notDetected")}
          </div>
        </div>
        <div className="agent-status">
          {statusPill}
          {agent.wallet && (
            <div className="muted small">
              {t("spentToday")} <span className="num">{money(ctx.spentToday)}</span>
            </div>
          )}
        </div>
      </header>

      <div className="agent-body">
        <BrainPanel key={`${agent.brain?.preset}-${agent.brain?.baseUrl}-${agent.brain?.model}-${agent.brain?.apiKeyMasked}`} agent={agent} ctx={ctx} />
        <div className="col-divider" />
        <WalletPanel agent={agent} ctx={ctx} />
      </div>

      {agent.mode === "manual" ? (
        <ManualPanel agent={agent} />
      ) : (
        <footer className="agent-foot">
          <div className="foot-left">
            <Switch
              checked={on}
              disabled={!on && !canEnable}
              label={t("enableLabel")}
              testId={`toggle-${agent.id}`}
              onChange={() => openPreview(on ? "disable" : "enable")}
            />
            <div>
              <div className="foot-label">{t("enableLabel")}</div>
              <div className="muted small">
                {agent.applied
                  ? t("enabledAt", { when: new Date(agent.applied.at).toLocaleString() })
                  : !agent.detection.installed
                    ? t("notInstalledEnable")
                    : !canEnable
                      ? t("enableNeedsSomething")
                      : ""}
              </div>
            </div>
          </div>
          {on && (
            <button className="btn btn-sm" onClick={() => openPreview("enable")} data-testid={`reapply-${agent.id}`}>
              {t("reapply")}
            </button>
          )}
          {agent.applied && agent.applied.backups.length > 0 && (
            <details className="backups">
              <summary className="muted small">
                {t("backups")} ({agent.applied.backups.length})
              </summary>
              {agent.applied.backups.map((b) => (
                <code key={b} className="small">
                  {b}
                </code>
              ))}
            </details>
          )}
          {cardErr && <Callout tone="error">{cardErr}</Callout>}
        </footer>
      )}

      {modal && (
        <DiffModal
          title={modal.action === "enable" ? t("diffEnableTitle", { agent: agent.name }) : t("diffDisableTitle", { agent: agent.name })}
          intro={modal.action === "enable" ? t("diffIntro") : t("diffDisableIntro")}
          plans={[{ plan: modal.plan }]}
          busy={busy}
          error={modalErr}
          confirmLabel={modal.action === "enable" ? t("confirmWrite") : t("confirmDisable")}
          onConfirm={confirm}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}
