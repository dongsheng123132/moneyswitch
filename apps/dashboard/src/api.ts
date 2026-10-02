// Central API client + type definitions for the MoneySwitch admin API.
//
// Aligned against apps/server/src/routes/{admin,agent}.ts as they existed at
// the time this file was written. Where the backend route did not exist yet
// (or its shape was ambiguous), the assumption is called out in a comment
// prefixed with "ASSUMPTION:" — see the final report for the full list.

const TOKEN_KEY = "moneyswitch_admin_token";
// SPEC-v0.3-employee.md §A.1: admin token (ms_admin_) and employee MoneyKey
// (mk_live_) are stored under separate sessionStorage keys so switching
// between the two login flows in the same tab never collides.
const EMPLOYEE_KEY_STORAGE = "moneyswitch_employee_key";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getEmployeeKey(): string | null {
  return sessionStorage.getItem(EMPLOYEE_KEY_STORAGE);
}

export function setEmployeeKey(key: string): void {
  sessionStorage.setItem(EMPLOYEE_KEY_STORAGE, key);
}

export function clearEmployeeKey(): void {
  sessionStorage.removeItem(EMPLOYEE_KEY_STORAGE);
}

export class ApiError extends Error {
  status: number;
  code?: string | null;
  /** v0.5: the server's `error` field (e.g. "INVALID_PAY_TO", "SLUG_TAKEN"). */
  error?: string | null;
  /** v0.5: finer reason, e.g. "LOOKS_LIKE_MONEYKEY" for INVALID_PAY_TO. */
  reason?: string | null;
  constructor(status: number, message: string, code?: string | null, error?: string | null, reason?: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.error = error ?? null;
    this.reason = reason ?? null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    // Only set Content-Type when there actually is a JSON body. Fastify's
    // JSON body parser rejects a request that declares
    // "Content-Type: application/json" but sends an empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY) — this used to break every no-body POST
    // (approve/deny/revoke/...) with a 400.
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    const errObj = json as { error?: string; message?: string; code?: string; reason?: string } | null;
    const message = errObj?.message || errObj?.error || errObj?.code || res.statusText || "request_failed";
    throw new ApiError(res.status, message, errObj?.code ?? null, errObj?.error ?? null, errObj?.reason ?? null);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// MoneyKeys
// ---------------------------------------------------------------------------

// SPEC-v0.4.md §A — child keys / multi-level delegation. A key's status now
// accounts for cascading revoke/expiry down an ancestor chain: a key can be
// individually enabled+unexpired yet still unusable because a parent was
// revoked or expired ("ancestor_revoked" / "ancestor_expired").
export type MoneyKeyStatus = "active" | "revoked" | "expired" | "ancestor_revoked" | "ancestor_expired";

export interface MoneyKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  enabled: boolean;
  total_budget: string;
  daily_budget: string;
  per_request_limit: string;
  approval_threshold: string | null;
  allowed_hosts: string[];
  max_payments_per_minute: number;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  // SPEC-v0.4.md §A: used_today/used_total are now SUBTREE totals (this
  // key's own spend + every descendant's spend — what actually counts
  // against this key's own budget). Never sum these across parent+child
  // rows client-side (double counting) — to get a root's total just read
  // the root row.
  used_today: string;
  used_total: string;
  // SPEC-v0.2 §1: MoneyKey allowed_models — null = all models from enabled
  // channels are allowed. Confirmed present on every /v1/keys row by the
  // real v0.2 server (verified on testnet).
  allowed_models: string[] | null;
  // --- SPEC-v0.4.md §A: child keys / multi-level delegation ---
  parent_id: string | null;
  depth: number;
  can_delegate: boolean;
  created_by: string; // "admin" | "key:<parentId>"
  children_count: number;
  status: MoneyKeyStatus;
  // This key's own spend only (excludes descendants).
  own_used_today: string;
  own_used_total: string;
}

/** GET /v1/admin/keys/tree node — same fields as a /v1/keys row, plus nested children (oldest first). */
export interface MoneyKeyTreeNode extends MoneyKeyRow {
  children: MoneyKeyTreeNode[];
}

export interface CreateMoneyKeyInput {
  name: string;
  total_budget: string;
  daily_budget: string;
  per_request_limit: string;
  approval_threshold?: string | null;
  allowed_hosts: string[];
  max_payments_per_minute?: number;
  expires_at?: string | null;
  // ASSUMPTION (SPEC-v0.2 §1): optional; omitted/null = all models allowed.
  allowed_models?: string[] | null;
  // SPEC-v0.4.md §A: lets the employee holding this key create sub-keys of
  // their own (POST /v1/keys/children). Defaults to false server-side.
  can_delegate?: boolean;
}

export interface CreateMoneyKeyResponse extends Omit<MoneyKeyRow, "key_prefix" | "used_today" | "used_total" | "last_used_at" | "created_at"> {
  key: string; // plaintext key, only ever returned here
}

export async function listKeys(): Promise<MoneyKeyRow[]> {
  const res = await request<{ keys: MoneyKeyRow[] }>("/v1/keys");
  return res.keys;
}

export async function createKey(input: CreateMoneyKeyInput): Promise<CreateMoneyKeyResponse> {
  return request<CreateMoneyKeyResponse>("/v1/keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeKey(id: string): Promise<{ id: string; revoked: boolean }> {
  return request(`/v1/keys/${id}/revoke`, { method: "POST" });
}

/** GET /v1/admin/keys/tree — same rows as GET /v1/keys, nested under their parent (roots = parent_id null). */
export async function getKeyTree(): Promise<MoneyKeyTreeNode[]> {
  const res = await request<{ tree: MoneyKeyTreeNode[] }>("/v1/admin/keys/tree");
  return res.tree;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  key_id: string;
  url: string;
  method: string;
  network: string;
  asset: string;
  pay_to: string;
  amount: string;
  status: "pending" | "approved" | "denied" | "expired" | "used";
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

export async function listApprovals(status?: string): Promise<ApprovalRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await request<{ approvals: ApprovalRow[] }>(`/v1/approvals${qs}`);
  return res.approvals;
}

export async function approveApproval(id: string): Promise<{ id: string; status: string }> {
  return request(`/v1/approvals/${id}/approve`, { method: "POST" });
}

export async function denyApproval(id: string): Promise<{ id: string; status: string }> {
  return request(`/v1/approvals/${id}/deny`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Usage / payments
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  key_id: string;
  url: string;
  host: string;
  method: string;
  network: string;
  asset: string;
  pay_to: string;
  amount: string;
  status: "reserved" | "settled" | "failed" | "unknown";
  tx_hash: string | null;
  error_code: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
  // ASSUMPTION: the server payment payload does not currently include a
  // `mock` flag (SPEC §9 T2 says mock-facilitator settlements must be
  // visibly marked MOCK on the dashboard). We treat a payment as "mock" if
  // either a `mock` boolean field is present and true, OR tx_hash starts
  // with the `0xmock` convention from SPEC §9. This keeps the UI correct
  // once the server adds a `mock` field, and degrades gracefully today.
  mock?: boolean;
  // SPEC-v0.2 §2.7: payments/usage/history rows always carry these four
  // columns on the real v0.2 server (verified on testnet). kind defaults to
  // "fetch" server-side; model/prompt_tokens/completion_tokens are null for
  // kind="fetch" rows and for chat rows where the upstream didn't return usage.
  kind: "fetch" | "chat";
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export async function listUsage(): Promise<PaymentRow[]> {
  const res = await request<{ payments: PaymentRow[] }>("/v1/admin/usage");
  return res.payments;
}

export function isMockPayment(p: PaymentRow): boolean {
  return Boolean(p.mock) || Boolean(p.tx_hash && p.tx_hash.startsWith("0xmock"));
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export interface WalletInfo {
  address: string | null;
  unlocked: boolean;
  has_keystore: boolean;
  usdc_balance: string | null;
  network: string;
  /** Offline demo: usdc_balance is simulated, not read from the chain. */
  simulated?: boolean;
}

export async function getWallet(): Promise<WalletInfo> {
  return request("/v1/admin/wallet");
}

export async function createWallet(password: string): Promise<{ address: string }> {
  return request("/v1/admin/wallet/create", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function unlockWallet(password: string): Promise<{ address: string; unlocked: boolean }> {
  return request("/v1/admin/wallet/unlock", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// ---------------------------------------------------------------------------
// Overview (derived client-side from /v1/keys + /v1/admin/usage + /v1/admin/wallet)
// ---------------------------------------------------------------------------
// ASSUMPTION: SPEC §6 does not list a dedicated "today used/limit" endpoint
// for the whole account (only per-key used_today/used_total via GET /v1/keys,
// and a global payments list via GET /v1/admin/usage). The Overview page
// therefore derives "today used" by summing settled+reserved+unknown
// payments created today (UTC) across all keys from listUsage(), and derives
// "today limit" as the sum of each key's daily_budget from listKeys(). This
// is a client-side approximation pending a dedicated summary endpoint.

export function isCountedStatus(status: PaymentRow["status"]): boolean {
  return status === "settled" || status === "reserved" || status === "unknown";
}

export function isTodayUtc(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

// ---------------------------------------------------------------------------
// Login probe: verify the token actually works before storing it as "logged in".
// ASSUMPTION: there is no dedicated /v1/admin/whoami endpoint; we use
// GET /v1/keys as the auth probe since it is a cheap, side-effect-free admin
// route that returns 403 for bad/missing tokens (see apps/server/src/auth.ts).
export async function verifyAdminToken(token: string): Promise<boolean> {
  const res = await fetch("/v1/keys", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// v0.2 §1 — Channels (admin token)
//
// ASSUMPTION: shape taken verbatim from SPEC-v0.2.md §1. Backend endpoints
// (GET/POST /v1/admin/channels, PATCH/DELETE /v1/admin/channels/:id) are
// being implemented concurrently by another coder and did not exist at the
// time this file was written. All fields below match the spec's described
// request/response bodies; if the real server disagrees once it lands, only
// this block plus ChannelsPage.tsx should need adjustment.
// ---------------------------------------------------------------------------

export interface ChannelRow {
  id: string;
  name: string;
  base_url: string;
  models: string[];
  enabled: boolean;
  created_at: string;
}

export interface CreateChannelInput {
  name: string;
  base_url: string;
  models: string[];
}

export interface UpdateChannelInput {
  enabled?: boolean;
  models?: string[];
  name?: string;
}

export async function listChannels(): Promise<ChannelRow[]> {
  const res = await request<{ channels: ChannelRow[] }>("/v1/admin/channels");
  return res.channels;
}

export async function createChannel(input: CreateChannelInput): Promise<ChannelRow> {
  return request<ChannelRow>("/v1/admin/channels", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateChannel(id: string, input: UpdateChannelInput): Promise<ChannelRow> {
  return request<ChannelRow>(`/v1/admin/channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteChannel(id: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/v1/admin/channels/${id}`, { method: "DELETE" });
}

/**
 * "从上游拉取模型" — GET /v1/admin/channels/probe-models?base_url=<encoded>
 * (admin token). Server proxies the upstream /models call so the browser
 * never talks to the channel's base_url directly (avoids CORS + keeps SSRF
 * allow-listing server-side). Success: { models: string[] }. Failure (400/502):
 * { error: "PROBE_FAILED", message: "..." } — `message` is what we surface.
 */
export async function probeChannelModels(baseUrl: string): Promise<string[]> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`/v1/admin/channels/probe-models?base_url=${encodeURIComponent(baseUrl)}`, { headers });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const body = json as { error?: string; message?: string } | null;
    throw new ApiError(res.status, body?.message || body?.error || res.statusText, body?.error ?? null);
  }
  const models = (json as { models?: string[] } | null)?.models ?? [];
  return models;
}

// ---------------------------------------------------------------------------
// v0.2 §2 — OpenAI-compatible gateway (MoneyKey auth, Bearer — NOT admin
// token). Used by the Playground page.
//
// ASSUMPTION: request/response/error shapes taken verbatim from
// SPEC-v0.2.md §2. These endpoints are being implemented concurrently and
// did not exist at the time this file was written. `sendChatCompletion` is
// a real POST that spends real testnet USDC once the backend exists — it is
// defined here (mirroring how `createKey`/`revokeKey` etc. were always
// defined without ever being invoked outside the running app) but is never
// called by this coder; only a human clicking "Send" in the Playground UI
// triggers it.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionMoneySwitchMeta {
  cost: string;
  currency: string;
  tx_hash: string;
  network: string;
  remaining_today: string;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  choices: ChatCompletionChoice[];
  // Upstream's own usage object, passed through as-is (SPEC-v0.2 §2.7:
  // "usage 是上游原样"); still optional since an upstream could omit it.
  usage?: ChatCompletionUsage;
  // Always present on a non-streaming success response (SPEC-v0.2 §2 step 5,
  // confirmed by the real v0.2 server on testnet).
  moneyswitch: ChatCompletionMoneySwitchMeta;
}

export interface OpenAiModelsResponse {
  object: "list";
  data: Array<{ id: string; object?: string }>;
}

export interface OpenAiErrorBody {
  error: {
    message: string;
    type?: string;
    code?: string;
    approval_id?: string;
    // SPEC-v0.4.md §A: a payment denial from a child key may name which
    // ancestor's limit actually tripped (limit_scope "self" | "ancestor").
    limit_scope?: "self" | "ancestor";
    limit_key_prefix?: string;
  };
}

// SPEC-v0.4.md §A: POST /v1/keys/children error bodies are NOT the nested
// OpenAI shape above — they are flat, admin-`request()`-style bodies:
//   400 { error, code: "CHILD_EXCEEDS_PARENT" | "INVALID_REQUEST", message, field?, parent_value? }
//   403 { code: "DELEGATION_NOT_ALLOWED" | "MAX_DEPTH_EXCEEDED" | "CHILDREN_LIMIT_REACHED", message, field? }
//   401 { status: "error", code, limit_scope?, limit_key_prefix? }
interface FlatKeyErrorBody {
  error?: string;
  code?: string;
  message?: string;
  field?: string;
  parent_value?: string | string[];
  status?: string;
  limit_scope?: "self" | "ancestor";
  limit_key_prefix?: string;
}

/** Thrown by the MoneyKey-authed gateway/child-key calls; carries every shape's error fields (only the relevant ones are ever set). */
export class ChatApiError extends Error {
  status: number;
  code: string | null;
  approvalId: string | null;
  /** SPEC-v0.4.md §A: the request field (snake_case) that violated a parent's limit, e.g. "daily_budget". */
  field: string | null;
  /** SPEC-v0.4.md §A: the parent's own value for `field`, to show "cannot exceed the parent: {parent_value}". */
  parentValue: string | string[] | null;
  /** SPEC-v0.4.md §A: whose limit actually tripped — this key's own, or an ancestor's. */
  limitScope: "self" | "ancestor" | null;
  limitKeyPrefix: string | null;
  constructor(
    status: number,
    message: string,
    code?: string | null,
    approvalId?: string | null,
    extra?: { field?: string | null; parentValue?: string | string[] | null; limitScope?: "self" | "ancestor" | null; limitKeyPrefix?: string | null }
  ) {
    super(message);
    this.status = status;
    this.code = code ?? null;
    this.approvalId = approvalId ?? null;
    this.field = extra?.field ?? null;
    this.parentValue = extra?.parentValue ?? null;
    this.limitScope = extra?.limitScope ?? null;
    this.limitKeyPrefix = extra?.limitKeyPrefix ?? null;
  }
}

async function keyAuthedRequest<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // Same fix as request() above: only send Content-Type when there is a body.
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${key}`,
  };
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    // The gateway (chat) error shape nests everything under `error` as an
    // object; the child-key admin-style shape is flat with `error` (if
    // present at all) as a plain string. Distinguish by the type of `error`.
    const nested = json as OpenAiErrorBody | null;
    if (nested?.error && typeof nested.error === "object") {
      throw new ChatApiError(res.status, nested.error.message ?? res.statusText, nested.error.code, nested.error.approval_id, {
        limitScope: nested.error.limit_scope ?? null,
        limitKeyPrefix: nested.error.limit_key_prefix ?? null,
      });
    }
    const flat = json as FlatKeyErrorBody | null;
    const message = flat?.message ?? (typeof flat?.error === "string" ? flat.error : undefined) ?? res.statusText;
    throw new ChatApiError(res.status, message, flat?.code ?? null, null, {
      field: flat?.field ?? null,
      parentValue: flat?.parent_value ?? null,
      limitScope: flat?.limit_scope ?? null,
      limitKeyPrefix: flat?.limit_key_prefix ?? null,
    });
  }
  return json as T;
}

/** GET /v1/models — only the models allowed for this MoneyKey. */
export async function listModelsForKey(key: string): Promise<string[]> {
  const res = await keyAuthedRequest<OpenAiModelsResponse>("/v1/models", key);
  return (res.data ?? []).map((m) => m.id);
}

/** POST /v1/chat/completions (non-streaming) — a real, paid call once the backend exists. */
export async function sendChatCompletion(key: string, model: string, messages: ChatMessage[], approvalId?: string | null): Promise<ChatCompletionResponse> {
  return keyAuthedRequest<ChatCompletionResponse>("/v1/chat/completions", key, {
    method: "POST",
    // approval_id: re-send after an admin approved an APPROVAL_REQUIRED payment (gateway reads it from the body).
    body: JSON.stringify({ model, messages, stream: false, ...(approvalId ? { approval_id: approvalId } : {}) }),
  });
}

// ---------------------------------------------------------------------------
// SPEC-v0.3-employee.md §A — employee view (MoneyKey auth, Bearer).
//
// Existing /v1/status shape (confirmed by coordinator): { remaining_today,
// remaining_total, per_request_limit, currency, network }. §B.0 has a
// backend coder concurrently adding optional key_name/key_prefix/
// daily_budget/total_budget to the same endpoint. All four are typed
// optional here; §A.8 says the frontend must fall back gracefully (masked
// key prefix instead of name, no daily/total ring) when they're absent.
// ---------------------------------------------------------------------------

export interface StatusResponse {
  remaining_today: string;
  remaining_total: string;
  per_request_limit: string;
  currency: string;
  network: string;
  /** ASSUMPTION (SPEC-v0.3-employee.md §B.0, being added concurrently): may be absent on old servers. */
  key_name?: string;
  /** ASSUMPTION (SPEC-v0.3-employee.md §B.0): may be absent on old servers. */
  key_prefix?: string;
  /** ASSUMPTION (SPEC-v0.3-employee.md §B.0): may be absent on old servers. */
  daily_budget?: string;
  /** ASSUMPTION (SPEC-v0.3-employee.md §B.0): may be absent on old servers. */
  total_budget?: string;

  // --- SPEC-v0.4.md §A: child keys / multi-level delegation. All optional —
  // absent on servers older than v0.4. ---
  /** Subtree total (this key's own spend + all descendants'). */
  used_today?: string;
  /** Subtree total (this key's own spend + all descendants'). */
  used_total?: string;
  /** remaining_today/remaining_total above are now EFFECTIVE (min over this key and its ancestors); these say whose limit is currently binding. */
  remaining_today_scope?: "self" | "ancestor";
  remaining_total_scope?: "self" | "ancestor";
  /** Effective approval threshold (this key's own, or a tighter ancestor's). */
  approval_threshold?: string | null;
  /** Effective expiry (this key's own, or an earlier ancestor's). */
  expires_at?: string | null;
  depth?: number;
  max_depth?: number;
  can_delegate?: boolean;
  can_create_children?: boolean;
  is_child?: boolean;
}

/** GET /v1/status — the logged-in MoneyKey's own remaining budget. Also used as the employee-login probe. */
export async function getStatus(key: string): Promise<StatusResponse> {
  return keyAuthedRequest<StatusResponse>("/v1/status", key);
}

// Existing /v1/history shape (confirmed by coordinator):
// { history: [{ id, url, method, network, amount, status, tx_hash, error_code, created_at, kind, model, prompt_tokens, completion_tokens }] }
export interface HistoryRow {
  id: string;
  url: string;
  method: string;
  network: string;
  amount: string;
  status: PaymentRow["status"];
  tx_hash: string | null;
  error_code: string | null;
  created_at: string;
  kind: "fetch" | "chat";
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** GET /v1/history — the logged-in MoneyKey's own payment history (no key_id/host columns — it's implicitly "mine"). */
export async function getHistory(key: string): Promise<HistoryRow[]> {
  const res = await keyAuthedRequest<{ history: HistoryRow[] }>("/v1/history", key);
  return res.history ?? [];
}

// ---------------------------------------------------------------------------
// SPEC-v0.4.md §A — child keys, employee-side ("我的子 Key" page). MoneyKey
// auth throughout — the caller's own key is always the implicit parent.
// ---------------------------------------------------------------------------

/** A direct child's row — same shape as an admin /v1/keys row (no key, no hash). */
export type ChildKeyRow = MoneyKeyRow;

export interface CreateChildKeyInput {
  name: string;
  daily_budget: string;
  total_budget: string;
  per_request_limit: string;
  approval_threshold?: string | null;
  allowed_hosts?: string[];
  allowed_models?: string[] | null;
  expires_at?: string | null;
  can_delegate?: boolean;
  max_payments_per_minute?: number;
}

export interface CreateChildKeyResponse extends ChildKeyRow {
  key: string; // plaintext mk_live_ key, shown once
}

/** GET /v1/keys/children — the caller's direct children only. */
export async function listMyChildKeys(key: string): Promise<ChildKeyRow[]> {
  const res = await keyAuthedRequest<{ children: ChildKeyRow[] }>("/v1/keys/children", key);
  return res.children ?? [];
}

/** POST /v1/keys/children — create a sub-key of the caller's own key. */
export async function createMyChildKey(key: string, input: CreateChildKeyInput): Promise<CreateChildKeyResponse> {
  return keyAuthedRequest<CreateChildKeyResponse>("/v1/keys/children", key, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** POST /v1/keys/children/:id/revoke — only works for a key in the caller's own subtree. */
export async function revokeMyChildKey(key: string, id: string): Promise<{ id: string; revoked: boolean }> {
  return keyAuthedRequest<{ id: string; revoked: boolean }>(`/v1/keys/children/${id}/revoke`, key, { method: "POST" });
}

// ---------------------------------------------------------------------------
// First-run setup + metadata (docs/ux-audit.md A-1/A-7/A-11)
// ---------------------------------------------------------------------------

/** GET /v1/setup/status — unauthenticated; only says whether a one-time setup link is still claimable. */
export async function getSetupStatus(): Promise<{ setup_link_active: boolean; demo?: boolean }> {
  const res = await fetch("/v1/setup/status");
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}

/** POST /v1/setup/claim — exchanges the one-time setup token from the startup log for the admin token. */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const res = await fetch("/v1/setup/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setup_token: setupToken }),
  });
  const body = (await res.json().catch(() => null)) as { admin_token?: string; error?: string } | null;
  if (!res.ok || !body?.admin_token) {
    throw new ApiError(res.status, body?.error ?? res.statusText, body?.error ?? null);
  }
  return body.admin_token;
}

export interface AdminMeta {
  network: string;
  chain_id: number | null;
  usdc_address: string;
  explorer_base: string;
  /** Human-readable network name, e.g. "Monad testnet" / "Monad mainnet". */
  network_label?: string;
  /** True when the active network is Monad mainnet (real USDC). */
  is_mainnet?: boolean;
  faucet_url: string | null;
  demo_seller_url: string | null;
  cli_tarball_available: boolean;
  cli_local_path: string | null;
  mcp_local_path: string | null;
  wallet_password_from_env: boolean;
  /** v0.5: this MoneySwitch wallet's address = default receiving address for toll booths (null if no wallet yet). */
  wallet_address: string | null;
  /** v0.5: base URL buyers use, e.g. "http://127.0.0.1:4020" (toll booths live at <public_base>/t/<slug>). */
  public_base: string;
  /** v0.5: true when public_base comes from MONEYSWITCH_PUBLIC_URL rather than the browser's origin. */
  public_base_from_env: boolean;
  /** true only on the offline demo (`moneyswitch-server demo`). */
  demo?: boolean;
}

/** GET /v1/admin/meta — admin only. */
export async function getAdminMeta(): Promise<AdminMeta> {
  return request<AdminMeta>("/v1/admin/meta");
}

/** HEAD /dl/moneyswitch.tgz — is the packed client CLI downloadable from this server? (no auth; works for employees too) */
export async function isCliTarballAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/dl/moneyswitch.tgz", { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// v0.5 (SPEC-v0.5 §2): toll booths + earnings
// ---------------------------------------------------------------------------

export type TollMethod = "ANY" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface TollRouteRow {
  id: string;
  method: TollMethod;
  /** "/v1/chat/completions" (exact) or "/v1/*" (prefix / wildcard). */
  path_pattern: string;
  /** USDC decimal string; "0" = free pass-through. */
  price: string;
  description: string | null;
}

export interface TollboothRow {
  id: string;
  name: string;
  slug: string;
  upstream_url: string;
  pay_to: string;
  /** true when pay_to is this MoneySwitch's own wallet. */
  pay_to_is_wallet: boolean;
  network: string;
  enabled: boolean;
  forward_host_header: boolean;
  /** Price for requests matching no rule; null = refuse them (404). */
  default_price: string | null;
  description: string | null;
  /** "<public_base>/t/<slug>" — buyers call public_url + "/any/path". */
  public_url: string;
  routes: TollRouteRow[];
  earnings_today: string;
  paid_calls_today: number;
  earnings_total: string;
  paid_calls_total: number;
  created_at: string;
  updated_at: string;
}

export interface TollRouteInput {
  method: TollMethod;
  path_pattern: string;
  price: string;
  description?: string | null;
}

export interface CreateTollboothInput {
  name: string;
  slug?: string;
  upstream_url: string;
  /** Omit to use this MoneySwitch's own wallet address. */
  pay_to?: string;
  default_price: string | null;
  description?: string | null;
  forward_host_header?: boolean;
  enabled?: boolean;
  routes: TollRouteInput[];
}

export type UpdateTollboothInput = Partial<Omit<CreateTollboothInput, "routes">> & { routes?: TollRouteInput[] };

export async function listTollbooths(): Promise<TollboothRow[]> {
  const res = await request<{ tollbooths: TollboothRow[] }>("/v1/admin/tollbooths");
  return res.tollbooths;
}

export async function getTollbooth(id: string): Promise<TollboothRow> {
  return request<TollboothRow>(`/v1/admin/tollbooths/${encodeURIComponent(id)}`);
}

/**
 * Errors (ApiError.error / ApiError.reason): 400 "INVALID_PAY_TO" with reason
 * "LOOKS_LIKE_MONEYKEY" | "LOOKS_LIKE_ADMIN_TOKEN" | "LOOKS_LIKE_PRIVATE_KEY" | "LOOKS_LIKE_MNEMONIC" |
 * "BAD_CHECKSUM" | "NOT_AN_ADDRESS" | "ZERO_ADDRESS" | "EMPTY"; "INVALID_UPSTREAM", "UPSTREAM_IS_SELF",
 * "INVALID_ROUTE", "INVALID_PRICE", "INVALID_NAME", "INVALID_SLUG", "PAY_TO_REQUIRED"; 409 "SLUG_TAKEN".
 */
export async function createTollbooth(input: CreateTollboothInput): Promise<TollboothRow> {
  return request<TollboothRow>("/v1/admin/tollbooths", { method: "POST", body: JSON.stringify(input) });
}

export async function updateTollbooth(id: string, input: UpdateTollboothInput): Promise<TollboothRow> {
  return request<TollboothRow>(`/v1/admin/tollbooths/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteTollbooth(id: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/v1/admin/tollbooths/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type UpstreamProbe =
  | { ok: true; status: number; latency_ms: number; content_type: string | null; healthy: boolean }
  | { ok: false; error: "UPSTREAM_IS_SELF" | "INVALID_UPSTREAM" | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNREACHABLE" | string; message: string };

/** Free reachability check of an upstream URL (never charges). */
export async function testUpstream(upstreamUrl: string): Promise<UpstreamProbe> {
  return request<UpstreamProbe>("/v1/admin/tollbooths/test-upstream", { method: "POST", body: JSON.stringify({ upstream_url: upstreamUrl }) });
}

export async function testTollbooth(id: string): Promise<UpstreamProbe> {
  return request<UpstreamProbe>(`/v1/admin/tollbooths/${encodeURIComponent(id)}/test`, { method: "POST" });
}

export type EarningsRange = "today" | "7d" | "all";

export interface EarningItem {
  id: string;
  created_at: string;
  tollbooth_id: string;
  tollbooth_slug: string;
  tollbooth_name: string;
  route_id: string | null;
  method: string;
  path: string;
  amount: string;
  payer: string | null;
  tx_hash: string | null;
  mock: boolean;
  network: string;
  /** settled = money received; failed = upstream error / settlement failed, buyer NOT charged. */
  status: "settled" | "failed";
  upstream_status: number | null;
  error_code: string | null;
}

export interface EarningsResponse {
  range: EarningsRange;
  since: string | null;
  /** Sum of settled amounts in range. */
  total: string;
  settled_count: number;
  failed_count: number;
  by_tollbooth: Array<{ tollbooth_id: string; slug: string; name: string; deleted: boolean; total: string; count: number }>;
  by_route: Array<{
    tollbooth_id: string;
    route_id: string | null;
    method: string;
    path_pattern: string | null;
    /** true = income from requests that matched no rule (the toll booth's default price). */
    is_default: boolean;
    total: string;
    count: number;
  }>;
  /** Newest first, at most 500. */
  items: EarningItem[];
}

export async function getEarnings(range: EarningsRange = "all", tollboothId?: string): Promise<EarningsResponse> {
  const q = new URLSearchParams({ range });
  if (tollboothId) q.set("tollbooth", tollboothId);
  return request<EarningsResponse>(`/v1/admin/earnings?${q.toString()}`);
}

export interface PaidFetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  max_price?: string;
  approval_id?: string;
}

/** POST /v1/fetch envelope (docs/money-api-v0.md). */
export interface PaidFetchResponse {
  /** "payment_unknown": a payment was signed and sent, then the response was lost — it may have been charged; never resend blindly. */
  status: "ok" | "denied" | "approval_required" | "payment_failed" | "payment_unknown" | "error";
  code: string | null;
  /**
   * Whether this call cost money: "yes" a settlement was confirmed, "no" definitely nothing was
   * signed or charged, "maybe" a payment was signed and sent but the outcome is unknown.
   * Absent on servers older than this field (treat as the pre-field behaviour).
   */
  charged?: "yes" | "no" | "maybe";
  http_status: number | null;
  headers: Record<string, string>;
  body: string | null;
  payment: { amount: string; tx_hash: string | null; network: string; mock?: boolean } | null;
  /** Human-readable explanation for payment_unknown / UPSTREAM_BODY_INCOMPLETE / PAYMENT_REJECTED. */
  reason?: string | null;
  reserved_until_expiry?: boolean;
  approval_id: string | null;
  remaining_today: string;
  remaining_total: string;
  limit_scope?: string;
  limit_key_prefix?: string;
}

/** Pays for an x402 URL with a MoneyKey (the agent path, used by the Playground's "paid fetch" mode). */
export async function paidFetch(key: string, input: PaidFetchInput): Promise<PaidFetchResponse> {
  const res = await fetch("/v1/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(input),
  });
  const json = (await res.json().catch(() => null)) as PaidFetchResponse | { code?: string; message?: string; hint?: string } | null;
  if (!res.ok && (!json || !("status" in json))) {
    const j = json as { code?: string; message?: string; hint?: string } | null;
    throw new ApiError(res.status, j?.message ?? j?.code ?? res.statusText, j?.code ?? null, null, j?.hint ?? null);
  }
  return json as PaidFetchResponse;
}
