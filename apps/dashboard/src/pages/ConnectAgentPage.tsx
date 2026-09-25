import React from "react";
import { Plug } from "lucide-react";
import Avatar from "../components/Avatar";
import CopyButton from "../components/CopyButton";

interface AgentCard {
  name: string;
  status: "ready" | "soon";
  description: string;
  snippet: string;
}

const API_BASE = "http://127.0.0.1:4020";
const MCP_CMD = "node C:/1mineyswitch/apps/mcp/dist/index.js";

const AGENTS: AgentCard[] = [
  {
    name: "Claude Code",
    status: "ready",
    description: "Add MoneySwitch as an MCP server so Claude Code can call paid tools with a budget.",
    snippet: `claude mcp add moneyswitch \\\n  -e MONEY_API_BASE=${API_BASE} \\\n  -e MONEY_API_KEY=<your mk_live key> \\\n  -- ${MCP_CMD}`,
  },
  {
    name: "Codex",
    status: "ready",
    description: "Register MoneySwitch in ~/.codex/config.toml as an MCP server.",
    snippet: `[mcp_servers.moneyswitch]\ncommand = "node"\nargs = ["C:/1mineyswitch/apps/mcp/dist/index.js"]\n\n[mcp_servers.moneyswitch.env]\nMONEY_API_BASE = "${API_BASE}"\nMONEY_API_KEY = "<your mk_live key>"`,
  },
  {
    name: "OpenClaw",
    status: "soon",
    description: "OpenClaw MCP integration is on the roadmap. Use the generic MCP client snippet in the meantime.",
    snippet: `MONEY_API_BASE=${API_BASE}\nMONEY_API_KEY=<your mk_live key>\nMCP_COMMAND=${MCP_CMD}`,
  },
  {
    name: "WorkBuddy",
    status: "soon",
    description: "WorkBuddy MCP integration is on the roadmap. Use the generic MCP client snippet in the meantime.",
    snippet: `MONEY_API_BASE=${API_BASE}\nMONEY_API_KEY=<your mk_live key>\nMCP_COMMAND=${MCP_CMD}`,
  },
  {
    name: "Any MCP client",
    status: "ready",
    description: "Any MCP-compatible client can connect by launching the MoneySwitch MCP server with these env vars.",
    snippet: `MONEY_API_BASE=${API_BASE}\nMONEY_API_KEY=<your mk_live key>\nMCP_COMMAND=${MCP_CMD}`,
  },
];

const OPENAI_BASE = `${API_BASE}/v1`;

const OPENAI_COMPAT_AGENTS: AgentCard[] = [
  {
    name: "Cherry Studio",
    status: "ready",
    description: "Add a custom OpenAI-compatible provider in Cherry Studio's settings.",
    snippet: `Base URL: ${OPENAI_BASE}\nAPI Key:  <your mk_live key>`,
  },
  {
    name: "Open WebUI",
    status: "ready",
    description: "Add MoneySwitch as an OpenAI API connection under Admin Settings → Connections.",
    snippet: `OPENAI_API_BASE_URL=${OPENAI_BASE}\nOPENAI_API_KEY=<your mk_live key>`,
  },
  {
    name: "NewAPI",
    status: "ready",
    description: "Add MoneySwitch as an upstream OpenAI-type channel in NewAPI.",
    snippet: `NewAPI → Channels → Add channel\nType:     OpenAI\nBase URL: ${OPENAI_BASE}\nAPI Key:  <your mk_live key>`,
  },
];

export default function ConnectAgentPage() {
  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="kpi-icon" style={{ marginBottom: 0 }}>
            <Plug size={16} />
          </div>
          <div>
            <div style={{ fontWeight: 650, fontSize: 14 }}>Give your AI an API key for money</div>
            <div className="stat-sub" style={{ marginTop: 2 }}>
              Create a Money Key on the Money Keys page, then connect it to one of the agents below.
            </div>
          </div>
        </div>
      </div>

      <div className="connect-grid">
        {[...AGENTS, ...OPENAI_COMPAT_AGENTS].map((agent) => (
          <div className="card" key={agent.name}>
            <div className="connect-card-head">
              <div className="agent-row">
                <Avatar name={agent.name} />
                <span className="agent-name">{agent.name}</span>
              </div>
              <span className={`status-tag ${agent.status}`}>{agent.status === "ready" ? "Ready" : "Coming soon"}</span>
            </div>
            <div className="stat-sub" style={{ marginBottom: 12 }}>
              {agent.description}
            </div>
            <div className="code-block">
              {agent.snippet}
              <CopyButton text={agent.snippet} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
