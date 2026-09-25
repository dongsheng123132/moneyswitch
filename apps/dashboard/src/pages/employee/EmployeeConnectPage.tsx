import React from "react";
import { useAuth } from "../../auth";
import CopyButton from "../../components/CopyButton";

function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 12)}${"•".repeat(8)}${key.slice(-4)}`;
}

export default function EmployeeConnectPage() {
  const { employeeKey } = useAuth();
  const key = employeeKey ?? "";
  const origin = window.location.origin;

  const oneLineCmd = `npx moneyswitch-connect --server ${origin} --key ${key}`;
  const openaiBase = `${origin}/v1`;
  const mcpCmd = `claude mcp add moneyswitch -e MONEY_API_BASE=${origin} -e MONEY_API_KEY=${key} -- node C:/1mineyswitch/apps/mcp/dist/index.js`;

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 4 }}>把这把 Key 接到你本机的 Agent</div>
        <div className="stat-sub">三种方式任选一种，桌面客户端（Claude Code / Codex / Cherry Studio…）都能用。</div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>① 一键命令（推荐）</h3>
        </div>
        <div className="stat-sub" style={{ marginBottom: 10 }}>
          在本机终端里运行这一行，会自动检测并配置已安装的 Agent。Key 已用掩码显示，点击复制会拷贝完整值。
        </div>
        <div className="code-block">
          {`npx moneyswitch-connect --server ${origin} --key ${maskKey(key)}`}
          <CopyButton text={oneLineCmd} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>② OpenAI 兼容客户端</h3>
        </div>
        <div className="stat-sub" style={{ marginBottom: 10 }}>
          适用于 Cherry Studio / Open WebUI / NewAPI 等任何支持自定义 OpenAI Base URL 的客户端。
        </div>
        <div className="field">
          <label>Base URL</label>
          <div className="code-block">
            {openaiBase}
            <CopyButton text={openaiBase} />
          </div>
        </div>
        <div className="field">
          <label>API Key</label>
          <div className="code-block">
            {maskKey(key)}
            <CopyButton text={key} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>③ 手动 MCP 命令</h3>
        </div>
        <div className="stat-sub" style={{ marginBottom: 10 }}>
          适用于 Claude Code：在终端里运行这一行即可添加 MoneySwitch MCP 服务器。
        </div>
        <div className="code-block">
          {mcpCmd.replace(key, maskKey(key))}
          <CopyButton text={mcpCmd} />
        </div>
      </div>
    </div>
  );
}
