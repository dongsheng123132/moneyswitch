import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type BulkPreview, type StateView, type UsageView } from "./api";
import { AgentCard, type CardContext } from "./AgentCard";
import { DiffModal } from "./DiffModal";
import { LangContext, useT, type Lang } from "./i18n";
import { Callout, Field, money, Pill, Spinner } from "./ui";

function LangSwitch() {
  const { lang, setLang } = React.useContext(LangContext);
  return (
    <div className="lang-switch" role="group" aria-label="language">
      {(["zh", "en"] as Lang[]).map((l) => (
        <button key={l} className={lang === l ? "active" : ""} onClick={() => setLang(l)}>
          {l === "zh" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}

function AccountCard({ state, usage, onChanged, refreshUsage }: { state: StateView; usage: UsageView | null; onChanged: () => Promise<void>; refreshUsage: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(!state.account);
  const [server, setServer] = useState(state.account?.server ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = usage?.account;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("PUT", "/api/account", { server, key });
      setKey("");
      setEditing(false);
      await onChanged();
    } catch (e2) {
      setErr((e2 as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing || !state.account) {
    return (
      <section className="panel account" data-testid="account-card">
        <div className="panel-head">
          <h2>{t("accountTitle")}</h2>
        </div>
        <p className="muted">{t("accountHelp")}</p>
        <form className="account-form" onSubmit={submit}>
          <Field label={t("serverLabel")}>
            <input className="input mono" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://moneyswitch.example.com" data-testid="account-server" spellCheck={false} />
          </Field>
          <Field label={t("keyLabel")}>
            <input className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="mk_live_…" data-testid="account-key" />
          </Field>
          <div className="account-actions">
            <button className="btn btn-primary" disabled={busy || !server || !key} data-testid="account-connect">
              {busy ? (
                <>
                  <Spinner /> {t("connecting")}
                </>
              ) : (
                t("connect")
              )}
            </button>
            {state.account && (
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
            )}
          </div>
        </form>
        {err && <Callout tone="error">{err}</Callout>}
      </section>
    );
  }

  const canDelegate = st ? st.can_create_children !== false && st.can_delegate !== false : null;
  return (
    <section className="panel account" data-testid="account-card">
      <div className="panel-head">
        <h2>{t("accountTitle")}</h2>
        <div className="row gap">
          <button className="btn btn-ghost btn-sm" onClick={refreshUsage}>
            {t("refresh")}
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            {t("change")}
          </button>
        </div>
      </div>
      <div className="account-grid">
        <div className="account-id">
          <div className="k">{t("serverLabel")}</div>
          <code className="v">{state.account.server}</code>
          <div className="k">{t("keyLabel")}</div>
          <code className="v" data-testid="account-key-masked">
            {state.account.keyMasked}
          </code>
          {st?.key_name && <div className="muted small">{st.key_name}</div>}
        </div>
        <div className="stat">
          <div className="k">{t("remainingToday")}</div>
          <div className="big num" data-testid="account-remaining-today">
            {money(st?.remaining_today)}
          </div>
          <div className="muted small">{t("ofDaily", { amount: money(st?.daily_budget) })}</div>
        </div>
        <div className="stat">
          <div className="k">{t("remainingTotal")}</div>
          <div className="big num">{money(st?.remaining_total)}</div>
          <div className="muted small">
            {t("perRequest")} {money(st?.per_request_limit)}
          </div>
        </div>
        <div className="stat">
          <div className="k">&nbsp;</div>
          {canDelegate === null ? null : canDelegate ? (
            <Pill tone="green">{t("canDelegateYes")}</Pill>
          ) : (
            <>
              <Pill tone="yellow">{t("canDelegateNo")}</Pill>
              <div className="muted small">{t("canDelegateNoHelp")}</div>
            </>
          )}
        </div>
      </div>
      {usage?.error && <Callout tone="error">{t("accountUnreachable", { message: usage.error.message })}</Callout>}
    </section>
  );
}

function BulkBar({ state, usage, toast, reload }: { state: StateView; usage: UsageView | null; toast: CardContext["toast"]; reload: () => Promise<void> }) {
  const t = useT();
  const [pv, setPv] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const detected = state.agents.filter((a) => a.mode === "auto" && a.detection.installed);
  const st = usage?.account;
  if (!state.account || !st) return null;
  const canDelegate = st.can_create_children !== false && st.can_delegate !== false;
  if (!canDelegate) return null;

  const open = async () => {
    setErr(null);
    setModalErr(null);
    try {
      setPv(await api<BulkPreview>("POST", "/api/bulk/preview", {}));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const confirm = async () => {
    if (!pv) return;
    setBusy(true);
    try {
      const r = await api<{ done: { agent: string }[] }>("POST", "/api/bulk/apply", { planId: pv.planId });
      toast(r.done.map((d) => t("writtenOk", { agent: state.agents.find((a) => a.id === d.agent)?.name ?? d.agent })).join(" "));
      setPv(null);
      await reload();
    } catch (e) {
      setModalErr((e as Error).message);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel bulk" data-testid="bulk-bar">
      <div>
        <h3>{t("bulkTitle")}</h3>
        <p className="muted">
          {detected.length
            ? t("bulkBody", { amount: money(st.remaining_today), agents: detected.map((a) => a.name).join(" · ") })
            : t("bulkNone")}
        </p>
        {err && <Callout tone="error">{err}</Callout>}
      </div>
      <button className="btn btn-primary" disabled={!detected.length} onClick={open} data-testid="bulk-preview">
        {t("bulkButton")}
      </button>
      {pv && (
        <DiffModal
          title={t("diffBulkTitle")}
          intro={t("diffIntro")}
          extra={
            <Callout tone="info">
              {t("bulkEach", { daily: money(pv.budgets.daily_budget), per: money(pv.budgets.per_request_limit), total: money(pv.budgets.total_budget) })}
            </Callout>
          }
          plans={pv.items.map((i) => ({
            plan: i.plan,
            heading: <h3 className="plan-agent">{state.agents.find((a) => a.id === i.agent)?.name}</h3>,
          }))}
          busy={busy}
          error={modalErr}
          confirmLabel={t("confirmWrite")}
          onConfirm={confirm}
          onClose={() => setPv(null)}
        />
      )}
    </section>
  );
}

export function App() {
  const t = useT();
  const [state, setState] = useState<StateView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: "ok" | "error" }[]>([]);

  const toast = useCallback((msg: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 6000);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await api<UsageView>("GET", "/api/usage"));
    } catch {
      // usage is best effort
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setState(await api<StateView>("GET", "/api/state"));
      void loadUsage();
    } catch (e) {
      setFatal((e as ApiError).message);
    }
  }, [loadUsage]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void loadUsage(), 30_000);
    return () => clearInterval(id);
  }, [reload, loadUsage]);

  const defaults = useMemo(() => {
    const st = usage?.account;
    if (!st?.remaining_today) return null;
    // A single card suggests half of what is left today (the rest stays with you / other agents).
    const half = Math.floor((Number(st.remaining_today) / 2) * 100) / 100;
    const per = Math.min(half, Number(st.per_request_limit ?? half));
    const total = Math.floor((Number(st.remaining_total ?? half) / 2) * 100) / 100;
    return { daily_budget: half.toFixed(2), per_request_limit: per.toFixed(2), total_budget: total.toFixed(2) };
  }, [usage]);

  if (fatal) return <Callout tone="error">{fatal}</Callout>;
  if (!state) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }
  const sorted = [...state.agents].sort((a, b) => Number(b.detection.installed) - Number(a.detection.installed) || (a.mode === b.mode ? 0 : a.mode === "auto" ? -1 : 1));

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">$</div>
          <div>
            <div className="brand-name">{t("appTitle")}</div>
            <div className="muted small">{t("appSubtitle")}</div>
          </div>
        </div>
        <div className="row gap">
          <Pill tone="accent">{t("localBadge")}</Pill>
          <Pill tone="green">{t("sessionOk")}</Pill>
          <LangSwitch />
        </div>
      </header>

      <main className="content">
        <AccountCard state={state} usage={usage} onChanged={reload} refreshUsage={loadUsage} />
        <BulkBar state={state} usage={usage} toast={toast} reload={reload} />
        <div className="section-head">
          <h2>{t("agentsTitle")}</h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              setState(await api<StateView>("POST", "/api/detect", {}));
            }}
          >
            {t("redetect")}
          </button>
        </div>
        <div className="agent-grid">
          {sorted.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              ctx={{
                accountStatus: usage?.account ?? null,
                hasAccount: Boolean(state.account),
                spentToday: usage?.agents[a.id]?.used_today ?? null,
                reload,
                toast,
                defaults,
              }}
            />
          ))}
        </div>
      </main>

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast toast-${x.tone}`} data-testid="toast">
            {x.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
