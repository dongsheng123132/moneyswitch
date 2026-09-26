import os from "node:os";
import { resolveMcpCommand, resolvePortableMcpCommand, isNpmRegistryFallback, type McpCommand } from "moneyswitch-connect/lib/mcp-entry";
import type { CommandRunner } from "moneyswitch-connect/lib/runner";
import type { FetchLike } from "moneyswitch-connect/lib/status";
import { AGENT_INFO, detectAgents, manualSteps, type Detection } from "./agents.js";
import { AgentConfigError, applyClaudePlan, claudeFingerprint, claudeManagedKeys, planClaude, type ClaudeTarget } from "./claude.js";
import { applyCodexPlan, codexFingerprint, planCodex } from "./codex.js";
import { MoneyApi, MoneyApiError, normalizeServer, suggestChildBudgets, toMicros, type KeyStatus } from "./money-api.js";
import { testBrain, type ModelTestResult } from "./model-test.js";
import { ALL_AGENTS, AUTO_AGENTS, maskSecret, sha256, stableStringify, type AgentId, type AgentPlan } from "./plan.js";
import { presetsFor } from "./presets.js";
import { loadStore, saveStore, type AgentState, type BrainConfig, type DesktopStore, type WalletConfig } from "./store.js";

export const NEW_CHILD_PLACEHOLDER = "mk_live_NEWCHILDKEY_WILL_BE_CREATED";
export const NEW_CHILD_MARK = "@@NEW_CHILD@@";

export class UserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown
  ) {
    super(message);
  }
}

export interface ServiceDeps {
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  fetchImpl?: FetchLike;
  /** Override MCP launch command (tests). */
  mcpCommand?: McpCommand;
  now?: () => Date;
}

export type AgentStatus = "enabled" | "disabled" | "drifted";

function isAuto(agent: AgentId): agent is "claude" | "codex" {
  return AUTO_AGENTS.includes(agent);
}

function maskBrain(b: BrainConfig | null | undefined) {
  if (!b) return null;
  return { preset: b.preset, baseUrl: b.baseUrl, model: b.model, apiKeyMasked: b.apiKey ? maskSecret(b.apiKey) : "", hasApiKey: Boolean(b.apiKey) };
}

function maskWallet(w: WalletConfig | null | undefined) {
  if (!w) return null;
  const { key, ...rest } = w;
  return { ...rest, keyMasked: maskSecret(key) };
}

function validateUsd(v: unknown, field: string): string {
  if (typeof v !== "string" && typeof v !== "number") throw new UserError(400, "INVALID_AMOUNT", `${field} is required`, { field });
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s) || toMicros(s) <= 0n) throw new UserError(400, "INVALID_AMOUNT", `${field} must be a positive amount like 1.50`, { field });
  return s;
}

export class DesktopService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CommandRunner;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private detection: Record<AgentId, Detection> | null = null;
  private mcpCache = new Map<string, McpCommand>();
  private readonly fixedMcp?: McpCommand;
  /** Serialise every write: one config change at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: ServiceDeps) {
    this.env = deps.env;
    this.runner = deps.runner;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.fixedMcp = deps.mcpCommand;
    this.now = deps.now ?? (() => new Date());
  }

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  store(): DesktopStore {
    return loadStore(this.env);
  }

  private save(s: DesktopStore) {
    saveStore(this.env, s);
  }

  private agentState(s: DesktopStore, agent: AgentId): AgentState {
    s.agents[agent] ??= {};
    return s.agents[agent]!;
  }

  detect(force = false): Record<AgentId, Detection> {
    if (!this.detection || force) this.detection = detectAgents(this.env, this.runner);
    return this.detection;
  }

  async mcpCommand(server: string): Promise<McpCommand> {
    if (this.fixedMcp) return this.fixedMcp;
    const cached = this.mcpCache.get(server);
    if (cached) return cached;
    let cmd = resolveMcpCommand(import.meta.url);
    if (isNpmRegistryFallback(cmd)) cmd = await resolvePortableMcpCommand(server, this.fetchImpl);
    this.mcpCache.set(server, cmd);
    return cmd;
  }

  private api(s: DesktopStore): MoneyApi {
    if (!s.server || !s.key) throw new UserError(400, "NO_ACCOUNT", "connect your MoneySwitch account first");
    return new MoneyApi(s.server, s.key, this.fetchImpl);
  }

  // ---------------------------------------------------------------- status

  agentStatus(agent: AgentId, st: AgentState | undefined): AgentStatus {
    const applied = st?.applied;
    if (!applied || !isAuto(agent)) return "disabled";
    try {
      const fp = agent === "claude" ? claudeFingerprint(this.env, claudeManagedKeys(applied), applied.parts.wallet) : codexFingerprint(this.env, applied);
      return fp === applied.fingerprint ? "enabled" : "drifted";
    } catch {
      return "drifted";
    }
  }

  async state() {
    const s = this.store();
    const det = this.detect();
    const mcp = s.server ? await this.mcpCommand(s.server).catch(() => ({ command: "npx", args: ["-y", "moneyswitch", "mcp"] })) : { command: "npx", args: ["-y", "moneyswitch", "mcp"] };
    const agents = ALL_AGENTS.map((id) => {
      const st = s.agents[id];
      return {
        id,
        name: AGENT_INFO[id].name,
        mode: AGENT_INFO[id].mode,
        detection: det[id],
        brain: maskBrain(st?.brain),
        wallet: maskWallet(st?.wallet),
        status: this.agentStatus(id, st),
        applied: st?.applied ? { at: st.applied.at, backups: st.applied.backups, parts: st.applied.parts } : null,
        presets: presetsFor(id),
        manual: AGENT_INFO[id].mode === "manual" ? manualSteps(id, { server: s.server ?? null, walletKey: st?.wallet?.key ?? null, brain: st?.brain ?? null, mcp }) : [],
      };
    });
    return {
      account: s.server && s.key ? { server: s.server, keyMasked: maskSecret(s.key) } : null,
      agents,
      host: os.hostname(),
    };
  }

  /** Live numbers from the server: my budget + today's spend of each agent's key. Never throws. */
  async usage() {
    const s = this.store();
    if (!s.server || !s.key) return { account: null, agents: {} as Record<string, unknown>, error: null };
    const api = this.api(s);
    let account: KeyStatus | null = null;
    let error: { code: string; message: string } | null = null;
    try {
      account = await api.status();
    } catch (e) {
      const err = e as MoneyApiError;
      error = { code: err.code ?? "ERROR", message: err.message };
    }
    const agents: Record<string, { used_today: string | null; status: string | null; error?: string }> = {};
    let children: Awaited<ReturnType<MoneyApi["listChildren"]>> = [];
    if (account) children = await api.listChildren().catch(() => []);
    for (const id of ALL_AGENTS) {
      const w = s.agents[id]?.wallet;
      if (!w) continue;
      const child = w.childId ? children.find((c) => c.id === w.childId) : undefined;
      if (child) {
        agents[id] = { used_today: child.used_today ?? null, status: child.status ?? null };
      } else {
        try {
          const st = await new MoneyApi(s.server, w.key, this.fetchImpl).status();
          agents[id] = { used_today: (st.used_today as string) ?? null, status: "active" };
        } catch (e) {
          agents[id] = { used_today: null, status: null, error: (e as MoneyApiError).code };
        }
      }
    }
    return { account, agents, error };
  }

  // --------------------------------------------------------------- account

  setAccount(server: unknown, key: unknown) {
    return this.exclusive(async () => {
      if (typeof server !== "string" || !server.trim()) throw new UserError(400, "INVALID_SERVER", "server URL is required");
      if (typeof key !== "string" || !/^mk_live_[A-Za-z0-9_-]{8,}$/.test(key.trim())) throw new UserError(400, "INVALID_KEY", "paste a MoneyKey that starts with mk_live_");
      let norm: string;
      try {
        norm = normalizeServer(server);
      } catch {
        throw new UserError(400, "INVALID_SERVER", "server must be an http(s) URL");
      }
      let status: KeyStatus;
      try {
        status = await new MoneyApi(norm, key.trim(), this.fetchImpl).status();
      } catch (e) {
        const err = e as MoneyApiError;
        throw new UserError(err.httpStatus === 401 ? 401 : 502, err.code, err.message);
      }
      const s = this.store();
      s.server = norm;
      s.key = key.trim();
      this.save(s);
      return { server: norm, keyMasked: maskSecret(s.key), status };
    });
  }

  clearAccount() {
    return this.exclusive(() => {
      const s = this.store();
      delete s.server;
      delete s.key;
      this.save(s);
      return { ok: true };
    });
  }

  // ----------------------------------------------------------------- brain

  saveBrain(agent: AgentId, body: Record<string, unknown>) {
    return this.exclusive(() => {
      if (!isAuto(agent)) throw new UserError(400, "NOT_SUPPORTED", "model settings for this agent are manual in v0.4");
      const s = this.store();
      const st = this.agentState(s, agent);
      if (body.clear === true) {
        st.brain = null;
        this.save(s);
        return { brain: null };
      }
      const brain = this.parseBrain(agent, body, st.brain ?? null);
      st.brain = brain;
      this.save(s);
      return { brain: maskBrain(brain) };
    });
  }

  private parseBrain(agent: "claude" | "codex", body: Record<string, unknown>, existing: BrainConfig | null): BrainConfig {
    const presets = presetsFor(agent);
    const preset = presets.find((p) => p.id === body.preset);
    if (!preset) throw new UserError(400, "INVALID_PRESET", "unknown provider preset");
    const baseUrl = String(body.baseUrl ?? preset.baseUrl).trim();
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      throw new UserError(400, "INVALID_BASE_URL", "Base URL must be an http(s) URL", { field: "baseUrl" });
    }
    const model = String(body.model ?? "").trim();
    if (agent === "codex" && !model) throw new UserError(400, "MODEL_REQUIRED", "Codex needs a model name", { field: "model" });
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey && existing) apiKey = existing.apiKey; // blank = keep the saved key
    if (!apiKey) throw new UserError(400, "API_KEY_REQUIRED", "API key is required", { field: "apiKey" });
    if (/[\r\n"]/.test(apiKey) || /[\r\n"]/.test(model)) throw new UserError(400, "INVALID_INPUT", "unexpected characters");
    return { preset: preset.id, baseUrl, apiKey, model };
  }

  async testBrain(agent: AgentId, body: Record<string, unknown>): Promise<ModelTestResult> {
    if (!isAuto(agent)) throw new UserError(400, "NOT_SUPPORTED", "not supported for this agent");
    const s = this.store();
    const brain = this.parseBrain(agent, body, s.agents[agent]?.brain ?? null);
    return testBrain(agent, brain, this.fetchImpl);
  }

  // ---------------------------------------------------------------- wallet

  createChild(agent: AgentId, body: Record<string, unknown>) {
    return this.exclusive(async () => {
      const s = this.store();
      const api = this.api(s);
      const daily = validateUsd(body.daily_budget, "daily_budget");
      const per = validateUsd(body.per_request_limit, "per_request_limit");
      const total = validateUsd(body.total_budget, "total_budget");
      if (toMicros(per) > toMicros(daily)) throw new UserError(400, "PER_REQUEST_ABOVE_DAILY", "the per-request limit cannot be above the daily limit", { field: "per_request_limit" });
      const name = `${AGENT_INFO[agent].name} @ ${os.hostname()}`.slice(0, 80);
      let child;
      try {
        child = await api.createChild({ name, daily_budget: daily, total_budget: total, per_request_limit: per });
      } catch (e) {
        const err = e as MoneyApiError;
        throw new UserError(err.httpStatus >= 400 && err.httpStatus < 500 ? err.httpStatus : 502, err.code, err.message, err.body);
      }
      const st = this.agentState(s, agent);
      st.wallet = {
        key: child.key,
        source: "child",
        childId: child.id,
        keyPrefix: child.key_prefix,
        name: child.name,
        dailyBudget: child.daily_budget,
        perRequestLimit: child.per_request_limit,
        totalBudget: child.total_budget,
        createdAt: this.now().toISOString(),
      };
      this.save(s);
      return { wallet: maskWallet(st.wallet) };
    });
  }

  pasteWallet(agent: AgentId, body: Record<string, unknown>) {
    return this.exclusive(async () => {
      const s = this.store();
      if (!s.server) throw new UserError(400, "NO_ACCOUNT", "connect your MoneySwitch account first");
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!/^mk_live_[A-Za-z0-9_-]{8,}$/.test(key)) throw new UserError(400, "INVALID_KEY", "paste a MoneyKey that starts with mk_live_");
      let st: KeyStatus;
      try {
        st = await new MoneyApi(s.server, key, this.fetchImpl).status();
      } catch (e) {
        const err = e as MoneyApiError;
        throw new UserError(err.httpStatus === 401 ? 400 : 502, err.code, err.message);
      }
      const a = this.agentState(s, agent);
      a.wallet = {
        key,
        source: "pasted",
        keyPrefix: st.key_prefix,
        name: st.key_name,
        dailyBudget: st.daily_budget,
        perRequestLimit: st.per_request_limit,
        totalBudget: st.total_budget,
        createdAt: this.now().toISOString(),
      };
      this.save(s);
      return { wallet: maskWallet(a.wallet) };
    });
  }

  /** Forget the wallet key locally; optionally revoke the child on the server. Refused while it is written into the agent. */
  clearWallet(agent: AgentId, body: Record<string, unknown>) {
    return this.exclusive(async () => {
      const s = this.store();
      const st = this.agentState(s, agent);
      if (st.applied?.parts.wallet) throw new UserError(409, "STILL_ENABLED", "turn this agent off first, then remove its key");
      const w = st.wallet;
      let revoked = false;
      if (w && body.revoke === true && w.childId) {
        try {
          await this.api(s).revokeChild(w.childId);
          revoked = true;
        } catch (e) {
          const err = e as MoneyApiError;
          throw new UserError(502, err.code, err.message);
        }
      }
      st.wallet = null;
      this.save(s);
      return { revoked };
    });
  }

  // ------------------------------------------------------- preview / apply

  private async target(s: DesktopStore, agent: "claude" | "codex", walletOverride?: WalletConfig | null): Promise<ClaudeTarget> {
    const st = s.agents[agent] ?? {};
    const wallet = walletOverride !== undefined ? walletOverride : st.wallet;
    if (wallet && !s.server) throw new UserError(400, "NO_ACCOUNT", "connect your MoneySwitch account first");
    const mcp = await this.mcpCommand(s.server ?? "");
    return { brain: st.brain ?? null, wallet: wallet && s.server ? { server: s.server, key: wallet.key } : null, mcpCommand: mcp };
  }

  private planFor(agent: "claude" | "codex", action: "enable" | "disable", target: ClaudeTarget | null, st: AgentState) {
    try {
      return agent === "claude" ? planClaude(this.env, action, target, st.applied) : planCodex(this.env, action, target, st.applied);
    } catch (e) {
      if (e instanceof AgentConfigError) throw new UserError(422, e.code, e.message);
      throw e;
    }
  }

  private planId(agent: AgentId, action: string, inputHash: string, target: ClaudeTarget | null, st: AgentState): string {
    return sha256(
      stableStringify({
        agent,
        action,
        inputHash,
        brain: target?.brain ? { ...target.brain, apiKey: sha256(target.brain.apiKey) } : null,
        wallet: target?.wallet ? { server: target.wallet.server, key: sha256(target.wallet.key) } : null,
        mcp: target?.mcpCommand ?? null,
        appliedAt: st.applied?.at ?? null,
      })
    ).slice(0, 32);
  }

  async preview(agent: AgentId, action: unknown): Promise<{ plan: AgentPlan; planId: string }> {
    if (!isAuto(agent)) throw new UserError(400, "NOT_SUPPORTED", "this agent is configured by hand (see the steps on its card)");
    if (action !== "enable" && action !== "disable") throw new UserError(400, "INVALID_ACTION", "action must be enable or disable");
    const s = this.store();
    const st = s.agents[agent] ?? {};
    if (action === "enable" && !st.brain && !st.wallet) throw new UserError(400, "NOTHING_TO_ENABLE", "set a model or a MoneyKey for this agent first");
    if (action === "disable" && !st.applied) throw new UserError(400, "NOT_ENABLED", "nothing to turn off");
    const target = action === "enable" ? await this.target(s, agent) : null;
    const { plan, inputHash } = this.planFor(agent, action, target, st);
    return { plan, planId: this.planId(agent, action, inputHash, target, st) };
  }

  apply(agent: AgentId, action: unknown, planId: unknown) {
    return this.exclusive(async () => {
      const { planId: current } = await this.preview(agent, action);
      if (planId !== current) throw new UserError(409, "PLAN_CHANGED", "the configuration changed since the preview; review the new diff and confirm again");
      return this.applyNow(agent as "claude" | "codex", action as "enable" | "disable");
    });
  }

  private async applyNow(agent: "claude" | "codex", action: "enable" | "disable") {
    const s = this.store();
    const st = this.agentState(s, agent);
    const target = action === "enable" ? await this.target(s, agent) : null;
    let result;
    try {
      result =
        agent === "claude"
          ? applyClaudePlan(this.env, action, target, st.applied, this.runner, this.now())
          : applyCodexPlan(this.env, action, target, st.applied, this.now());
    } catch (e) {
      if (e instanceof AgentConfigError) throw new UserError(e.code === "NOT_INSTALLED" ? 424 : 500, e.code, e.message);
      throw e;
    }
    st.applied = result.applied;
    this.save(s);
    return { status: this.agentStatus(agent, st), backups: result.backups, applied: st.applied ? { at: st.applied.at, backups: st.applied.backups, parts: st.applied.parts } : null };
  }

  // ---------------------------------------------------------------- bulk

  private bulkAgents(): ("claude" | "codex")[] {
    const det = this.detect();
    return (AUTO_AGENTS as ("claude" | "codex")[]).filter((a) => det[a].installed);
  }

  async bulkPreview() {
    const s = this.store();
    const api = this.api(s);
    const agents = this.bulkAgents();
    if (!agents.length) throw new UserError(400, "NO_AGENTS", "no Claude Code or Codex found on this computer");
    let parent: KeyStatus;
    try {
      parent = await api.status();
    } catch (e) {
      const err = e as MoneyApiError;
      throw new UserError(502, err.code, err.message);
    }
    if (parent.can_create_children === false) throw new UserError(403, "CANNOT_DELEGATE", "this MoneyKey is not allowed to create child keys");
    const budgets = suggestChildBudgets(parent, agents.length);
    if (toMicros(budgets.daily_budget) <= 0n) throw new UserError(400, "NO_BUDGET_LEFT", "nothing left to split today");
    const items = [];
    const ids: string[] = [];
    for (const agent of agents) {
      const st = s.agents[agent] ?? {};
      const target = await this.target(s, agent, { key: NEW_CHILD_PLACEHOLDER, source: "child" });
      const { plan, inputHash } = this.planFor(agent, "enable", target, st);
      for (const f of plan.files) for (const c of f.changes) if (c.after === maskSecret(NEW_CHILD_PLACEHOLDER)) c.after = NEW_CHILD_MARK;
      for (const c of plan.commands) c.display = c.display.replace(maskSecret(NEW_CHILD_PLACEHOLDER), NEW_CHILD_MARK);
      ids.push(this.planId(agent, "bulk", inputHash, target, st));
      items.push({ agent, budgets, plan, replacesWallet: Boolean(st.wallet) });
    }
    return { planId: sha256(stableStringify({ ids, budgets })).slice(0, 32), budgets, items };
  }

  bulkApply(planId: unknown) {
    return this.exclusive(async () => {
      const pv = await this.bulkPreview();
      if (pv.planId !== planId) throw new UserError(409, "PLAN_CHANGED", "something changed since the preview; review the new diff and confirm again");
      const done: { agent: string; status: string; backups: string[] }[] = [];
      for (const item of pv.items) {
        try {
          const s = this.store();
          const child = await this.api(s).createChild({
            name: `${AGENT_INFO[item.agent].name} @ ${os.hostname()}`.slice(0, 80),
            ...item.budgets,
          });
          const st = this.agentState(s, item.agent);
          st.wallet = {
            key: child.key,
            source: "child",
            childId: child.id,
            keyPrefix: child.key_prefix,
            name: child.name,
            dailyBudget: child.daily_budget,
            perRequestLimit: child.per_request_limit,
            totalBudget: child.total_budget,
            createdAt: this.now().toISOString(),
          };
          this.save(s);
          const r = await this.applyNow(item.agent, "enable");
          done.push({ agent: item.agent, status: r.status, backups: r.backups });
        } catch (e) {
          const err = e as UserError | MoneyApiError;
          throw new UserError(
            (err as UserError).status ?? 502,
            (err as UserError).code ?? "BULK_FAILED",
            `${AGENT_INFO[item.agent].name}: ${err.message}`,
            { done }
          );
        }
      }
      return { done };
    });
  }
}
