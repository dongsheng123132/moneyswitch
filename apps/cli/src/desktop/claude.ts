import { applyClaude, removeClaude } from "moneyswitch-connect/lib/claude";
import type { CommandRunner } from "moneyswitch-connect/lib/runner";
import type { McpCommand } from "moneyswitch-connect/lib/mcp-entry";
import { claudeJsonPath, claudeSettingsPath, displayPath } from "./paths.js";
import { FileTransaction, readIfExists } from "./filetx.js";
import { fieldChange, maskSecret, sha256, stableStringify, type AgentPlan, type FieldChange, type FilePlan } from "./plan.js";
import { claudeAuthVar } from "./presets.js";
import type { AppliedRecord, BrainConfig } from "./store.js";

/**
 * Claude Code (verified against 2.1.280, docs/desktop-agents.md):
 *  - brain  -> ~/.claude/settings.json `env`: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
 *              (x-api-key; Anthropic official) or ANTHROPIC_AUTH_TOKEN (Bearer;
 *              gateways), ANTHROPIC_MODEL. Written by us, JSON, other keys untouched.
 *  - wallet -> `claude mcp add moneyswitch -s user ...` (moneyswitch-connect's
 *              applyClaude), which Claude Code itself stores in ~/.claude.json
 *              `mcpServers.moneyswitch`.
 */
export const AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ClaudeTarget {
  brain: BrainConfig | null;
  wallet: { server: string; key: string } | null;
  mcpCommand: McpCommand;
}

interface ClaudePrevious {
  settingsExisted: boolean;
  hadEnv: boolean;
  /** Value of each managed env var before we first wrote it (null = absent). */
  env: Record<string, string | null>;
  /** Whether a moneyswitch MCP entry existed before we first wrote ours. */
  mcpExisted: boolean;
  /** That entry (e.g. from an earlier `moneyswitch connect`), re-added on disable. */
  mcpEntry?: McpEntry | null;
}

type Json = Record<string, unknown>;

export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function toMcpEntry(j: Json | null): McpEntry | null {
  if (!j || typeof j.command !== "string") return null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((j.env ?? {}) as Json)) if (typeof v === "string") env[k] = v;
  return { command: j.command, args: Array.isArray(j.args) ? (j.args as unknown[]).map(String) : [], env };
}

/** Re-create a stdio MCP entry exactly (same shape `claude mcp add` produces). */
function addMcpEntry(runner: CommandRunner, e: McpEntry) {
  const envArgs = Object.entries(e.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return runner.run("claude", ["mcp", "add", "moneyswitch", "-s", "user", ...envArgs, "--", e.command, ...e.args]);
}

function parseJsonObject(text: string | null, file: string): Json {
  if (text === null || text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new AgentConfigError("PARSE_FAILED", `${file} is not valid JSON (${(e as Error).message}); fix it by hand first — nothing was written.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AgentConfigError("PARSE_FAILED", `${file} is not a JSON object; nothing was written.`);
  return v as Json;
}

export class AgentConfigError extends Error {
  constructor(
    readonly code: "PARSE_FAILED" | "CLI_FAILED" | "VERIFY_FAILED" | "NOT_INSTALLED" | "INVALID_INPUT",
    message: string,
    readonly detail?: unknown
  ) {
    super(message);
  }
}

function envOf(settings: Json): Record<string, unknown> {
  const e = settings.env;
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function brainEnv(brain: BrainConfig): Record<string, string | null> {
  const authVar = claudeAuthVar(brain.preset);
  const other = authVar === "ANTHROPIC_API_KEY" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  const out: Record<string, string | null> = {
    ANTHROPIC_BASE_URL: brain.baseUrl.replace(/\/+$/, ""),
    [authVar]: brain.apiKey,
    // Remove the other auth variable so Claude Code cannot pick a stale key for this endpoint.
    [other]: null,
  };
  if (brain.model.trim()) out.ANTHROPIC_MODEL = brain.model.trim();
  return out;
}

function readMcpEntry(env: NodeJS.ProcessEnv): Json | null {
  const file = claudeJsonPath(env);
  const text = readIfExists(file);
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as Json;
    const servers = j.mcpServers as Json | undefined;
    const entry = servers?.moneyswitch;
    return entry && typeof entry === "object" ? (entry as Json) : null;
  } catch {
    return null;
  }
}

function mcpFields(entry: Json | null): { command: string | null; base: string | null; key: string | null } {
  if (!entry) return { command: null, base: null, key: null };
  const args = Array.isArray(entry.args) ? (entry.args as unknown[]).map(String) : [];
  const e = (entry.env ?? {}) as Json;
  return {
    command: [str(entry.command) ?? "", ...args].join(" ").trim() || null,
    base: str(e.MONEY_API_BASE),
    key: str(e.MONEY_API_KEY),
  };
}

function prevOf(applied: AppliedRecord | null | undefined): ClaudePrevious | null {
  return applied ? (applied.previous as unknown as ClaudePrevious) : null;
}

/** Desired values of every env var we manage (null = must be absent). */
function desiredEnv(target: ClaudeTarget, prev: ClaudePrevious | null): Record<string, string | null> {
  const want: Record<string, string | null> = target.brain ? brainEnv(target.brain) : {};
  // Anything we managed before but no longer set goes back to what it was.
  for (const [k, v] of Object.entries(prev?.env ?? {})) if (!(k in want)) want[k] = v;
  return want;
}

export interface ClaudePlanResult {
  plan: AgentPlan;
  /** Hash of the current on-disk inputs, to detect edits between preview and apply. */
  inputHash: string;
}

export function planClaude(env: NodeJS.ProcessEnv, action: "enable" | "disable", target: ClaudeTarget | null, applied: AppliedRecord | null | undefined): ClaudePlanResult {
  const settingsPath = claudeSettingsPath(env);
  const settingsText = readIfExists(settingsPath);
  const settings = parseJsonObject(settingsText, displayPath(settingsPath, env));
  const curEnv = envOf(settings);
  const prev = prevOf(applied);
  const warnings: string[] = [];

  const want: Record<string, string | null> =
    action === "enable" && target ? desiredEnv(target, prev) : { ...(prev?.env ?? {}) };

  const envChanges: FieldChange[] = Object.keys(want)
    .sort()
    .map((k) => fieldChange(`env.${k}`, str(curEnv[k]), want[k], /KEY|TOKEN/.test(k)));

  const files: FilePlan[] = [];
  if (envChanges.some((c) => c.op !== "same")) {
    files.push({ path: settingsPath, display: displayPath(settingsPath, env), exists: settingsText !== null, writer: "moneyswitch", changes: envChanges });
  }

  const commands: AgentPlan["commands"] = [];
  const cur = mcpFields(readMcpEntry(env));
  const jsonPath = claudeJsonPath(env);
  const wantWallet = action === "enable" && target?.wallet ? target.wallet : null;
  if (wantWallet && target) {
    const cmd = [target.mcpCommand.command, ...target.mcpCommand.args].join(" ");
    const changes = [
      fieldChange("mcpServers.moneyswitch.command", cur.command, cmd),
      fieldChange("mcpServers.moneyswitch.env.MONEY_API_BASE", cur.base, wantWallet.server),
      fieldChange("mcpServers.moneyswitch.env.MONEY_API_KEY", cur.key, wantWallet.key, true),
    ];
    if (changes.some((c) => c.op !== "same")) {
      files.push({ path: jsonPath, display: displayPath(jsonPath, env), exists: readIfExists(jsonPath) !== null, writer: "agent-cli", changes });
      commands.push({
        display: `claude mcp remove moneyswitch -s user`,
        why: "replace",
      });
      commands.push({
        display: `claude mcp add moneyswitch -s user -e MONEY_API_BASE=${wantWallet.server} -e MONEY_API_KEY=${maskSecret(wantWallet.key)} -- ${cmd}`,
        why: "add",
      });
      if (cur.key && !prev?.mcpExisted && !applied?.parts.wallet) warnings.push("claudeReplacesExistingMcp");
    }
  } else if (applied?.parts.wallet && cur.key !== null) {
    const restore = prev?.mcpEntry ?? null;
    const r = restore ? { command: [restore.command, ...restore.args].join(" "), base: restore.env.MONEY_API_BASE ?? null, key: restore.env.MONEY_API_KEY ?? null } : { command: null, base: null, key: null };
    files.push({
      path: jsonPath,
      display: displayPath(jsonPath, env),
      exists: true,
      writer: "agent-cli",
      changes: [
        fieldChange("mcpServers.moneyswitch.command", cur.command, r.command),
        fieldChange("mcpServers.moneyswitch.env.MONEY_API_BASE", cur.base, r.base),
        fieldChange("mcpServers.moneyswitch.env.MONEY_API_KEY", cur.key, r.key, true),
      ],
    });
    commands.push({ display: "claude mcp remove moneyswitch -s user", why: "remove" });
    if (restore) {
      const envShown = Object.entries(restore.env).map(([k, v]) => `-e ${k}=${/KEY|TOKEN/.test(k) ? maskSecret(v) : v}`).join(" ");
      commands.push({ display: `claude mcp add moneyswitch -s user ${envShown} -- ${r.command}`, why: "restore" });
    }
  }

  const noop = files.length === 0 && commands.length === 0;
  const inputHash = sha256(stableStringify({ settings: settingsText, mcp: cur }));
  return { plan: { agent: "claude", action, files, commands, warnings, noop }, inputHash };
}

/** Fingerprint of the managed values as they are on disk right now. */
export function claudeFingerprint(env: NodeJS.ProcessEnv, managedEnvKeys: string[], walletManaged: boolean): string {
  const settings = (() => {
    try {
      return parseJsonObject(readIfExists(claudeSettingsPath(env)), "settings.json");
    } catch {
      return {};
    }
  })();
  const e = envOf(settings);
  const vals: Record<string, string | null> = {};
  for (const k of [...managedEnvKeys].sort()) vals[k] = str(e[k]);
  const mcp = walletManaged ? mcpFields(readMcpEntry(env)) : null;
  return sha256(stableStringify({ env: vals, mcp: mcp ? { base: mcp.base, key: mcp.key } : null }));
}

export interface ClaudeApplyResult {
  applied: AppliedRecord | null;
  backups: string[];
}

/**
 * Apply the plan for `action`. All-or-nothing: on any failure every file this
 * call touched (settings.json and ~/.claude.json) is restored from backup and
 * the error is re-thrown.
 */
export function applyClaudePlan(
  env: NodeJS.ProcessEnv,
  action: "enable" | "disable",
  target: ClaudeTarget | null,
  applied: AppliedRecord | null | undefined,
  runner: CommandRunner,
  now: Date = new Date()
): ClaudeApplyResult {
  const settingsPath = claudeSettingsPath(env);
  const jsonPath = claudeJsonPath(env);
  const settingsText = readIfExists(settingsPath);
  const settings = parseJsonObject(settingsText, displayPath(settingsPath, env));
  const curEnv = { ...envOf(settings) };
  const prevRec = prevOf(applied);

  // "previous" is recorded the first time we touch a value and then kept, so
  // re-enabling with a different key never forgets the user's original value.
  const previous: ClaudePrevious = prevRec
    ? { ...prevRec, env: { ...prevRec.env } }
    : { settingsExisted: settingsText !== null, hadEnv: settings.env !== undefined, env: {}, mcpExisted: readMcpEntry(env) !== null, mcpEntry: toMcpEntry(readMcpEntry(env)) };

  const want = action === "enable" && target ? desiredEnv(target, prevRec) : { ...(prevRec?.env ?? {}) };
  if (action === "enable") for (const k of Object.keys(want)) if (!(k in previous.env)) previous.env[k] = str(curEnv[k]);

  const tx = new FileTransaction(now.getTime());
  try {
    // --- settings.json -----------------------------------------------------
    const nextEnv = { ...curEnv };
    for (const [k, v] of Object.entries(want)) {
      if (v === null) delete nextEnv[k];
      else nextEnv[k] = v;
    }
    const envChanged = stableStringify(nextEnv) !== stableStringify(curEnv);
    if (envChanged) {
      const next: Json = { ...settings };
      if (Object.keys(nextEnv).length === 0 && action === "disable" && !previous.hadEnv) delete next.env;
      else next.env = nextEnv;
      const restoreToNothing = action === "disable" && !previous.settingsExisted && Object.keys(next).length === 0;
      if (restoreToNothing) {
        // The file did not exist before we created it: remove it again (backup kept).
        tx.remove(settingsPath);
      } else {
        tx.write(settingsPath, JSON.stringify(next, null, 2) + "\n", (onDisk) => {
          const back = envOf(JSON.parse(onDisk) as Json);
          for (const [k, v] of Object.entries(want)) {
            if ((v === null && k in back) || (v !== null && back[k] !== v)) {
              throw new AgentConfigError("VERIFY_FAILED", `settings.json read-back: ${k} is not what was written`);
            }
          }
        });
      }
    }

    // --- MCP (via Claude Code's own CLI) ----------------------------------
    const wallet = action === "enable" && target?.wallet ? target.wallet : null;
    const hadOurWallet = applied?.parts.wallet ?? false;
    if (wallet && target) {
      const cur = mcpFields(readMcpEntry(env));
      const cmd = [target.mcpCommand.command, ...target.mcpCommand.args].join(" ");
      if (cur.key !== wallet.key || cur.base !== wallet.server || cur.command !== cmd) {
        tx.snapshot(jsonPath);
        const res = applyClaude(runner, wallet.server, wallet.key, target.mcpCommand);
        if (!res.added.ok) {
          throw new AgentConfigError(
            /not recognized|not found|ENOENT|不是内部或外部命令/i.test(res.added.stderr) ? "NOT_INSTALLED" : "CLI_FAILED",
            `claude mcp add failed: ${(res.added.stderr || res.added.stdout).trim().slice(0, 400)}`
          );
        }
        const after = mcpFields(readMcpEntry(env));
        if (after.key !== wallet.key || after.base !== wallet.server) {
          throw new AgentConfigError("VERIFY_FAILED", `claude mcp add reported success but ${displayPath(jsonPath, env)} has no matching mcpServers.moneyswitch`);
        }
      }
    } else if (hadOurWallet && readMcpEntry(env) !== null) {
      tx.snapshot(jsonPath);
      const res = removeClaude(runner);
      if (!res.ok || readMcpEntry(env) !== null) {
        throw new AgentConfigError("CLI_FAILED", `claude mcp remove failed: ${(res.stderr || res.stdout).trim().slice(0, 400)}`);
      }
      const restore = previous.mcpEntry ?? null;
      if (restore) {
        const r = addMcpEntry(runner, restore);
        const back = toMcpEntry(readMcpEntry(env));
        if (!r.ok || !back || back.env.MONEY_API_KEY !== restore.env.MONEY_API_KEY) {
          throw new AgentConfigError("CLI_FAILED", `restoring the previous moneyswitch MCP entry failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
        }
      }
    }

    if (action === "disable") return { applied: null, backups: tx.backups };

    const managedKeys = Object.keys(want);
    const record: AppliedRecord = {
      at: now.toISOString(),
      backups: [...(applied?.backups ?? []), ...tx.backups],
      fingerprint: claudeFingerprint(env, managedKeys, Boolean(wallet)),
      previous: previous as unknown as Record<string, unknown>,
      parts: { brain: Boolean(target?.brain), wallet: Boolean(wallet) },
      server: wallet?.server,
    };
    return { applied: record, backups: tx.backups };
  } catch (e) {
    const rbErrors = tx.rollback();
    if (rbErrors.length) (e as Error).message += ` (rollback problems: ${rbErrors.join("; ")})`;
    throw e;
  }
}

export function claudeManagedKeys(applied: AppliedRecord): string[] {
  return Object.keys((applied.previous as unknown as ClaudePrevious).env ?? {});
}
