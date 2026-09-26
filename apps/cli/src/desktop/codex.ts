import { parse as parseToml } from "smol-toml";
import { buildMcpSection } from "moneyswitch-connect/lib/codex";
import type { McpCommand } from "moneyswitch-connect/lib/mcp-entry";
import { codexConfigFile, displayPath } from "./paths.js";
import { FileTransaction, readIfExists } from "./filetx.js";
import { AgentConfigError } from "./claude.js";
import { deepEqual, fieldChange, sha256, stableStringify, type AgentPlan, type FieldChange } from "./plan.js";
import { appendTable, getRootLine, getTable, removeTable, setRootLine, tomlString } from "./toml-edit.js";
import type { AppliedRecord, BrainConfig } from "./store.js";

/**
 * Codex CLI (verified against codex-cli 0.156.1, docs/desktop-agents.md):
 *  - brain  -> root `model`, `model_provider = "moneyswitch_brain"` and
 *              `[model_providers.moneyswitch_brain]` { name, base_url,
 *              wire_api = "responses", experimental_bearer_token }.
 *              `wire_api = "chat"` is rejected by 0.156.1 at config load.
 *  - wallet -> `[mcp_servers.moneyswitch]` (+ `.env`), same text
 *              `moneyswitch connect` writes (buildMcpSection).
 */
export const PROVIDER_ID = "moneyswitch_brain";
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`;
const MCP_TABLE = "mcp_servers.moneyswitch";

export interface CodexTarget {
  brain: BrainConfig | null;
  wallet: { server: string; key: string } | null;
  mcpCommand: McpCommand;
}

interface CodexPrevious {
  fileExisted: boolean;
  /** Raw root lines before we first changed them (null = absent). Present only for keys we manage. */
  root: Record<string, string | null>;
  /** Raw text of tables we replaced (null = absent). Present only for tables we manage. */
  tables: Record<string, string | null>;
}

type Toml = Record<string, unknown>;

function parse(text: string, label: string): Toml {
  try {
    return parseToml(text) as Toml;
  } catch (e) {
    throw new AgentConfigError("PARSE_FAILED", `${label} is not valid TOML (${(e as Error).message.split("\n")[0]}); fix it by hand first — nothing was written.`);
  }
}

function providerBlock(brain: BrainConfig): string {
  return [
    `[${PROVIDER_TABLE}]`,
    `name = ${tomlString(`MoneySwitch · ${brain.preset}`)}`,
    `base_url = ${tomlString(brain.baseUrl.replace(/\/+$/, ""))}`,
    `wire_api = "responses"`,
    `experimental_bearer_token = ${tomlString(brain.apiKey)}`,
  ].join("\n");
}

/** Remove what we own from a parsed document so the rest can be compared. */
function stripManaged(doc: Toml): Toml {
  const out: Toml = JSON.parse(JSON.stringify(doc));
  delete out.model;
  delete out.model_provider;
  const mp = out.model_providers as Toml | undefined;
  if (mp) {
    delete mp[PROVIDER_ID];
    if (Object.keys(mp).length === 0) delete out.model_providers;
  }
  const ms = out.mcp_servers as Toml | undefined;
  if (ms) {
    delete ms.moneyswitch;
    if (Object.keys(ms).length === 0) delete out.mcp_servers;
  }
  return out;
}

function get(doc: Toml, path: string): string | null {
  let cur: unknown = doc;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Toml)[p];
  }
  if (cur === undefined || cur === null) return null;
  return Array.isArray(cur) ? cur.map(String).join(" ") : String(cur);
}

interface Edit {
  before: string;
  after: string;
  previous: CodexPrevious;
  managedRoot: string[];
  managedTables: string[];
}

function computeEdit(text: string, action: "enable" | "disable", target: CodexTarget | null, applied: AppliedRecord | null | undefined): Edit {
  const prevRec = applied ? (applied.previous as unknown as CodexPrevious) : null;
  const previous: CodexPrevious = prevRec
    ? { fileExisted: prevRec.fileExisted, root: { ...prevRec.root }, tables: { ...prevRec.tables } }
    : { fileExisted: text.length > 0, root: {}, tables: {} };

  const wantRoot: Record<string, string | null> = {};
  const wantTables: Record<string, string | null> = {};
  if (action === "enable" && target) {
    if (target.brain) {
      if (target.brain.model.trim()) wantRoot.model = `model = ${tomlString(target.brain.model.trim())}`;
      wantRoot.model_provider = `model_provider = ${tomlString(PROVIDER_ID)}`;
      wantTables[PROVIDER_TABLE] = providerBlock(target.brain);
    }
    if (target.wallet) wantTables[MCP_TABLE] = buildMcpSection(target.wallet.server, target.wallet.key, target.mcpCommand);
  }
  // Whatever we managed before but don't want now goes back to what it was.
  for (const [k, v] of Object.entries(prevRec?.root ?? {})) if (!(k in wantRoot)) wantRoot[k] = v;
  for (const [k, v] of Object.entries(prevRec?.tables ?? {})) if (!(k in wantTables)) wantTables[k] = v;

  if (action === "enable") {
    for (const k of Object.keys(wantRoot)) if (!(k in previous.root)) previous.root[k] = getRootLine(text, k);
    for (const k of Object.keys(wantTables)) if (!(k in previous.tables)) previous.tables[k] = getTable(text, k);
  }

  let after = text;
  for (const [k, line] of Object.entries(wantRoot)) after = setRootLine(after, k, line);
  for (const [name, block] of Object.entries(wantTables)) {
    after = removeTable(after, name);
    if (block !== null) after = appendTable(after, block);
  }
  return { before: text, after, previous, managedRoot: Object.keys(wantRoot), managedTables: Object.keys(wantTables) };
}

function diffFields(before: Toml, after: Toml): FieldChange[] {
  const fields: [string, string, boolean][] = [
    ["model", "model", false],
    ["model_provider", "model_provider", false],
    [`[${PROVIDER_TABLE}].base_url`, `model_providers.${PROVIDER_ID}.base_url`, false],
    [`[${PROVIDER_TABLE}].wire_api`, `model_providers.${PROVIDER_ID}.wire_api`, false],
    [`[${PROVIDER_TABLE}].experimental_bearer_token`, `model_providers.${PROVIDER_ID}.experimental_bearer_token`, true],
    [`[${MCP_TABLE}].command`, "mcp_servers.moneyswitch.command", false],
    [`[${MCP_TABLE}].args`, "mcp_servers.moneyswitch.args", false],
    [`[${MCP_TABLE}.env].MONEY_API_BASE`, "mcp_servers.moneyswitch.env.MONEY_API_BASE", false],
    [`[${MCP_TABLE}.env].MONEY_API_KEY`, "mcp_servers.moneyswitch.env.MONEY_API_KEY", true],
  ];
  return fields.map(([label, p, secret]) => fieldChange(label, get(before, p), get(after, p), secret)).filter((c) => c.op !== "same");
}

/**
 * The safety net under the line-based editor: after the edit, everything we
 * do NOT own must parse to exactly what it was before.
 */
function assertOnlyManagedChanged(beforeDoc: Toml, afterText: string, label: string): Toml {
  let afterDoc: Toml;
  try {
    afterDoc = parseToml(afterText) as Toml;
  } catch {
    throw new AgentConfigError("VERIFY_FAILED", `refusing to write ${label}: the edited file would not parse (unusual file layout). Nothing was written.`);
  }
  if (!deepEqual(stripManaged(beforeDoc), stripManaged(afterDoc))) {
    throw new AgentConfigError("VERIFY_FAILED", `refusing to write ${label}: the edit would change settings MoneySwitch does not own (unusual file layout). Nothing was written.`);
  }
  return afterDoc;
}

export interface CodexPlanResult {
  plan: AgentPlan;
  inputHash: string;
}

export function planCodex(env: NodeJS.ProcessEnv, action: "enable" | "disable", target: CodexTarget | null, applied: AppliedRecord | null | undefined): CodexPlanResult {
  const file = codexConfigFile(env);
  const label = displayPath(file, env);
  const raw = readIfExists(file);
  const text = raw ?? "";
  const beforeDoc = parse(text, label);
  const edit = computeEdit(text, action, target, applied);
  const afterDoc = assertOnlyManagedChanged(beforeDoc, edit.after, label);
  const changes = diffFields(beforeDoc, afterDoc);
  const warnings: string[] = [];
  if (action === "enable" && target?.brain?.preset === "deepseek") warnings.push("codexNeedsResponsesApi");
  if (action === "enable" && target?.brain && get(beforeDoc, "model_provider") && get(beforeDoc, "model_provider") !== PROVIDER_ID) {
    warnings.push("codexReplacesProvider");
  }
  const files = changes.length ? [{ path: file, display: label, exists: raw !== null, writer: "moneyswitch" as const, changes }] : [];
  return {
    plan: { agent: "codex", action, files, commands: [], warnings, noop: files.length === 0 },
    inputHash: sha256(text),
  };
}

export function codexFingerprint(env: NodeJS.ProcessEnv, applied: AppliedRecord): string {
  const prev = applied.previous as unknown as CodexPrevious;
  const text = readIfExists(codexConfigFile(env)) ?? "";
  const vals: Record<string, string | null> = {};
  for (const k of Object.keys(prev.root ?? {}).sort()) vals[`root:${k}`] = getRootLine(text, k);
  for (const k of Object.keys(prev.tables ?? {}).sort()) {
    const t = getTable(text, k);
    vals[`table:${k}`] = t === null ? null : t.replace(/\r\n/g, "\n");
  }
  return sha256(stableStringify(vals));
}

export interface CodexApplyResult {
  applied: AppliedRecord | null;
  backups: string[];
}

export function applyCodexPlan(
  env: NodeJS.ProcessEnv,
  action: "enable" | "disable",
  target: CodexTarget | null,
  applied: AppliedRecord | null | undefined,
  now: Date = new Date()
): CodexApplyResult {
  const file = codexConfigFile(env);
  const label = displayPath(file, env);
  const raw = readIfExists(file);
  const text = raw ?? "";
  const beforeDoc = parse(text, label);
  const edit = computeEdit(text, action, target, applied);
  assertOnlyManagedChanged(beforeDoc, edit.after, label);

  const tx = new FileTransaction(now.getTime());
  try {
    if (edit.after !== text) {
      if (action === "disable" && !edit.previous.fileExisted && edit.after.trim() === "") {
        tx.remove(file);
      } else {
        tx.write(file, edit.after, (onDisk) => {
          const doc = assertOnlyManagedChanged(beforeDoc, onDisk, label);
          if (action === "enable" && target?.wallet && get(doc, "mcp_servers.moneyswitch.env.MONEY_API_KEY") !== target.wallet.key) {
            throw new AgentConfigError("VERIFY_FAILED", `${label} read-back: [mcp_servers.moneyswitch] is not what was written`);
          }
          if (action === "enable" && target?.brain && get(doc, "model_provider") !== PROVIDER_ID) {
            throw new AgentConfigError("VERIFY_FAILED", `${label} read-back: model_provider is not what was written`);
          }
        });
      }
    }
    if (action === "disable") return { applied: null, backups: tx.backups };
    const record: AppliedRecord = {
      at: now.toISOString(),
      backups: [...(applied?.backups ?? []), ...tx.backups],
      fingerprint: "",
      previous: edit.previous as unknown as Record<string, unknown>,
      parts: { brain: Boolean(target?.brain), wallet: Boolean(target?.wallet) },
      server: target?.wallet?.server,
    };
    record.fingerprint = codexFingerprint(env, record);
    return { applied: record, backups: tx.backups };
  } catch (e) {
    const rb = tx.rollback();
    if (rb.length) (e as Error).message += ` (rollback problems: ${rb.join("; ")})`;
    throw e;
  }
}
