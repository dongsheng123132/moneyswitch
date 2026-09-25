import { parseArgs } from "./args.js";
import { fetchStatus, type FetchLike } from "./status.js";
import { detectClaude, detectCodex, codexConfigPath } from "./detect.js";
import { applyClaude, removeClaude } from "./claude.js";
import { applyCodexConfig, removeCodexConfig } from "./codex.js";
import { resolveMcpCommand, type McpCommand } from "./mcp-entry.js";
import { RealCommandRunner, type CommandRunner } from "./runner.js";

export interface CliDeps {
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  mcpCommand?: McpCommand;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  isTTY?: boolean;
}

function maskKey(key: string): string {
  if (key.length <= 12) return `${key}••••`;
  return `${key.slice(0, 12)}••••`;
}

interface AgentResult {
  name: "claude" | "codex" | "cherry_studio" | "open_webui";
  detected: boolean | null;
  action: string;
  detail?: unknown;
}

const HELP_TEXT = `moneyswitch-connect - one-command local Agent setup for MoneySwitch (SPEC-v0.3-employee.md §B)

Usage:
  moneyswitch-connect --server <url> --key <mk_live_...> [--apply] [--json]
  moneyswitch-connect status --server <url> --key <mk_live_...> [--json]
  moneyswitch-connect remove [--apply] [--json]

Without --apply, changes are only listed (dry-run). Exit codes: 0 ok, 1 failure, 2 bad args.`;

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line + "\n"));
  const env = deps.env ?? process.env;
  const runner = deps.runner ?? new RealCommandRunner();
  const fetchImpl = deps.fetchImpl;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const jsonMode = argv.includes("--json") || !isTTY;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (jsonMode) stdout(JSON.stringify({ ok: false, error: parsed.error }));
    else stderr(`error: ${parsed.error}\n\n${HELP_TEXT}`);
    return 2;
  }

  if (parsed.help) {
    if (jsonMode) stdout(JSON.stringify({ ok: true, help: HELP_TEXT }));
    else stdout(HELP_TEXT);
    return 0;
  }

  const mcpCommand = deps.mcpCommand ?? resolveMcpCommand();

  if (parsed.command === "status") {
    const server = parsed.server!;
    const key = parsed.key!;
    let result;
    try {
      result = await fetchStatus(server, key, fetchImpl);
    } catch (e) {
      const msg = (e as Error).message;
      if (jsonMode) stdout(JSON.stringify({ ok: false, error: "REQUEST_FAILED", message: msg }));
      else stderr(`failed to reach ${server}: ${msg}`);
      return 1;
    }
    if (!result.ok) {
      if (jsonMode) stdout(JSON.stringify({ ok: false, http_status: result.httpStatus, body: result.body }));
      else stderr(`GET /v1/status -> ${result.httpStatus}: ${JSON.stringify(result.body)}`);
      return 1;
    }
    if (jsonMode) stdout(JSON.stringify({ ok: true, http_status: result.httpStatus, status: result.body }));
    else {
      const body = result.body as Record<string, unknown>;
      stdout(`Key: ${body.key_name ?? "(unnamed)"} (${body.key_prefix ?? maskKey(key)})`);
      stdout(`Remaining today: ${body.remaining_today} / ${body.daily_budget} ${body.currency}`);
      stdout(`Remaining total: ${body.remaining_total} / ${body.total_budget} ${body.currency}`);
      stdout(`Network: ${body.network}`);
    }
    return 0;
  }

  if (parsed.command === "remove") {
    const agents: AgentResult[] = [];

    const claudePresent = detectClaude(runner);
    if (parsed.apply) {
      const res = removeClaude(runner);
      agents.push({ name: "claude", detected: claudePresent, action: res.ok ? "removed" : "remove_failed", detail: res });
    } else {
      agents.push({ name: "claude", detected: claudePresent, action: claudePresent ? "would_remove" : "skip" });
    }

    const cfgPath = codexConfigPath(env);
    if (parsed.apply) {
      const res = removeCodexConfig(cfgPath);
      agents.push({ name: "codex", detected: res.removed, action: res.removed ? "removed" : "skip", detail: res });
    } else {
      agents.push({ name: "codex", detected: null, action: "would_remove", detail: { configPath: cfgPath } });
    }

    if (jsonMode) {
      stdout(JSON.stringify({ ok: true, applied: parsed.apply, agents }));
    } else {
      stdout(parsed.apply ? "Removed MoneySwitch MCP configuration:" : "Would remove MoneySwitch MCP configuration (dry-run, pass --apply):");
      for (const a of agents) stdout(`  - ${a.name}: ${a.action}`);
    }
    return 0;
  }

  // default command: connect
  const server = parsed.server!;
  const key = parsed.key!;

  let statusResult;
  try {
    statusResult = await fetchStatus(server, key, fetchImpl);
  } catch (e) {
    const msg = (e as Error).message;
    if (jsonMode) stdout(JSON.stringify({ ok: false, error: "REQUEST_FAILED", message: msg }));
    else stderr(`failed to reach ${server}: ${msg}`);
    return 1;
  }
  if (!statusResult.ok) {
    if (jsonMode) stdout(JSON.stringify({ ok: false, http_status: statusResult.httpStatus, body: statusResult.body }));
    else stderr(`key rejected by ${server}: HTTP ${statusResult.httpStatus}: ${JSON.stringify(statusResult.body)}`);
    return 1;
  }
  const statusBody = statusResult.body as Record<string, unknown>;
  if (!jsonMode) {
    stdout(`Key: ${statusBody.key_name ?? "(unnamed)"} (${statusBody.key_prefix ?? maskKey(key)})`);
    stdout(`Remaining today: ${statusBody.remaining_today} ${statusBody.currency}`);
    stdout(`Network: ${statusBody.network}`);
  }

  const claudePresent = detectClaude(runner);
  const codexPresent = detectCodex(runner, env);
  const cfgPath = codexConfigPath(env);

  const agents: AgentResult[] = [];

  if (parsed.apply) {
    if (claudePresent) {
      const res = applyClaude(runner, server, key, mcpCommand);
      agents.push({
        name: "claude",
        detected: true,
        action: res.added.ok ? "added" : "add_failed",
        detail: res,
      });
    } else {
      agents.push({ name: "claude", detected: false, action: "not_found" });
    }

    if (codexPresent) {
      const res = applyCodexConfig(cfgPath, server, key, mcpCommand);
      agents.push({ name: "codex", detected: true, action: "added", detail: res });
    } else {
      agents.push({ name: "codex", detected: false, action: "not_found" });
    }
  } else {
    const mcpCommandStr = [mcpCommand.command, ...mcpCommand.args].join(" ");
    agents.push({
      name: "claude",
      detected: claudePresent,
      action: claudePresent
        ? `would run: claude mcp add moneyswitch -s user -e MONEY_API_BASE=${server} -e MONEY_API_KEY=**** -- ${mcpCommandStr}`
        : "not_found",
    });
    agents.push({
      name: "codex",
      detected: codexPresent,
      action: codexPresent ? `would write [mcp_servers.moneyswitch] to ${cfgPath} (backing up existing file)` : "not_found",
    });
  }

  agents.push({
    name: "cherry_studio",
    detected: null,
    action: `manual: set Base URL = ${server}/v1, API Key = <your key>`,
  });
  agents.push({
    name: "open_webui",
    detected: null,
    action: `manual: set Base URL = ${server}/v1, API Key = <your key>`,
  });

  const revoke = "moneyswitch-connect remove --apply";

  if (jsonMode) {
    stdout(
      JSON.stringify({
        ok: true,
        applied: parsed.apply,
        server,
        key_prefix: (statusBody.key_prefix as string) ?? maskKey(key),
        status: statusBody,
        agents,
        revoke,
      })
    );
  } else {
    stdout(parsed.apply ? "\nApplied:" : "\nDry-run (pass --apply to make these changes):");
    for (const a of agents) stdout(`  - ${a.name}: ${a.action}`);
    stdout(`\nTo revoke later: ${revoke}`);
  }

  const failed = agents.some((a) => a.action === "add_failed");
  return failed ? 1 : 0;
}
