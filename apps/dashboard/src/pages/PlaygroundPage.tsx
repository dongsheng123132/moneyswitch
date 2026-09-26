import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usePolling } from "../usePolling";
import { listKeys } from "../api";
import { toMicros, ratioMicros, formatUsdc } from "../money";
import ProgressBar from "../components/ProgressBar";
import Avatar from "../components/Avatar";
import PlaygroundChat from "../components/PlaygroundChat";
import PaidFetchPanel from "../components/PaidFetchPanel";
import Callout from "../components/Callout";
import Term from "../components/Term";
import { useT } from "../i18n";
import { playgroundStrings } from "../i18n/strings/playground";
import "../styles/playground.css";

const PLAYGROUND_KEY_STORAGE = "moneyswitch_playground_key";

export default function PlaygroundPage() {
  const t = useT(playgroundStrings);
  const [searchParams] = useSearchParams();
  const [apiKey, setApiKey] = useState<string>(() => sessionStorage.getItem(PLAYGROUND_KEY_STORAGE) ?? "");
  const [refreshTick, setRefreshTick] = useState(0);
  // SPEC-v0.5.md §3: /playground?mode=fetch&url=<url>&method=<GET|POST> deep-links into the paid-request tab.
  const [tab, setTab] = useState<"chat" | "fetch">(() => (searchParams.get("mode") === "fetch" ? "fetch" : "chat"));
  const prefillUrl = searchParams.get("url") ?? undefined;
  const prefillMethod = searchParams.get("method") ?? undefined;

  const { data: keys } = usePolling(listKeys);

  const matchedKey = useMemo(() => {
    const candidate = apiKey.trim();
    if (!candidate || !keys) return null;
    return keys.find((k) => candidate.startsWith(k.key_prefix)) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, keys, refreshTick]);

  useEffect(() => {
    sessionStorage.setItem(PLAYGROUND_KEY_STORAGE, apiKey);
  }, [apiKey]);

  const usedMicros = matchedKey ? toMicros(matchedKey.used_today) : 0n;
  const limitMicros = matchedKey ? toMicros(matchedKey.daily_budget) : 0n;
  const ratio = ratioMicros(usedMicros, limitMicros);

  const statusPanel = (
            <div className="card">
              <div className="card-header">
                <h3>{t("keyStatusTitle")}</h3>
              </div>
              {!matchedKey ? (
                <div className="empty-state">{t("pasteKnownKey")}</div>
              ) : (
                <div>
                  <div className="agent-row">
                    <Avatar name={matchedKey.name} />
                    <div>
                      <div className="agent-name">{matchedKey.name}</div>
                      <div className="stat-sub" style={{ marginTop: 0 }}>
                        {matchedKey.key_prefix}••••
                      </div>
                    </div>
                  </div>
                  <div className="stat-label">
                    <Term k="dailyBudget">{t("todayUsedLimit")}</Term>
                  </div>
                  <div className="num" style={{ fontSize: 13, marginBottom: 4 }}>
                    {formatUsdc(matchedKey.used_today, { maxDecimals: 4 })} / {formatUsdc(matchedKey.daily_budget, { maxDecimals: 4 })} USDC
                  </div>
                  <ProgressBar ratio={ratio} />
                  <div className="stat-label" style={{ marginTop: 14 }}>
                    <Term k="perRequestLimit">{t("perRequestLimit")}</Term>
                  </div>
                  <div className="num">{formatUsdc(matchedKey.per_request_limit, { maxDecimals: 4 })} USDC</div>
                  <div className="stat-label" style={{ marginTop: 14 }}>
                    <Term k="approvalThreshold">{t("approvalThresholdLabel")}</Term>
                  </div>
                  <div className="num">
                    {matchedKey.approval_threshold ? `${formatUsdc(matchedKey.approval_threshold, { maxDecimals: 4 })} USDC` : t("approvalThresholdNone")}
                  </div>
                </div>
              )}
            </div>
  );

  return (
    <div>
      {!apiKey.trim() && (
        <Callout tone="info" title={t("emptyKeyTitle")} action={<Link to="/keys?new=1" className="btn small">{t("goToKeys")}</Link>}>
          {t("emptyKeyBody")}
        </Callout>
      )}

      <div className="pg-tabs">
        <button type="button" className={`tab-btn ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>
          {t("tabChat")}
        </button>
        <button type="button" className={`tab-btn ${tab === "fetch" ? "active" : ""}`} onClick={() => setTab("fetch")}>
          {t("tabFetch")}
        </button>
      </div>

      {tab === "chat" ? (
        <PlaygroundChat
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          audience="admin"
          approvalsLinkTo="/approvals"
          onMessageSettled={() => setRefreshTick((tk) => tk + 1)}
          rightPanel={statusPanel}
        />
      ) : (
        <PaidFetchPanel
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          initialUrl={prefillUrl}
          initialMethod={prefillMethod}
          rightPanel={statusPanel}
          onDone={() => setRefreshTick((tk) => tk + 1)}
        />
      )}
    </div>
  );
}
