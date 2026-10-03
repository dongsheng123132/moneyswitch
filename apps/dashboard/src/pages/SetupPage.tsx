import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { Check, Circle, Loader2, ArrowRight, SkipForward } from "lucide-react";
import { useAuth } from "../auth";
import { usePolling } from "../usePolling";
import {
  claimSetupToken,
  createKey,
  getWallet,
  listChannels,
  listKeys,
  ApiError,
  type CreateMoneyKeyResponse,
} from "../api";
import { formatUsdc, toMicros } from "../money";
import { useT } from "../i18n";
import { setupStrings } from "../i18n/strings/setup";
import { common } from "../i18n/strings/common";
import LangSwitch from "../components/LangSwitch";
import Callout from "../components/Callout";
import Snippet from "../components/Snippet";
import SkillForAi from "../components/SkillForAi";
import CopyButton from "../components/CopyButton";
import Term from "../components/Term";
import SecretNotice from "../components/SecretNotice";
import PublicAddress from "../components/PublicAddress";
import { ThreeThingsButton } from "../components/ThreeThings";
import { useAdminMeta } from "../useAdminMeta";
import { skillBaseUrl } from "../skillText";
import { claudeMcpCommand, openaiBase, useCliSource } from "../snippets";
import { FundingGuide } from "./WalletPage";
import { WalletAccess } from "../components/WalletAccess";
import { WalletSetup, BackupRequired } from "../components/WalletSetup";
import { addDemoChannel } from "./ChannelsPage";
import { fetchDemoMode, PLAYGROUND_KEY_STORAGE } from "../demoMode";
import "../styles/setup.css";

const SKIPPED_KEY = "moneyswitch_setup_skipped";
const HIDDEN_KEY = "moneyswitch_setup_hidden";
const ACK_KEY = "moneyswitch_setup_token_saved";
const RESET_CMD = "pnpm admin:reset-token -- --data-dir <MONEYSWITCH_DATA_DIR>";

type StepId = "admin" | "wallet" | "channel" | "key" | "connect";
const STEPS: StepId[] = ["admin", "wallet", "channel", "key", "connect"];

// Survives React StrictMode's double effect run: a setup token is single-use.
let claimInFlight: Promise<string> | null = null;

function readSkipped(): Set<StepId> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SKIPPED_KEY) ?? "[]") as StepId[]);
  } catch {
    return new Set();
  }
}

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;

/** host:port of each enabled channel, used as the new key's allowed hosts (only matters for paid fetch). */
function hostsFromChannels(channels: Array<{ base_url: string; enabled: boolean }>): string[] {
  const hosts = new Set<string>();
  for (const c of channels) {
    if (!c.enabled) continue;
    try {
      const u = new URL(c.base_url);
      hosts.add(`${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`);
    } catch {
      // skip malformed
    }
  }
  return [...hosts];
}

export default function SetupPage() {
  const t = useT(setupStrings);
  const tc = useT(common);
  const { token, loginAdmin } = useAuth();
  const navigate = useNavigate();

  // --- one-time setup link claim (/setup#ms_setup_…) -------------------------
  // "#ms_setup_…" (printed on first boot); the offline demo appends
  // "&demo_key=mk_live_…" so the Playground is ready to use (demo mode only).
  const [{ hashToken, demoKey }] = useState(() => {
    const h = window.location.hash;
    if (!h.startsWith("#ms_setup_")) return { hashToken: null, demoKey: null };
    const [tok, rest] = h.slice(1).split("&", 2);
    const dk = new URLSearchParams(rest ?? "").get("demo_key");
    return { hashToken: tok, demoKey: dk && dk.startsWith("mk_live_") ? dk : null };
  });
  const [demoLanding, setDemoLanding] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedToken, setClaimedToken] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(Boolean(hashToken) && !token);

  useEffect(() => {
    if (!hashToken) return;
    // Remove the secret from the address bar / history entry immediately.
    window.history.replaceState(null, "", "/setup");
    if (token) {
      setClaiming(false);
      return;
    }
    claimInFlight = claimInFlight ?? claimSetupToken(hashToken);
    claimInFlight
      .then(async (admin) => {
        await loginAdmin(admin);
        // Offline demo: everything is pre-configured, so skip the wizard and
        // land on the overview (its guide card), with the demo key in the
        // Playground. Only when the server itself says it is the demo.
        if (await fetchDemoMode()) {
          if (demoKey) sessionStorage.setItem(PLAYGROUND_KEY_STORAGE, demoKey);
          setDemoLanding(true);
          return;
        }
        setClaimedToken(admin);
        sessionStorage.removeItem(ACK_KEY);
      })
      .catch((e) => setClaimError(e instanceof ApiError && e.code ? e.code : "network"))
      .finally(() => setClaiming(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (claiming) {
    return (
      <SetupShell>
        <div className="card setup-claim">
          <Loader2 className="spin" size={18} /> {t("claiming")}
        </div>
      </SetupShell>
    );
  }
  if (claimError && !token) {
    const known = ["SETUP_USED", "SETUP_EXPIRED", "SETUP_INVALID"].includes(claimError) ? claimError : null;
    return (
      <SetupShell>
        <div className="card setup-claim-error">
          <Callout tone={claimError === "SETUP_USED" ? "error" : "warn"} title={known ? t(`claim_${known}_title` as "claim_SETUP_USED_title") : undefined}>
            {known ? t(`claim_${known}_body` as "claim_SETUP_USED_body") : t("claim_generic_body")}
          </Callout>
          <Snippet code={RESET_CMD} />
          <Link className="btn" to="/login">
            {t("goLogin")}
          </Link>
        </div>
      </SetupShell>
    );
  }
  if (!token) return <Navigate to="/login" replace />;
  if (demoLanding) return <Navigate to="/" replace />;

  return <Wizard claimedToken={claimedToken} onFinish={() => navigate("/")} />;
}

function SetupShell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  const t = useT(setupStrings);
  return (
    <div className="setup-shell">
      <header className="setup-top">
        <div className="brand setup-brand">
          <div className="brand-mark">M</div>
          <div className="brand-name">MoneySwitch</div>
        </div>
        <div className="setup-top-right">
          {right}
          <LangSwitch />
        </div>
      </header>
      <main className="setup-main" id="main">
        <h1 className="setup-title">{t("title")}</h1>
        <p className="setup-subtitle">{t("subtitle")}</p>
        {children}
      </main>
    </div>
  );
}

function Wizard({ claimedToken, onFinish }: { claimedToken: string | null; onFinish: () => void }) {
  const t = useT(setupStrings);
  const meta = useAdminMeta();
  const cliSrc = useCliSource(meta);
  const { data: wallet, refresh: refreshWallet } = usePolling(getWallet, 3000);
  const { data: channels, refresh: refreshChannels } = usePolling(listChannels, 3000);
  const { data: keys, refresh: refreshKeys } = usePolling(listKeys, 3000);
  const [skipped, setSkipped] = useState<Set<StepId>>(readSkipped);
  const [ack, setAck] = useState(() => sessionStorage.getItem(ACK_KEY) === "1");
  const [createdKey, setCreatedKey] = useState<CreateMoneyKeyResponse | null>(null);
  const [active, setActive] = useState<StepId | null>(null);

  const done: Record<StepId, boolean> = {
    admin: claimedToken ? ack : true,
    // done = it exists, is open, and its recovery phrase is written down (nobody should fund it before that)
    wallet: Boolean(wallet?.has_keystore && wallet.unlocked && wallet.health?.backup !== "missing"),
    channel: (channels?.length ?? 0) > 0,
    key: (keys?.length ?? 0) > 0,
    connect: Boolean(keys?.some((k) => k.last_used_at)),
  };
  const loaded = wallet != null && channels != null && keys != null;

  // Land on the first step that is neither done nor skipped (once data is in).
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!loaded || autoPicked.current) return;
    autoPicked.current = true;
    setActive(STEPS.find((s) => s !== "channel" && !done[s] && !skipped.has(s)) ?? "connect");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  function persistSkipped(next: Set<StepId>) {
    setSkipped(next);
    sessionStorage.setItem(SKIPPED_KEY, JSON.stringify([...next]));
  }
  function goNext(from: StepId) {
    const idx = STEPS.indexOf(from);
    const next = STEPS.slice(idx + 1).find((s) => s !== "channel" && !done[s]) ?? STEPS[Math.min(idx + 1, STEPS.length - 1)];
    setActive(next);
  }
  function skip(step: StepId) {
    const next = new Set(skipped);
    next.add(step);
    persistSkipped(next);
    goNext(step);
  }
  function finish() {
    localStorage.setItem(HIDDEN_KEY, "1");
    onFinish();
  }

  const allDone = STEPS.every((s) => s === "channel" || done[s]);
  const current = active ?? "admin";

  const stepTitle: Record<StepId, string> = {
    admin: t("s1_title"),
    wallet: t("s2_title"),
    channel: t("s3_title"),
    key: t("s4_title"),
    connect: t("s5_title"),
  };
  const stepDesc: Record<StepId, string> = {
    admin: t("s1_desc"),
    wallet: t("s2_desc"),
    channel: t("s3_desc"),
    key: t("s4_desc"),
    connect: t("s5_desc"),
  };

  return (
    <SetupShell
      right={
        <Link className="btn secondary small" to="/" onClick={() => localStorage.setItem(HIDDEN_KEY, allDone ? "1" : localStorage.getItem(HIDDEN_KEY) ?? "0")}>
          {t("toConsole")}
        </Link>
      }
    >
      <div className="setup-body">
        <ol className="setup-steps" aria-label={t("stepsLabel")}>
          {STEPS.map((s, i) => {
            const state = done[s] ? "done" : skipped.has(s) ? "skipped" : current === s ? "current" : "todo";
            return (
              <li key={s}>
                <button
                  type="button"
                  className={`setup-step ${state} ${current === s ? "selected" : ""}`}
                  aria-current={current === s ? "step" : undefined}
                  onClick={() => setActive(s)}
                >
                  <span className={`setup-step-mark ${state}`} aria-hidden>
                    {done[s] ? <Check size={14} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="setup-step-text">
                    <span className="setup-step-title">{stepTitle[s]}</span>
                    <span className="setup-step-state">{t(`state_${state}` as "state_done")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <section className="card setup-panel" aria-labelledby="setup-panel-title">
          <div className="setup-panel-head">
            <div>
              <h2 id="setup-panel-title">
                {STEPS.indexOf(current) + 1}. {stepTitle[current]}
              </h2>
              <div className="setup-panel-desc">{stepDesc[current]}</div>
            </div>
            {done[current] && (
              <span className="pill pill-green">
                <Check size={12} /> {t("state_done")}
              </span>
            )}
          </div>

          {current === "admin" && <AdminStep claimedToken={claimedToken} ack={ack} setAck={(v) => { setAck(v); sessionStorage.setItem(ACK_KEY, v ? "1" : "0"); }} />}
          {current === "wallet" && <WalletStep wallet={wallet} refresh={refreshWallet} />}
          {current === "channel" && <ChannelStep channels={channels ?? []} demoSellerUrl={meta?.demo_seller_url ?? null} metaLoaded={meta != null} refresh={refreshChannels} />}
          {current === "key" && (
            <KeyStep
              keysCount={keys?.length ?? 0}
              channels={channels ?? []}
              created={createdKey}
              onCreated={(k) => {
                setCreatedKey(k);
                refreshKeys();
              }}
            />
          )}
          {current === "connect" && (
            <ConnectStep
              created={createdKey}
              usedAt={createdKey ? keys?.find((k) => k.id === createdKey.id)?.last_used_at ?? null : null}
              cliSrc={cliSrc}
              skillBase={skillBaseUrl(meta, window.location.origin)}
            />
          )}

          <div className="setup-actions">
            {!done[current] && current !== "connect" && (
              <button type="button" className="btn ghost" onClick={() => skip(current)}>
                <SkipForward size={14} /> {t("skipStep")}
              </button>
            )}
            <div style={{ flex: 1 }} />
            {current !== "connect" ? (
              <button type="button" className="btn" onClick={() => goNext(current)} disabled={current === "admin" && !done.admin}>
                {t("nextStep")} <ArrowRight size={14} />
              </button>
            ) : (
              <button type="button" className="btn" onClick={finish}>
                {t("finish")} <ArrowRight size={14} />
              </button>
            )}
          </div>
          {allDone && current === "connect" && <Callout tone="success">{t("allDone")}</Callout>}
        </section>
      </div>
    </SetupShell>
  );
}

// --- Step 1 ------------------------------------------------------------------

function AdminStep({ claimedToken, ack, setAck }: { claimedToken: string | null; ack: boolean; setAck: (v: boolean) => void }) {
  const t = useT(setupStrings);
  if (!claimedToken) {
    return (
      <div>
        <Callout tone="success">{t("s1_signedIn")}</Callout>
        <p className="setup-note">{t("s1_lost")}</p>
      </div>
    );
  }
  return (
    <div>
      <p className="setup-text">
        <Term k="adminToken">{t("s1_claimed")}</Term>
      </p>
      <div className="key-big">{claimedToken}</div>
      <CopyButton text={claimedToken} />
      <label className="setup-check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        {t("s1_ack")}
      </label>
      <p className="setup-note">{t("s1_lost")}</p>
    </div>
  );
}

// --- Step 2 ------------------------------------------------------------------

/** Wizard step 2. Exported so a render test can pin what a person sees at each stage. */
export function WalletStep({ wallet, refresh }: { wallet: Awaited<ReturnType<typeof getWallet>> | null; refresh: () => void }) {
  const t = useT(setupStrings);
  if (!wallet) return <div className="setup-note">…</div>;
  // 1. no wallet yet: one click creates it (no password), the phrase is shown and checked
  if (!wallet.has_keystore) return <WalletSetup onDone={refresh} />;
  // 2. a wallet that is closed (manual mode after a restart, or a broken unlock secret)
  if (!wallet.unlocked) return <WalletAccess wallet={wallet} onChanged={refresh} />;
  // 3. open, but the recovery phrase is not written down: the deposit address stays hidden
  if (wallet.health?.backup === "missing") return <BackupRequired onConfirmed={refresh} />;

  const balance = wallet.usdc_balance;
  const funded = balance != null && toMicros(balance) > 0n;
  return (
    <div>
      <div className="setup-wallet">
        <div className="setup-wallet-main">
          <div className="stat-label">{t("s2_address")}</div>
          {wallet.address && <PublicAddress address={wallet.address} qr="never" />}
          <div className="setup-balance" role="status" aria-live="polite">
            {balance == null ? (
              <Callout tone="warn">{t("s2_rpcDown")}</Callout>
            ) : funded ? (
              <Callout tone="success">{t("s2_funded", { amount: formatUsdc(balance, { maxDecimals: 4 }) })}</Callout>
            ) : (
              <div className="setup-waiting">
                <Loader2 size={14} className="spin" /> {t("s2_waiting")}
              </div>
            )}
          </div>
        </div>
        {wallet.address && (
          <div className="setup-qr">
            <div className="qr-wrap">
              <QRCodeSVG value={wallet.address} size={120} />
            </div>
            <div className="field-hint">{t("s2_scan")}</div>
          </div>
        )}
      </div>
      {wallet.address && <FundingGuide address={wallet.address} />}
    </div>
  );
}

// --- Step 3 ------------------------------------------------------------------

function ChannelStep({
  channels,
  demoSellerUrl,
  metaLoaded,
  refresh,
}: {
  channels: Array<{ id: string; name: string; base_url: string; models: string[]; enabled: boolean }>;
  demoSellerUrl: string | null;
  metaLoaded: boolean;
  refresh: () => void;
}) {
  const t = useT(setupStrings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function addDemo() {
    setBusy(true);
    setErr(null);
    try {
      const ch = await addDemoChannel(demoSellerUrl);
      setOkMsg(t("s3_added", { n: ch.models.length }));
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="setup-text">
        <Term k="channel">{t("s3_intro")}</Term>
      </p>
      {okMsg && <Callout tone="success">{okMsg}</Callout>}
      {channels.length > 0 ? (
        <div>
          <div className="setup-note">{t("s3_have", { n: channels.length })}</div>
          <ul className="setup-list">
            {channels.map((c) => (
              <li key={c.id}>
                <span className="setup-list-name">{c.name}</span>
                <span className="mono dim">{c.base_url}</span>
                <span className="dim">{c.models.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          {metaLoaded && (
            <div className="setup-note">
              {demoSellerUrl ? t("s3_demoTarget", { url: demoSellerUrl }) : t("s3_demoUnknown")}
            </div>
          )}
          {err && <Callout tone="error">{err}</Callout>}
          <div className="btn-group">
            <button type="button" className="btn" onClick={addDemo} disabled={busy}>
              {busy ? t("s3_demoAdding") : t("s3_demo")}
            </button>
            <Link className="btn secondary" to="/channels">
              {t("s3_manual")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Step 4 ------------------------------------------------------------------

function KeyStep({
  keysCount,
  channels,
  created,
  onCreated,
}: {
  keysCount: number;
  channels: Array<{ base_url: string; enabled: boolean }>;
  created: CreateMoneyKeyResponse | null;
  onCreated: (k: CreateMoneyKeyResponse) => void;
}) {
  const t = useT(setupStrings);
  const [name, setName] = useState(() => t("s4_namePrefill"));
  const [daily, setDaily] = useState("0.50");
  const [per, setPer] = useState("0.10");
  const [threshold, setThreshold] = useState("");
  const [total, setTotal] = useState("5.00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid =
    name.trim().length > 0 &&
    [daily, per, total].every((v) => DECIMAL_RE.test(v.trim()) && toMicros(v) > 0n) &&
    (threshold.trim() === "" || DECIMAL_RE.test(threshold.trim()));
  const preview = useMemo(() => {
    if (!valid) return null;
    const price = 10_000n; // $0.01 in micro-USDC
    return { perDay: (toMicros(daily) / price).toString(), total: (toMicros(total) / price).toString() };
  }, [valid, daily, total]);

  if (created) {
    return (
      <div>
        <Callout tone="warn">{t("s4_created")}</Callout>
        <SecretNotice>
          <div className="key-big">{created.key}</div>
          <CopyButton text={created.key} />
        </SecretNotice>
        <p className="setup-note">{t("s4_more")}</p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await createKey({
        name: name.trim(),
        daily_budget: daily.trim(),
        per_request_limit: per.trim(),
        approval_threshold: threshold.trim() ? threshold.trim() : null,
        total_budget: total.trim(),
        allowed_hosts: hostsFromChannels(channels),
      });
      onCreated(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create_failed");
    } finally {
      setBusy(false);
    }
  }

  const input = (value: string, set: (v: string) => void, label: string, placeholder?: string) => (
    <input
      className="sentence-input"
      inputMode="decimal"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => set(e.target.value)}
      size={Math.max(4, value.length + 1)}
    />
  );

  return (
    <form onSubmit={submit} noValidate>
      {keysCount > 0 && <p className="setup-note">{t("s4_have", { n: keysCount })}</p>}
      <div className="field">
        <label htmlFor="setup-key-name">{t("s4_name")}</label>
        <input id="setup-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("s4_namePlaceholder")} />
      </div>
      <p className="sentence">
        {t("s4_sentence_1")}
        {input(daily, setDaily, t("s4_daily"))}
        {t("s4_sentence_2")}
        {input(per, setPer, t("s4_per"))}
        {t("s4_sentence_3")}
        {input(threshold, setThreshold, t("s4_threshold"), "—")}
        {t("s4_sentence_4")}
        {input(total, setTotal, t("s4_total"))}
        {t("s4_sentence_5")}
      </p>
      <div className="sentence-legend">
        <Term k="dailyBudget">{t("s4_daily")}</Term>
        <Term k="perRequestLimit">{t("s4_per")}</Term>
        <Term k="approvalThreshold">{t("s4_threshold")}</Term>
        <Term k="totalBudget">{t("s4_total")}</Term>
      </div>
      {preview ? (
        <div className="setup-preview">
          {t("s4_preview", preview)} {threshold.trim() === "" ? t("s4_noApproval") : t("s4_withApproval", { amount: threshold.trim() })}
        </div>
      ) : <Callout tone="warn">{t("s4_invalid")}</Callout>}
      {channels.length === 0 && <p className="setup-note">{t("s4_noChannelHosts")}</p>}
      {err && <Callout tone="error">{err}</Callout>}
      <button className="btn" type="submit" disabled={busy || !valid}>
        {busy ? t("s4_creating") : t("s4_create")}
      </button>
    </form>
  );
}

// --- Step 5 ------------------------------------------------------------------

/** Last wizard step. Exported so a render test can pin that the skill is offered first and the CLI/MCP command only under "other ways". */
export function ConnectStep({
  created,
  usedAt,
  cliSrc,
  skillBase,
}: {
  created: CreateMoneyKeyResponse | null;
  usedAt: string | null;
  cliSrc: ReturnType<typeof useCliSource>;
  /** Address to write into the skill (MONEYSWITCH_PUBLIC_URL, else this page's origin). */
  skillBase: string;
}) {
  const t = useT(setupStrings);
  const navigate = useNavigate();
  const origin = window.location.origin;
  if (!created) {
    return (
      <div>
        <p className="setup-text">{t("s5_noKey")}</p>
        <Link className="btn secondary" to="/connect">
          {t("s5_openConnect")}
        </Link>
      </div>
    );
  }
  return (
    <div>
      {/* The skill is the first way: ONE block for the AI that carries this server's address and this key. */}
      <SkillForAi baseUrl={skillBase} secret={created.key} keyName={created.name} />
      <div className="setup-status" role="status" aria-live="polite">
        {usedAt ? (
          <Callout tone="success">{t("s5_connected")}</Callout>
        ) : (
          <div className="setup-waiting">
            <Circle size={10} className="pulse" /> {t("s5_waiting")}
          </div>
        )}
      </div>
      <details className="setup-other">
        <summary>{t("s5_otherWays")}</summary>
        <p className="setup-text">{t("s5_intro")}</p>
        {cliSrc.kind === "npm" && <Callout tone="warn">{t("s5_npmWarn")}</Callout>}
        <Snippet title={t("s5_cmd")} code={claudeMcpCommand(cliSrc, origin, created.key)} />
        <div className="setup-sub">
          <div className="snippet-title">{t("s5_openai")}</div>
          <p className="setup-note">{t("s5_openaiNote", { base: openaiBase(origin) })}</p>
        </div>
      </details>
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          sessionStorage.setItem("moneyswitch_playground_key", created.key);
          navigate("/playground");
        }}
      >
        {t("s5_tryPlayground")}
      </button>
    </div>
  );
}
