import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, TrafficCone } from "lucide-react";
import { usePolling } from "../usePolling";
import { listTollbooths, updateTollbooth, deleteTollbooth, testTollbooth, ApiError, type TollboothRow, type UpstreamProbe } from "../api";
import Callout from "../components/Callout";
import EmptyState from "../components/EmptyState";
import PublicAddress from "../components/PublicAddress";
import CopyButton from "../components/CopyButton";
import { ThreeThingsButton } from "../components/ThreeThings";
import { SkeletonCard } from "../components/Skeleton";
import { useT, type TFunction } from "../i18n";
import { tollboothsStrings } from "../i18n/strings/tollbooths";
import { common } from "../i18n/strings/common";
import { formatUsdc } from "../money";
import "../styles/tollbooths.css";

function sellsSummary(t: TollboothRow, tr: TFunction<keyof typeof tollboothsStrings.en>): string {
  const parts: string[] = [];
  for (const r of t.routes) {
    const price = Number(r.price) > 0 ? tr("sellsPerCall", { price: r.price }) : tr("sellsFree");
    parts.push(`${r.method} ${r.path_pattern} ${price}`);
  }
  const rest = t.default_price == null ? tr("sellsDenyRest") : Number(t.default_price) > 0 ? tr("sellsPerCall", { price: t.default_price }) : tr("sellsFreeRest");
  parts.push(rest);
  return parts.join("；");
}

export default function TollboothsPage() {
  const { data: tollbooths, error, loading, refresh } = usePolling(listTollbooths);
  const t = useT(tollboothsStrings);
  const tc = useT(common);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, UpstreamProbe | "pending">>({});

  async function toggleEnabled(tb: TollboothRow) {
    setBusyId(tb.id);
    setActionError(null);
    try {
      await updateTollbooth(tb.id, { enabled: !tb.enabled });
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "update_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function runTest(tb: TollboothRow) {
    setTestResults((prev) => ({ ...prev, [tb.id]: "pending" }));
    try {
      const res = await testTollbooth(tb.id);
      setTestResults((prev) => ({ ...prev, [tb.id]: res }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [tb.id]: { ok: false, error: "UPSTREAM_UNREACHABLE", message: e instanceof Error ? e.message : "request_failed" },
      }));
    }
  }

  async function onDelete(tb: TollboothRow) {
    if (deleteConfirmId !== tb.id) {
      setDeleteConfirmId(tb.id);
      return;
    }
    setBusyId(tb.id);
    setActionError(null);
    try {
      await deleteTollbooth(tb.id);
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "delete_failed");
    } finally {
      setBusyId(null);
      setDeleteConfirmId(null);
    }
  }

  return (
    <div>
      <div className="toll-page-header">
        <p className="channels-intro">{t("pageIntro")}</p>
        <div className="toll-page-header-actions">
          <ThreeThingsButton />
          <Link className="btn" to="/tollbooths/new">
            <Plus size={15} />
            {t("newTollbooth")}
          </Link>
        </div>
      </div>

      {error && <Callout tone="error">{tc("requestFailed", { message: error })}</Callout>}
      {actionError && <Callout tone="error">{actionError}</Callout>}

      {loading && !tollbooths ? (
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !tollbooths || tollbooths.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<TrafficCone size={28} />}
            title={t("emptyTitle")}
            action={
              <Link className="btn" to="/tollbooths/new">
                {t("emptyAction")}
              </Link>
            }
          >
            {t("emptyBody")}
          </EmptyState>
        </div>
      ) : (
        <div className="toll-card-list">
          {tollbooths.map((tb) => {
            const res = testResults[tb.id];
            return (
              <div className="card toll-card" key={tb.id}>
                <div className="toll-card-head">
                  <div>
                    <div className="toll-card-name">{tb.name}</div>
                    <div className="mono toll-card-url">
                      {tb.public_url}
                      <CopyButton text={tb.public_url} className="icon-only" />
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${tb.enabled ? "success" : "secondary"}`}
                    aria-pressed={tb.enabled}
                    disabled={busyId === tb.id}
                    onClick={() => toggleEnabled(tb)}
                  >
                    {tb.enabled ? t("colEnabled") : t("colDisabled")}
                  </button>
                </div>

                <div className="toll-card-sells">
                  <span className="stat-label">{t("labelSells")}</span>
                  <div>{sellsSummary(tb, t)}</div>
                </div>

                <div className="toll-card-payto">
                  <span className="stat-label">{t("labelPayTo")}</span>
                  <PublicAddress address={tb.pay_to} qr="never" size="sm" showNote={false} />
                  {!tb.pay_to_is_wallet && <div className="field-hint">{t("payToExternalNote")}</div>}
                </div>

                <div className="toll-card-stats">
                  <div>
                    <div className="stat-label">{t("earningsToday")}</div>
                    <div className="stat-value num">{formatUsdc(tb.earnings_today, { maxDecimals: 4 })} USDC</div>
                  </div>
                  <div>
                    <div className="stat-label">{t("earningsTotal")}</div>
                    <div className="stat-value num">{formatUsdc(tb.earnings_total, { maxDecimals: 4 })} USDC</div>
                  </div>
                </div>

                {res && res !== "pending" && (
                  <Callout tone={res.ok ? (res.healthy ? "success" : "warn") : "error"}>
                    {res.ok
                      ? res.healthy
                        ? t("testReachable", { status: res.status, ms: res.latency_ms })
                        : t("testUnhealthy", { status: res.status })
                      : t("testUnreachable", { message: res.message })}
                  </Callout>
                )}

                <div className="toll-card-actions">
                  <button type="button" className="btn small secondary" disabled={res === "pending"} onClick={() => runTest(tb)}>
                    {res === "pending" ? t("testing") : t("btnTest")}
                  </button>
                  <Link className="btn small secondary" to={`/tollbooths/${tb.id}`}>
                    {t("btnEdit")}
                  </Link>
                  <Link className="btn small secondary" to={`/earnings?tollbooth=${tb.id}`}>
                    {t("btnEarnings")}
                  </Link>
                  {deleteConfirmId === tb.id ? (
                    <span className="channels-delete-confirm">
                      <span className="stat-sub">{t("deleteConfirm")}</span>
                      <button type="button" className="btn small danger" disabled={busyId === tb.id} onClick={() => onDelete(tb)}>
                        {t("deleteConfirmYes")}
                      </button>
                      <button type="button" className="btn small secondary" disabled={busyId === tb.id} onClick={() => setDeleteConfirmId(null)}>
                        {tc("cancel")}
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn small danger" disabled={busyId === tb.id} onClick={() => onDelete(tb)}>
                      {t("btnDelete")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
