import fs from "node:fs";
import path from "node:path";
import type { McpCommand } from "./mcp-entry.js";

const TABLE = "mcp_servers.moneyswitch";

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSection(server: string, key: string, mcpCommand: McpCommand): string {
  const argsToml = mcpCommand.args.map((a) => `"${tomlEscape(a)}"`).join(", ");
  return [
    `[${TABLE}]`,
    `command = "${tomlEscape(mcpCommand.command)}"`,
    `args = [${argsToml}]`,
    "",
    `[${TABLE}.env]`,
    `MONEY_API_BASE = "${tomlEscape(server)}"`,
    `MONEY_API_KEY = "${tomlEscape(key)}"`,
  ].join("\n");
}

/**
 * Removes the `[mcp_servers.moneyswitch]` table and any of its sub-tables
 * (e.g. `[mcp_servers.moneyswitch.env]`) from a TOML document, leaving every
 * other table untouched. Deliberately line/table based (not a full TOML
 * parser) per SPEC-v0.3-employee.md §B.2 step 3: "只动这一段".
 */
export function hasMoneySwitchSection(text: string): boolean {
  const headerRe = /^\[([^\]]+)\]$/;
  return text
    .split(/\r?\n/)
    .some((line) => {
      const m = headerRe.exec(line.trim());
      if (!m) return false;
      const name = m[1];
      return name === TABLE || name.startsWith(`${TABLE}.`);
    });
}

export function removeMoneySwitchSection(text: string): string {
  const lines = text.split(/\r?\n/);
  const headerRe = /^\[([^\]]+)\]$/;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const m = headerRe.exec(line.trim());
    if (m) {
      const name = m[1];
      skipping = name === TABLE || name.startsWith(`${TABLE}.`);
    }
    if (!skipping) out.push(line);
  }
  // collapse runs of >1 blank lines left behind by the removal, and trim.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

export interface CodexWriteResult {
  configPath: string;
  existed: boolean;
  backupPath: string | null;
}

/**
 * SPEC-v0.3-employee.md §B.2 step 3: write/replace the moneyswitch section
 * in ~/.codex/config.toml (or $CODEX_HOME/config.toml), backing up the
 * previous file first, touching only this one table.
 */
export function applyCodexConfig(
  configPath: string,
  server: string,
  key: string,
  mcpCommand: McpCommand
): CodexWriteResult {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existed = fs.existsSync(configPath);
  const original = existed ? fs.readFileSync(configPath, "utf8") : "";
  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${configPath}.bak-${Date.now()}`;
    fs.writeFileSync(backupPath, original, "utf8");
  }
  const withoutSection = removeMoneySwitchSection(original);
  const section = buildSection(server, key, mcpCommand);
  const combined = withoutSection.length > 0 ? `${withoutSection}\n\n${section}\n` : `${section}\n`;
  fs.writeFileSync(configPath, combined, "utf8");
  return { configPath, existed, backupPath };
}

export interface CodexRemoveResult {
  configPath: string;
  removed: boolean;
  backupPath: string | null;
}

/**
 * SPEC-v0.3-employee.md §B.2 step "remove": strip the moneyswitch section,
 * backing up first. No-op (removed: false) if the file doesn't exist or has
 * no such section.
 */
export function removeCodexConfig(configPath: string): CodexRemoveResult {
  if (!fs.existsSync(configPath)) {
    return { configPath, removed: false, backupPath: null };
  }
  const original = fs.readFileSync(configPath, "utf8");
  if (!hasMoneySwitchSection(original)) {
    return { configPath, removed: false, backupPath: null };
  }
  const stripped = removeMoneySwitchSection(original);
  const backupPath = `${configPath}.bak-${Date.now()}`;
  fs.writeFileSync(backupPath, original, "utf8");
  fs.writeFileSync(configPath, stripped.length > 0 ? `${stripped}\n` : "", "utf8");
  return { configPath, removed: true, backupPath };
}
