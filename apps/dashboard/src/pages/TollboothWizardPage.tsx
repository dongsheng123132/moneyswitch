import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Callout from "../components/Callout";
import PayToField, { resolvePayTo, type PayToValue } from "../components/PayToField";
import { ThreeThingsButton } from "../components/ThreeThings";
import PublicAddress from "../components/PublicAddress";
import TollboothBuyerHelp from "../components/TollboothBuyerHelp";
import TollRulesEditor from "../components/TollRulesEditor";
import { useT } from "../i18n";
import { wizardStrings, tollRulesStrings } from "../i18n/strings/tollbooths";
import { common } from "../i18n/strings/common";
import { useCliSource } from "../snippets";
import { getAdminMeta, testUpstream, createTollbooth, ApiError, type AdminMeta, type TollRouteInput, type TollboothRow, type UpstreamProbe } from "../api";
import "../styles/tollbooths.css";

type Step = 1 | 2 | 3;

type Preset = "whole" | "chat" | "onlyOne" | "custom";

function presetRoutes(preset: Preset): { routes: TollRouteInput[]; defaultPrice: string | null } {
  switch (preset) {
    case "whole":
      return { routes: [], defaultPrice: "0.01" };
    case "chat":
      return { routes: [{ method: "POST", path_pattern: "/v1/chat/completions", price: "0.01", description: "" }], defaultPrice: "0" };
    case "onlyOne":
      return { routes: [{ method: "ANY", path_pattern: "/v1/example", price: "0.01", description: "" }], defaultPrice: null };
    default:
      return { routes: [], defaultPrice: null };
  }
}

function suggestName(upstream: string): string {
  try {
    const u = new URL(upstream);
    return `${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return "";
  }
}

export default function TollboothWizardPage() {
  const t = useT(wizardStrings);
  const tr = useT(tollRulesStrings);
  const tc = useT(common);
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [meta, setMeta] = useState<AdminMeta | null>(null);
  const cliSource = useCliSource(meta);

  // Step 1
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [upstream, setUpstream] = useState("");
  const [slug, setSlug] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [upstreamProbe, setUpstreamProbe] = useState<UpstreamProbe | "pending" | null>(null);

  // Step 2
  const [preset, setPreset] = useState<Preset>("chat");
  const [routes, setRoutes] = useState<TollRouteInput[]>(presetRoutes("chat").routes);
  const [defaultPrice, setDefaultPrice] = useState<string | null>(presetRoutes("chat").defaultPrice);

  // Step 3
  const [payTo, setPayTo] = useState<PayToValue>({ mode: "wallet", address: "" });
  const [payToServerError, setPayToServerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<TollboothRow | null>(null);

  // v0.5: fetch fresh admin meta on mount — the wallet may have just been
  // created in this same session, so the module-level useAdminMeta() cache
  // (populated once at app start) could still say wallet_address: null.
  useEffect(() => {
    let alive = true;
    getAdminMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p !== "custom") {
      const { routes: r, defaultPrice: d } = presetRoutes(p);
      setRoutes(r);
      setDefaultPrice(d);
    }
  }

  async function runTestUpstream() {
    setUpstreamProbe("pending");
    try {
      const res = await testUpstream(upstream);
      setUpstreamProbe(res);
    } catch (e) {
      setUpstreamProbe({ ok: false, error: "UPSTREAM_UNREACHABLE", message: e instanceof Error ? e.message : "request_failed" });
    }
  }

  function onUpstreamBlur() {
    if (!nameTouched && !name.trim()) {
      const suggested = suggestName(upstream);
      if (suggested) setName(suggested);
    }
  }

  async function submit() {
    setCreating(true);
    setCreateError(null);
    setPayToServerError(null);
    const resolved = resolvePayTo(payTo, meta?.wallet_address ?? null);
    if (!resolved.ok) {
      setCreating(false);
      if (resolved.code === "NO_WALLET") {
        setCreateError(tr("errPayToRequired"));
      } else {
        setPayToServerError(resolved.code);
      }
      return;
    }
    try {
      const row = await createTollbooth({
        name: name.trim() || suggestName(upstream) || "Toll booth",
        slug: slug.trim() || undefined,
        upstream_url: upstream.trim(),
        pay_to: resolved.payTo,
        default_price: defaultPrice,
        routes,
      });
      setCreated(row);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.error === "INVALID_PAY_TO") {
          setPayToServerError(e.reason ?? e.error);
        } else if (e.error === "SLUG_TAKEN") {
          setCreateError(tr("errSlugTaken"));
        } else if (e.error === "UPSTREAM_IS_SELF") {
          setCreateError(tr("errUpstreamSelf"));
        } else if (e.error === "INVALID_ROUTE") {
          setCreateError(tr("errInvalidRoute", { message: e.message }));
        } else if (e.error === "INVALID_PRICE") {
          setCreateError(tr("errInvalidPrice", { message: e.message }));
        } else if (e.error === "PAY_TO_REQUIRED") {
          setCreateError(tr("errPayToRequired"));
        } else if (e.error === "INVALID_UPSTREAM") {
          setCreateError(tr("errInvalidUpstream"));
        } else {
          setCreateError(tr("errGeneric", { message: e.message }));
        }
      } else {
        setCreateError(tr("errGeneric", { message: e instanceof Error ? e.message : "request_failed" }));
      }
    } finally {
      setCreating(false);
    }
  }

  if (created) {
    return (
      <div className="toll-wizard-done">
        <h2>{t("doneTitle")}</h2>
        <p className="muted">{t("doneSub")}</p>

        <div className="field">
          <label>{t("labelCallAddress")}</label>
          <PublicAddress address={created.public_url} qr="never" showNote={false} />
        </div>
        <div className="field">
          <label>{t("labelReceivingAddress")}</label>
          <PublicAddress address={created.pay_to} qr="never" />
        </div>

        <TollboothBuyerHelp tollbooth={created} meta={meta} cliSource={cliSource} />

        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={() => navigate("/tollbooths")}>
            {t("backToList")}
          </button>
          <button type="button" className="btn" onClick={() => navigate(`/earnings?tollbooth=${created.id}`)}>
            {t("goToEarnings")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="toll-wizard">
      <div className="toll-wizard-head">
        <div className="toll-wizard-progress">{t("stepOf", { n: step })}</div>
        {step === 3 && <ThreeThingsButton />}
      </div>

      {step === 1 && (
        <div className="card">
          <h3>{tr("step1Title")}</h3>
          <div className="field">
            <label>{tr("fieldName")}</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder={tr("fieldNamePlaceholder")}
            />
          </div>
          <div className="field">
            <label>{tr("fieldUpstream")}</label>
            <input
              className="mono"
              value={upstream}
              onChange={(e) => {
                setUpstream(e.target.value);
                setUpstreamProbe(null);
              }}
              onBlur={onUpstreamBlur}
              placeholder={tr("fieldUpstreamPlaceholder")}
            />
          </div>
          <button type="button" className="btn small secondary" disabled={!upstream.trim() || upstreamProbe === "pending"} onClick={runTestUpstream}>
            {upstreamProbe === "pending" ? tr("testingUpstream") : tr("btnTestUpstream")}
          </button>
          {upstreamProbe && upstreamProbe !== "pending" && (
            <Callout tone={upstreamProbe.ok ? (upstreamProbe.healthy ? "success" : "warn") : upstreamProbe.error === "UPSTREAM_IS_SELF" ? "error" : "warn"}>
              {upstreamProbe.ok
                ? upstreamProbe.healthy
                  ? tr("upstreamOkHealthy", { status: upstreamProbe.status, ms: upstreamProbe.latency_ms })
                  : tr("upstreamOkUnhealthy", { status: upstreamProbe.status })
                : upstreamProbe.error === "UPSTREAM_IS_SELF"
                  ? tr("upstreamSelf")
                  : tr("upstreamUnreachable", { message: upstreamProbe.message })}
            </Callout>
          )}

          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn small ghost" onClick={() => setAdvancedOpen((o) => !o)} aria-expanded={advancedOpen}>
              {tr("advancedToggle")}
            </button>
            {advancedOpen && (
              <div className="field">
                <label>{tr("fieldSlug")}</label>
                <input className="mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-api" />
                <div className="field-hint">{tr("fieldSlugHint")}</div>
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              disabled={!upstream.trim() || (typeof upstreamProbe === "object" && upstreamProbe !== null && !upstreamProbe.ok && upstreamProbe.error === "UPSTREAM_IS_SELF")}
              onClick={() => setStep(2)}
            >
              {t("next")}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>{tr("step2Title")}</h3>
          <div className="preset-row">
            <button type="button" className={`preset-btn ${preset === "whole" ? "selected" : ""}`} onClick={() => applyPreset("whole")}>
              {tr("presetWhole")}
            </button>
            <button type="button" className={`preset-btn ${preset === "chat" ? "selected" : ""}`} onClick={() => applyPreset("chat")}>
              {tr("presetChat")}
            </button>
            <button type="button" className={`preset-btn ${preset === "onlyOne" ? "selected" : ""}`} onClick={() => applyPreset("onlyOne")}>
              {tr("presetOnlyOne")}
            </button>
            <button type="button" className={`preset-btn ${preset === "custom" ? "selected" : ""}`} onClick={() => applyPreset("custom")}>
              {tr("presetCustom")}
            </button>
          </div>

          <TollRulesEditor
            routes={routes}
            onRoutesChange={(r) => {
              setPreset("custom");
              setRoutes(r);
            }}
            defaultPrice={defaultPrice}
            onDefaultPriceChange={(v) => {
              setPreset("custom");
              setDefaultPrice(v);
            }}
          />

          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => setStep(1)}>
              {t("back")}
            </button>
            <button type="button" className="btn" onClick={() => setStep(3)}>
              {t("next")}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>{tr("step3Title")}</h3>
          <PayToField value={payTo} onChange={setPayTo} walletAddress={meta?.wallet_address ?? null} serverError={payToServerError} />
          {createError && <Callout tone="error">{createError}</Callout>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => setStep(2)}>
              {t("back")}
            </button>
            <button type="button" className="btn" disabled={creating} onClick={submit}>
              {creating ? t("creating") : t("createButton")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
