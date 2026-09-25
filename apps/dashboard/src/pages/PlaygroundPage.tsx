import React, { useEffect, useMemo, useState } from "react";
import { usePolling } from "../usePolling";
import { listKeys } from "../api";
import { toMicros, ratioMicros, formatUsdc } from "../money";
import ProgressBar from "../components/ProgressBar";
import Avatar from "../components/Avatar";
import PlaygroundChat from "../components/PlaygroundChat";

const PLAYGROUND_KEY_STORAGE = "moneyswitch_playground_key";

export default function PlaygroundPage() {
  const [apiKey, setApiKey] = useState<string>(() => sessionStorage.getItem(PLAYGROUND_KEY_STORAGE) ?? "");
  const [refreshTick, setRefreshTick] = useState(0);

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

  return (
    <PlaygroundChat
      apiKey={apiKey}
      onApiKeyChange={setApiKey}
      approvalsLinkTo="/approvals"
      onMessageSettled={() => setRefreshTick((t) => t + 1)}
      rightPanel={
        <div className="card">
          <div className="card-header">
            <h3>Key status</h3>
          </div>
          {!matchedKey ? (
            <div className="empty-state">Paste a known Money Key above to see live budget.</div>
          ) : (
            <div>
              <div className="agent-row" style={{ marginBottom: 12 }}>
                <Avatar name={matchedKey.name} />
                <div>
                  <div className="agent-name">{matchedKey.name}</div>
                  <div className="stat-sub" style={{ marginTop: 0 }}>
                    {matchedKey.key_prefix}••••
                  </div>
                </div>
              </div>
              <div className="stat-label">Today used / daily limit</div>
              <div className="num" style={{ fontSize: 13, marginBottom: 4 }}>
                {formatUsdc(matchedKey.used_today, { maxDecimals: 4 })} / {formatUsdc(matchedKey.daily_budget, { maxDecimals: 4 })} USDC
              </div>
              <ProgressBar ratio={ratio} />
            </div>
          )}
        </div>
      }
    />
  );
}
