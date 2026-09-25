import React from "react";
import { useAuth } from "../../auth";
import { usePolling } from "../../usePolling";
import { getStatus } from "../../api";
import { toMicros, ratioMicros, formatUsdc } from "../../money";
import ProgressBar from "../../components/ProgressBar";
import PlaygroundChat, { PlaygroundChatLabels } from "../../components/PlaygroundChat";

const LABELS: Partial<PlaygroundChatLabels> = {
  loadModels: "刷新模型",
  loading: "加载中…",
  noModelsYet: "暂无可用模型",
  emptyHint: "开始对话吧 —— 每条消息都是一次真实的 x402 付款。",
  inputPlaceholder: "输入消息 — Enter 发送，Shift+Enter 换行",
  send: "发送",
  pasteKeyFirst: "未检测到有效的 Key，请重新登录。",
  pickModelFirst: "请先选择一个模型。",
};

export default function EmployeePlaygroundPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey as string;
  const { data: status, refresh } = usePolling(() => getStatus(key));

  const hasDaily = status?.daily_budget != null;
  const dailyMicros = hasDaily ? toMicros(status?.daily_budget) : 0n;
  const remainingMicros = toMicros(status?.remaining_today);
  const usedMicros = hasDaily ? dailyMicros - remainingMicros : 0n;
  const ratio = hasDaily ? ratioMicros(usedMicros, dailyMicros) : 0;

  return (
    <PlaygroundChat
      apiKey={key}
      autoLoadModels
      labels={LABELS}
      onMessageSettled={refresh}
      rightPanel={
        <div className="card">
          <div className="card-header">
            <h3>我的额度</h3>
          </div>
          {!status ? (
            <div className="empty-state">加载中…</div>
          ) : (
            <div>
              <div className="stat-label">今日剩余</div>
              <div className="num" style={{ fontSize: 15, marginBottom: 6 }}>
                {formatUsdc(status.remaining_today, { maxDecimals: 4 })} {status.currency}
                {hasDaily && <> / {formatUsdc(status.daily_budget, { maxDecimals: 4 })}</>}
              </div>
              {hasDaily && <ProgressBar ratio={ratio} />}
              <div className="stat-label" style={{ marginTop: 14 }}>
                单笔上限
              </div>
              <div className="num">
                {formatUsdc(status.per_request_limit, { maxDecimals: 4 })} {status.currency}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}
