import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Callout from "../components/Callout";
import PayToField, { resolvePayTo, type PayToValue } from "../components/PayToField";
import { ThreeThingsButton } from "../components/ThreeThings";
import TollboothBuyerHelp from "../components/TollboothBuyerHelp";
import TollRulesEditor from "../components/TollRulesEditor";
import { SkeletonCard } from "../components/Skeleton";
import { useT } from "../i18n";
import { tollboothsStrings, tollRulesStrings } from "../i18n/strings/tollbooths";
import { common } from "../i18n/strings/common";
import { useAdminMeta } from "../useAdminMeta";
import { useCliSource } from "../snippets";
import { getTollbooth, updateTollbooth, testUpstream, ApiError, type TollboothRow, type TollRouteInput, type UpstreamProbe } from "../api";
import "../styles/tollbooths.css";

export default function TollboothDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = useT(tollboothsStrings);
  const tr = useT(tollRulesStrings);
  const tc = useT(common);
  const meta = useAdminMeta();
  const cliSource = useCliSource(meta);

  const [tollbooth, setTollbooth] = useState<TollboothRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [upstream, setUpstream] = useState("");
  const [slug, setSlug] = useState("");
  const [forwardHost, setForwardHost] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [routes, setRoutes] = useState<TollRouteInput[]>([]);
  const [defaultPrice, setDefaultPrice] = useState<string | null>(null);
  const [payTo, setPayTo] = useState<PayToValue>({ mode: "wallet", address: "" });
  const [payToServerError, setPayToServerError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [upstreamProbe, setUpstreamProbe] = useState<UpstreamProbe | "pending" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    getTollbooth(id)
      .then((row) => {
        if (!alive) return;
        setTollbooth(row);
        setName(row.name);
        setUpstream(row.upstream_url);
        setSlug(row.slug);
        setForwardHost(row.forward_host_header);
        setEnabled(row.enabled);
        setRoutes(row.routes.map((r) => ({ method: r.method, path_pattern: r.path_pattern, price: r.price, description: r.description })));
        setDefaultPrice(row.default_price);
        setPayTo(row.pay_to_is_wallet ? { mode: "wallet", address: row.pay_to } : { mode: "external", address: row.pay_to });
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "request_failed"));
    return () => {
      alive = false;
    };
  }, [id]);

  async function runTestUpstream() {
    setUpstreamProbe("pending");
    try {
      setUpstreamProbe(await testUpstream(upstream));
    } catch (e) {
      setUpstreamProbe({ ok: false, error: "UPSTREAM_UNREACHABLE", message: e instanceof Error ? e.message : "request_failed" });
    }
  }

  async function save() {
    if (!id) return;
    setSaving(true);
    setSaveError(null);
    setPayToServerError(null);
    setSaved(false);
    const resolved = resolvePayTo(payTo, meta?.wallet_address ?? null);
    if (!resolved.ok) {
      setSaving(false);
      if (resolved.code !== "NO_WALLET") setPayToServerError(resolved.code);
      else setSaveError(tr("errPayToRequired"));
      return;
    }
    try {
      const row = await updateTollbooth(id, {
        name,
        slug,
        upstream_url: upstream,
        pay_to: resolved.payTo,
        enabled,
        forward_host_header: forwardHost,
        default_price: defaultPrice,
        routes,
      });
      setTollbooth(row);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.error === "INVALID_PAY_TO") setPayToServerError(e.reason ?? e.error);
        else if (e.error === "SLUG_TAKEN") setSaveError(tr("errSlugTaken"));
        else if (e.error === "UPSTREAM_IS_SELF") setSaveError(tr("errUpstreamSelf"));
        else if (e.error === "INVALID_ROUTE") setSaveError(tr("errInvalidRoute", { message: e.message }));
        else if (e.error === "INVALID_PRICE") setSaveError(tr("errInvalidPrice", { message: e.message }));
        else setSaveError(tr("errGeneric", { message: e.message }));
      } else {
        setSaveError(tr("errGeneric", { message: e instanceof Error ? e.message : "request_failed" }));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <Callout tone="error">{tc("requestFailed", { message: loadError })}</Callout>;
  if (!tollbooth) return <SkeletonCard />;

  return (
    <div>
      <div className="toll-detail-head">
        <Link className="btn small secondary" to="/tollbooths">
          <ArrowLeft size={14} /> {t("detailBack")}
        </Link>
        <ThreeThingsButton />
      </div>

      <div className="card">
        <div className="field-row">
          <div className="field">
            <label>{tr("fieldName")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button type="button" className={`btn small ${enabled ? "success" : "secondary"}`} aria-pressed={enabled} onClick={() => setEnabled((v) => !v)}>
            {enabled ? t("colEnabled") : t("colDisabled")}
          </button>
        </div>

        <div className="field">
          <label>{tr("fieldUpstream")}</label>
          <input className="mono" value={upstream} onChange={(e) => setUpstream(e.target.value)} />
        </div>
        <button type="button" className="btn small secondary" disabled={!upstream.trim() || upstreamProbe === "pending"} onClick={runTestUpstream}>
          {upstreamProbe === "pending" ? tr("testingUpstream") : tr("btnTestUpstream")}
        </button>
        {upstreamProbe && upstreamProbe !== "pending" && (
          <Callout tone={upstreamProbe.ok ? (upstreamProbe.healthy ? "success" : "warn") : "error"}>
            {upstreamProbe.ok
              ? upstreamProbe.healthy
                ? tr("upstreamOkHealthy", { status: upstreamProbe.status, ms: upstreamProbe.latency_ms })
                : tr("upstreamOkUnhealthy", { status: upstreamProbe.status })
              : upstreamProbe.error === "UPSTREAM_IS_SELF"
                ? tr("upstreamSelf")
                : tr("upstreamUnreachable", { message: upstreamProbe.message })}
          </Callout>
        )}

        <h3>{tr("step2Title")}</h3>
        <TollRulesEditor routes={routes} onRoutesChange={setRoutes} defaultPrice={defaultPrice} onDefaultPriceChange={setDefaultPrice} />

        <h3>{tr("step3Title")}</h3>
        <PayToField value={payTo} onChange={setPayTo} walletAddress={meta?.wallet_address ?? null} serverError={payToServerError} />

        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn small ghost" onClick={() => setAdvancedOpen((o) => !o)} aria-expanded={advancedOpen}>
            {t("advancedTitle")}
          </button>
          {advancedOpen && (
            <>
              <div className="field">
                <label>{t("fieldSlugLabel")}</label>
                <input className="mono" value={slug} onChange={(e) => setSlug(e.target.value)} />
                <div className="field-hint">{t("fieldSlugHint")}</div>
              </div>
              <label className="checkbox-row">
                <input type="checkbox" checked={forwardHost} onChange={(e) => setForwardHost(e.target.checked)} />
                {t("fieldForwardHost")}
              </label>
              <div className="field-hint">{t("fieldForwardHostHint")}</div>
            </>
          )}
        </div>

        {saveError && <Callout tone="error">{saveError}</Callout>}
        {saved && <Callout tone="success">{t("saved")}</Callout>}
        <div className="modal-actions">
          <Link className="btn secondary" to={`/earnings?tollbooth=${tollbooth.id}`}>
            {t("btnEarnings")}
          </Link>
          <button type="button" className="btn" disabled={saving} onClick={save}>
            {saving ? tc("loading") : t("saveChanges")}
          </button>
        </div>
      </div>

      <div className="card">
        <TollboothBuyerHelp tollbooth={tollbooth} meta={meta} cliSource={cliSource} />
      </div>
    </div>
  );
}
