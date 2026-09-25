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
  constructor(status: number, message: string, code?: string | null) {
    super(message);
    this.status = status;
    this.code = code;
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
    const errObj = json as { error?: string; message?: string; code?: string } | null;
    const message = errObj?.message || errObj?.error || errObj?.code || res.statusText || "request_failed";
    throw new ApiError(res.status, message, errObj?.code ?? null);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// MoneyKeys
// ---------------------------------------------------------------------------

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
  used_today: string;
  used_total: string;
  // SPEC-v0.2 §1: MoneyKey allowed_models — null = all models from enabled
  // channels are allowed. Confirmed present on every /v1/keys row by the
  // real v0.2 server (verified on testnet).
  allowed_models: string[] | null;
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
  };
}

/** Thrown by the MoneyKey-authed gateway calls; carries the OpenAI-shaped error fields. */
export class ChatApiError extends Error {
  status: number;
  code: string | null;
  approvalId: string | null;
  constructor(status: number, message: string, code?: string | null, approvalId?: string | null) {
    super(message);
    this.status = status;
    this.code = code ?? null;
    this.approvalId = approvalId ?? null;
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
    const body = json as OpenAiErrorBody | null;
    throw new ChatApiError(res.status, body?.error?.message ?? res.statusText, body?.error?.code, body?.error?.approval_id);
  }
  return json as T;
}

/** GET /v1/models — only the models allowed for this MoneyKey. */
export async function listModelsForKey(key: string): Promise<string[]> {
  const res = await keyAuthedRequest<OpenAiModelsResponse>("/v1/models", key);
  return (res.data ?? []).map((m) => m.id);
}

/** POST /v1/chat/completions (non-streaming) — a real, paid call once the backend exists. */
export async function sendChatCompletion(key: string, model: string, messages: ChatMessage[]): Promise<ChatCompletionResponse> {
  return keyAuthedRequest<ChatCompletionResponse>("/v1/chat/completions", key, {
    method: "POST",
    body: JSON.stringify({ model, messages, stream: false }),
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
