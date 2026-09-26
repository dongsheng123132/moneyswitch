import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { desktopStorePath } from "./paths.js";
import type { AgentId } from "./plan.js";

/** "Brain": which model the agent talks to, with which API key. */
export interface BrainConfig {
  preset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** "Wallet": the MoneyKey the agent's MoneySwitch MCP server spends from. */
export interface WalletConfig {
  key: string;
  source: "child" | "pasted";
  /** Server-side id of the child key (source=child), used for usage lookups and revoke. */
  childId?: string;
  keyPrefix?: string;
  name?: string;
  dailyBudget?: string;
  perRequestLimit?: string;
  totalBudget?: string;
  createdAt?: string;
}

/**
 * What we changed when enabling, so disabling can put everything back exactly
 * and status can tell "still ours" from "someone edited it since".
 */
export interface AppliedRecord {
  at: string;
  backups: string[];
  /** Fingerprint (sha256 of the managed values as we wrote them). */
  fingerprint: string;
  /** Agent-specific "what was there before", used to restore on disable. */
  previous: Record<string, unknown>;
  /** Which parts were written: brain and/or wallet. */
  parts: { brain: boolean; wallet: boolean };
  server?: string;
}

export interface AgentState {
  brain?: BrainConfig | null;
  wallet?: WalletConfig | null;
  applied?: AppliedRecord | null;
}

export interface DesktopStore {
  version: 1;
  server?: string;
  key?: string;
  agents: Partial<Record<AgentId, AgentState>>;
}

export function emptyStore(): DesktopStore {
  return { version: 1, agents: {} };
}

export function loadStore(env: NodeJS.ProcessEnv): DesktopStore {
  const p = desktopStorePath(env);
  if (!fs.existsSync(p)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as DesktopStore;
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return { version: 1, server: parsed.server, key: parsed.key, agents: parsed.agents ?? {} };
  } catch {
    // A corrupt store must not brick the UI; keep the bad file for the user.
    fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`);
    return emptyStore();
  }
}

/**
 * Restrict a file to the current user. POSIX: chmod 600. Windows: drop
 * inherited ACEs and grant only the current user (icacls). Best effort: the
 * file already lives in the user's profile, which is private by default.
 */
export function restrictToCurrentUser(file: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; how: string } {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
      return { ok: true, how: "chmod 600" };
    } catch (e) {
      return { ok: false, how: `chmod failed: ${(e as Error).message}` };
    }
  }
  const user = env.USERNAME ?? process.env.USERNAME;
  if (!user) return { ok: false, how: "USERNAME unknown" };
  const domain = env.USERDOMAIN ?? process.env.USERDOMAIN;
  const principal = domain ? `${domain}\\${user}` : user;
  const res = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${principal}:F`], {
    encoding: "utf8",
    windowsHide: true,
  });
  return res.status === 0 ? { ok: true, how: `icacls ${principal}:F (inheritance removed)` } : { ok: false, how: `icacls failed: ${res.stderr || res.stdout}` };
}

export function saveStore(env: NodeJS.ProcessEnv, store: DesktopStore): void {
  const p = desktopStorePath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // The ACL is restricted on the temp file BEFORE it replaces the real one, so
  // there is no window where the key sits in a world-readable file. (A rename
  // keeps the source file's ACL, hence doing this on every save.)
  restrictToCurrentUser(tmp, env);
  fs.renameSync(tmp, p);
}
