import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "moneyswitch-connect/lib/runner";
import type { McpCommand } from "moneyswitch-connect/lib/mcp-entry";
import { homeDir } from "./paths.js";
import { maskSecret, type AgentId } from "./plan.js";
import type { BrainConfig } from "./store.js";

export interface Detection {
  installed: boolean;
  version: string | null;
  /** How it was detected, for the tooltip ("claude --version", "~/.openclaw"). */
  via: string | null;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** Can MoneySwitch write this agent's config itself (verified), or only show steps? */
  mode: "auto" | "manual";
}

export const AGENT_INFO: Record<AgentId, AgentInfo> = {
  claude: { id: "claude", name: "Claude Code", mode: "auto" },
  codex: { id: "codex", name: "Codex", mode: "auto" },
  workbuddy: { id: "workbuddy", name: "WorkBuddy", mode: "manual" },
  openclaw: { id: "openclaw", name: "OpenClaw", mode: "manual" },
  cherry: { id: "cherry", name: "Cherry Studio", mode: "manual" },
};

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

function viaCli(runner: CommandRunner, cmd: string): Detection | null {
  const r = runner.run(cmd, ["--version"]);
  if (!r.ok) return null;
  return { installed: true, version: firstLine(r.stdout) || null, via: `${cmd} --version` };
}

function viaPath(env: NodeJS.ProcessEnv, candidates: string[]): Detection | null {
  const home = homeDir(env);
  for (const c of candidates) {
    const abs = c.startsWith("~") ? path.join(home, c.slice(2)) : c;
    if (fs.existsSync(abs)) return { installed: true, version: null, via: c };
  }
  return null;
}

const NONE: Detection = { installed: false, version: null, via: null };

/**
 * Probe which agents are installed. Read-only: `--version` and directory
 * existence checks, run with the console's (possibly isolated) env.
 */
export function detectAgents(env: NodeJS.ProcessEnv, runner: CommandRunner): Record<AgentId, Detection> {
  const appData = env.APPDATA ?? path.join(homeDir(env), "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA ?? path.join(homeDir(env), "AppData", "Local");
  const cherryDirs =
    process.platform === "win32"
      ? [path.join(appData, "CherryStudio")]
      : process.platform === "darwin"
        ? ["~/Library/Application Support/CherryStudio"]
        : ["~/.config/CherryStudio"];
  return {
    claude: viaCli(runner, "claude") ?? NONE,
    codex: viaCli(runner, "codex") ?? NONE,
    workbuddy: viaPath(env, ["~/.workbuddy", path.join(localAppData, "Programs", "WorkBuddy")]) ?? NONE,
    openclaw: viaPath(env, ["~/.openclaw"]) ?? viaCli(runner, "openclaw") ?? NONE,
    cherry: viaPath(env, cherryDirs) ?? NONE,
  };
}

export interface ManualStep {
  /** i18n key of the step title on the UI side. */
  titleKey: string;
  /** Text shown (secrets masked). */
  code?: string;
  /** Text copied by the copy button (may contain the real wallet key). */
  copy?: string;
  /** Plain values shown as label/value rows. */
  rows?: { labelKey: string; value: string; copy?: string }[];
}

function mcpJson(server: string, key: string, mcp: McpCommand, mask: boolean): string {
  return JSON.stringify(
    { mcpServers: { moneyswitch: { command: mcp.command, args: mcp.args, env: { MONEY_API_BASE: server, MONEY_API_KEY: mask ? maskSecret(key) : key } } } },
    null,
    2
  );
}

function openclawPatch(brain: BrainConfig | null, server: string | null, key: string | null, mcp: McpCommand, mask: boolean): string {
  const parts: string[] = ["{"];
  if (brain) {
    const model = brain.model || "<model>";
    parts.push(
      `  models: { mode: "merge", providers: { moneyswitch_brain: { baseUrl: ${JSON.stringify(brain.baseUrl || "<base url>")}, apiKey: ${JSON.stringify(mask ? "<API key>" : brain.apiKey || "<API key>")}, api: "openai-completions", models: [{ id: ${JSON.stringify(model)}, name: ${JSON.stringify(model)} }] } } },`,
      `  agents: { defaults: { model: { primary: ${JSON.stringify(`moneyswitch_brain/${model}`)} } } },`
    );
  }
  if (server && key) {
    parts.push(
      `  mcp: { servers: { moneyswitch: { command: ${JSON.stringify(mcp.command)}, args: ${JSON.stringify(mcp.args)}, env: { MONEY_API_BASE: ${JSON.stringify(server)}, MONEY_API_KEY: ${JSON.stringify(mask ? maskSecret(key) : key)} } } } },`
    );
  }
  parts.push("}");
  return parts.join("\n");
}

/**
 * Manual steps for agents we deliberately don't write to (see
 * docs/desktop-agents.md for why each one is manual in v0.4).
 */
export function manualSteps(agent: AgentId, ctx: { server: string | null; walletKey: string | null; brain: BrainConfig | null; mcp: McpCommand }): ManualStep[] {
  const { server, walletKey, mcp } = ctx;
  const openaiBase = server ? `${server.replace(/\/+$/, "")}/v1` : "<server>/v1";
  if (agent === "openclaw") {
    // Nothing to put in the patch yet (OpenClaw's brain is manual in v0.4): the UI asks for a wallet first.
    if (!walletKey && !ctx.brain) return [];
    const steps: ManualStep[] = [
      {
        titleKey: "stepOpenclawSave",
        code: openclawPatch(ctx.brain, server, walletKey, mcp, true),
        copy: openclawPatch(ctx.brain, server, walletKey, mcp, false),
      },
      { titleKey: "stepOpenclawDryRun", code: "openclaw config patch --file moneyswitch.json5 --dry-run", copy: "openclaw config patch --file moneyswitch.json5 --dry-run" },
      { titleKey: "stepOpenclawApply", code: "openclaw config patch --file moneyswitch.json5\nopenclaw config validate\nopenclaw mcp list", copy: "openclaw config patch --file moneyswitch.json5" },
    ];
    return steps;
  }
  if (agent === "workbuddy" || agent === "cherry") {
    const steps: ManualStep[] = [];
    if (server && walletKey) {
      steps.push({
        titleKey: agent === "cherry" ? "stepCherryMcp" : "stepWorkbuddyMcp",
        code: mcpJson(server, walletKey, mcp, true),
        copy: mcpJson(server, walletKey, mcp, false),
      });
    }
    steps.push({
      titleKey: agent === "cherry" ? "stepCherryModel" : "stepWorkbuddyModel",
      rows: [
        { labelKey: "rowBaseUrl", value: openaiBase, copy: openaiBase },
        ...(walletKey ? [{ labelKey: "rowApiKey", value: maskSecret(walletKey), copy: walletKey }] : []),
      ],
    });
    return steps;
  }
  return [];
}
