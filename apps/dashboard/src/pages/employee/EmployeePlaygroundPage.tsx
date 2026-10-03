import React, { useState } from "react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getStatus } from "../../api";
import { toMicros, ratioMicros, formatUsdc } from "../../money";
import ProgressBar from "../../components/ProgressBar";
import Term from "../../components/Term";
import PaidFetchPanel from "../../components/PaidFetchPanel";
import { playgroundStrings } from "../../i18n/strings/playground";
import PlaygroundChat from "../../components/PlaygroundChat";
import { useT } from "../../i18n";
import { common } from "../../i18n/strings/common";
import { employeeStrings } from "../../i18n/strings/employee";

export default function EmployeePlaygroundPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data: status, refresh } = usePolling(() => getStatus(key));
  const t = useT(employeeStrings);
  const tc = useT(common);
  const tp = useT(playgroundStrings);
  const [tab, setTab] = useState<"fetch" | "chat">("fetch");

  const hasDaily = status?.daily_budget != null;
  const dailyMicros = hasDaily ? toMicros(status?.daily_budget) : 0n;
  const remainingMicros = toMicros(status?.remaining_today);
  const usedMicros = hasDaily ? dailyMicros - remainingMicros : 0n;
  const ratio = hasDaily ? ratioMicros(usedMicros, dailyMicros) : 0;

  const budgetPanel = (
<div className="card">
          <div className="card-header">
            <h3>{t("myBudgetPanelTitle")}</h3>
          </div>
          {!status ? (
            <div className="empty-state">{tc("loading")}</div>
          ) : (
            <div>
              <div className="stat-label">
                <Term k="dailyBudget">{t("todayRemainingShort")}</Term>
              </div>
              <div className="num" style={{ fontSize: 15, marginBottom: 6 }}>
                {formatUsdc(status.remaining_today, { maxDecimals: 4 })} {status.currency}
                {hasDaily && <> / {formatUsdc(status.daily_budget, { maxDecimals: 4 })}</>}
              </div>
              {hasDaily && <ProgressBar ratio={ratio} />}
              <div className="stat-label" style={{ marginTop: 14 }}>
                <Term k="perRequestLimit">{t("perRequestLimitLabel")}</Term>
              </div>
              <div className="num">
                {formatUsdc(status.per_request_limit, { maxDecimals: 4 })} {status.currency}
              </div>
              <div className="field-hint" style={{ marginTop: 14 }}>
                {t("approvalNote")}
              </div>
            </div>
          )}
        </div>
  );
  return (
    <div>
      <div className="pg-tabs">
        <button type="button" className={`tab-btn ${tab === "fetch" ? "active" : ""}`} onClick={() => setTab("fetch")}>{tp("tabFetch")}</button>
        <button type="button" className={`tab-btn ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>{tp("tabChat")}</button>
      </div>
      {tab === "fetch" ? (
        <PaidFetchPanel apiKey={key} audience="employee" rightPanel={budgetPanel} onDone={refresh} />
      ) : (
        <PlaygroundChat apiKey={key} autoLoadModels audience="employee" approvalsLinkTo="/me/history" onMessageSettled={refresh} rightPanel={budgetPanel} />
      )}
    </div>
  );
}
