/** Browser-side client for the local console API (same origin, cookie session). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    // empty
  }
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? res.status), String(json.message ?? json.error ?? res.statusText), json.detail);
  return json as T;
}

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  noteKey?: string;
  keyHint?: string;
}

export interface FieldChange {
  field: string;
  op: "add" | "update" | "remove" | "same";
  before: string | null;
  after: string | null;
  secret?: boolean;
}

export interface FilePlan {
  display: string;
  exists: boolean;
  writer: "moneyswitch" | "agent-cli";
  changes: FieldChange[];
}

export interface AgentPlan {
  agent: string;
  action: "enable" | "disable";
  files: FilePlan[];
  commands: { display: string; why: string }[];
  warnings: string[];
  noop: boolean;
}

export interface ManualStep {
  titleKey: string;
  code?: string;
  copy?: string;
  rows?: { labelKey: string; value: string; copy?: string }[];
}

export interface AgentView {
  id: "claude" | "codex" | "workbuddy" | "openclaw" | "cherry";
  name: string;
  mode: "auto" | "manual";
  detection: { installed: boolean; version: string | null; via: string | null };
  brain: { preset: string; baseUrl: string; model: string; apiKeyMasked: string; hasApiKey: boolean } | null;
  wallet: {
    keyMasked: string;
    source: "child" | "pasted";
    childId?: string;
    keyPrefix?: string;
    name?: string;
    dailyBudget?: string;
    perRequestLimit?: string;
    totalBudget?: string;
  } | null;
  status: "enabled" | "disabled" | "drifted";
  applied: { at: string; backups: string[]; parts: { brain: boolean; wallet: boolean } } | null;
  presets: Preset[];
  manual: ManualStep[];
}

export interface StateView {
  account: { server: string; keyMasked: string } | null;
  agents: AgentView[];
  host: string;
}

export interface KeyStatus {
  key_name?: string;
  key_prefix?: string;
  remaining_today?: string;
  remaining_total?: string;
  daily_budget?: string;
  total_budget?: string;
  per_request_limit?: string;
  currency?: string;
  can_delegate?: boolean;
  can_create_children?: boolean;
}

export interface UsageView {
  account: KeyStatus | null;
  agents: Record<string, { used_today: string | null; status: string | null; error?: string }>;
  error: { code: string; message: string } | null;
}

export interface BulkPreview {
  planId: string;
  budgets: { daily_budget: string; per_request_limit: string; total_budget: string };
  items: { agent: string; plan: AgentPlan; replacesWallet: boolean }[];
}

export const NEW_CHILD_MARK = "@@NEW_CHILD@@";
