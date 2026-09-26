import crypto from "node:crypto";

/** Show enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value: string | null | undefined): string {
  if (value == null) return "";
  const v = String(value);
  if (v.length <= 10) return "••••";
  // mk_live_ / sk-ant- style prefixes stay readable, the tail identifies the key.
  const head = v.startsWith("mk_live_") ? 12 : Math.min(7, Math.floor(v.length / 4));
  return `${v.slice(0, head)}…${v.slice(-4)}`;
}

export type ChangeOp = "add" | "update" | "remove" | "same";

/** One field in one file, before -> after, secrets already masked. */
export interface FieldChange {
  field: string;
  op: ChangeOp;
  before: string | null;
  after: string | null;
  secret?: boolean;
}

export interface FilePlan {
  /** Absolute path (server side only; the UI shows `display`). */
  path: string;
  display: string;
  exists: boolean;
  /** How the file gets modified: directly by us, or by the agent's own CLI (`claude mcp add`). */
  writer: "moneyswitch" | "agent-cli";
  changes: FieldChange[];
}

export interface CommandPlan {
  /** Masked command line, for display. */
  display: string;
  why: string;
}

export interface AgentPlan {
  agent: AgentId;
  action: "enable" | "disable";
  files: FilePlan[];
  commands: CommandPlan[];
  warnings: string[];
  /** Nothing would change (e.g. disable when nothing was ever written). */
  noop: boolean;
}

export type AgentId = "claude" | "codex" | "workbuddy" | "openclaw" | "cherry";
export const AUTO_AGENTS: AgentId[] = ["claude", "codex"];
export const ALL_AGENTS: AgentId[] = ["claude", "codex", "workbuddy", "openclaw", "cherry"];

export function fieldChange(field: string, before: string | null | undefined, after: string | null | undefined, secret = false): FieldChange {
  const b = before ?? null;
  const a = after ?? null;
  const op: ChangeOp = b === a ? "same" : b === null ? "add" : a === null ? "remove" : "update";
  return {
    field,
    op,
    before: secret && b !== null ? maskSecret(b) : b,
    after: secret && a !== null ? maskSecret(a) : a,
    ...(secret ? { secret: true } : {}),
  };
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Stable JSON (sorted keys) so the same logical object always hashes the same.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
