// Central API client + type definitions for the MoneySwitch admin API (apps/server/src/routes/*). Every call here is made with the
// administrator's token (SPEC.md §2): the dashboard has no other login.

const TOKEN_KEY = "moneyswitch_admin_token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string | null;
  /** The server's `error` field (e.g. "ADDRESS_MISMATCH", "WALLET_BUSY"). */
  error?: string | null;
  /** A wrong approval PIN (APPROVAL_PIN_WRONG): how many tries are left before the key's PIN locks. */
  attemptsLeft?: number | null;
  constructor(status: number, message: string, code?: string | null, error?: string | null, attemptsLeft?: number | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.error = error ?? null;
    this.attemptsLeft = attemptsLeft ?? null;
  }
}

export const GET_TIMEOUT_MS = 30_000;
export const CREATE_KEY_TIMEOUT_MS = 30_000;

/** `anonymous`: send no Authorization even when the administrator is signed in (the approval link's PIN calls, SPEC.md §3). */
async function request<T>(path: string, init?: RequestInit, opts?: { anonymous?: boolean }): Promise<T> {
  const token = opts?.anonymous ? null : getToken();
  const headers: Record<string, string> = {
    // Only set Content-Type when there actually is a JSON body. Fastify's JSON body parser rejects a request that declares
    // "Content-Type: application/json" but sends an empty body (this used to break every no-body POST with a 400).
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // A GET that never answers would otherwise hold a polling slot forever (usePolling skips a tick while one is in flight).
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  const signal = init?.signal ?? (isGet ? AbortSignal.timeout(GET_TIMEOUT_MS) : undefined);
  const res = await fetch(path, { ...init, headers, signal });
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
    const errObj = json as { error?: string; message?: string; code?: string; attempts_left?: number } | null;
    const message = errObj?.message || errObj?.error || errObj?.code || res.statusText || "request_failed";
    throw new ApiError(res.status, message, errObj?.code ?? null, errObj?.error ?? null, errObj?.attempts_left ?? null);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

// A key's status accounts for cascading revoke / expiry down an ancestor chain: a key can be enabled and unexpired yet unusable
// because a parent was revoked or expired (child keys exist only through the agent API; the page lists them like any other key and has no UI for them).
export type MoneyKeyStatus = "active" | "revoked" | "expired" | "ancestor_revoked" | "ancestor_expired";

/** The kind of chain a key pays on (SPEC.md §1): fixed when the key is issued. */
export type NetworkMode = "testnet" | "mainnet";

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
  // used_today / used_total are SUBTREE totals (this key's own spend + every descendant's). Never sum them across parent and child
  // rows (double counting): a root's total is its own row.
  used_today: string;
  used_total: string;
  parent_id: string | null;
  depth: number;
  can_delegate: boolean;
  created_by: string; // "admin" | "key:<parentId>"
  /** The key's effective network type (its own, else its parent's); null = a key with none (issued before v0.7.2): see `networks` for where it pays. */
  network_mode: NetworkMode | null;
  /** CAIP-2 ids of the chains this key can pay on now. */
  networks: string[];
  children_count: number;
  status: MoneyKeyStatus;
  // This key's own spend only (excludes descendants).
  own_used_today: string;
  own_used_total: string;
  /** A root key's approval PIN (SPEC.md §3): "set"; "none" = no PIN (issued before v0.7.4), only the administrator can approve for it; "locked" = five wrong tries in a row. null for a child key (it uses its root key's). */
  approval_pin_state?: ApprovalPinState | null;
  /** Wrong PINs since this root key's PIN was last set (a right one does not take them back; 5 lock it); null for a child key. */
  approval_pin_failures?: number | null;
}

export type ApprovalPinState = "none" | "set" | "locked";

export interface CreateMoneyKeyInput {
  name: string;
  total_budget: string;
  daily_budget: string;
  per_request_limit: string;
  approval_threshold?: string | null;
  allowed_hosts: string[];
  max_payments_per_minute?: number;
  expires_at?: string | null;
  network_mode?: NetworkMode;
  /** 4-6 digits for the person who holds the key; left out, the server makes a random 4-digit one. */
  approval_pin?: string;
}

export interface CreateMoneyKeyResponse extends Omit<MoneyKeyRow, "key_prefix" | "used_today" | "used_total" | "last_used_at" | "created_at"> {
  key: string; // plaintext key, only ever returned here
  approval_pin: string; // the PIN for the person who holds the key, only ever returned here (or by setApprovalPin)
}

export async function listKeys(): Promise<MoneyKeyRow[]> {
  const res = await request<{ keys: MoneyKeyRow[] }>("/v1/keys");
  return res.keys;
}

export async function createKey(input: CreateMoneyKeyInput): Promise<CreateMoneyKeyResponse> {
  return request<CreateMoneyKeyResponse>("/v1/keys", {
    method: "POST",
    signal: AbortSignal.timeout(CREATE_KEY_TIMEOUT_MS),
    body: JSON.stringify(input),
  });
}

export async function revokeKey(id: string): Promise<{ id: string; revoked: boolean }> {
  return request(`/v1/keys/${id}/revoke`, { method: "POST" });
}

/** POST /v1/keys/:id/rotate — new secret for the same key id; the old one stops working at once. The plaintext is returned only here. */
export interface RotateKeyResponse {
  id: string;
  key: string;
  name: string;
  key_prefix: string;
  allowed_hosts: string[];
  parent_id: string | null;
  depth: number;
  network_mode?: NetworkMode | null;
}

export async function rotateKey(id: string): Promise<RotateKeyResponse> {
  return request<RotateKeyResponse>(`/v1/keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
}

/** POST /v1/keys/:id/approval-pin — sets (a random 4-digit one when `pin` is left out) or replaces a root key's approval PIN, and unlocks it. The PIN is returned only here. */
export async function setApprovalPin(id: string, pin?: string): Promise<{ id: string; approval_pin: string }> {
  return request(`/v1/keys/${encodeURIComponent(id)}/approval-pin`, { method: "POST", ...(pin ? { body: JSON.stringify({ approval_pin: pin }) } : {}) });
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
  /** "payment" = a price over the approval line; "host" = a request to a host outside the key's list (no price yet: amount "0"). */
  kind: "payment" | "host";
  /** Only on a "host" approval: the host:port approving it adds to the key's list, spelled by the server (the page shows it, it parses no URL). */
  host?: string | null;
  /** Whether `network` is a mainnet or a testnet; null for a host approval (no chain yet) or a chain the server does not know. */
  network_kind?: NetworkMode | null;
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
  return request(`/v1/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

export async function denyApproval(id: string): Promise<{ id: string; status: string }> {
  return request(`/v1/approvals/${encodeURIComponent(id)}/deny`, { method: "POST" });
}

/** One request as the approval link shows it to the person who holds the key (no login): GET /v1/approvals?id=… (SPEC.md §3). No key id, no secret. */
export interface ApprovalLink extends Omit<ApprovalRow, "key_id"> {
  key_name: string | null;
  /** The name of the chain the price is on; null for a host approval. */
  network_label: string | null;
  /** The PIN of the request's root key: "none" = only the administrator can approve, "locked" = five wrong tries since it was set. */
  pin_state: ApprovalPinState;
  /** Wrong tries that PIN has had since it was last set. */
  pin_failures: number;
}

export async function getApprovalByLink(id: string): Promise<ApprovalLink> {
  const res = await request<{ approval: ApprovalLink }>(`/v1/approvals?id=${encodeURIComponent(id)}`, undefined, { anonymous: true });
  return res.approval;
}

/** Approve / deny with the key's PIN and no login. Refused with APPROVAL_PIN_WRONG (attemptsLeft), APPROVAL_PIN_LOCKED, APPROVAL_PIN_NOT_SET, APPROVAL_KEY_NOT_ACTIVE, APPROVAL_NOT_PENDING. */
export async function decideWithPin(id: string, decision: "approve" | "deny", pin: string): Promise<{ id: string; status: string }> {
  return request(`/v1/approvals/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: JSON.stringify({ pin }) }, { anonymous: true });
}

// ---------------------------------------------------------------------------
// Bills (the payment ledger)
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  key_id: string;
  url: string;
  host: string;
  method: string;
  network: string;
  /** Whether `network` is a mainnet or a testnet (the server's configuration table); null for a chain it does not know. */
  network_kind?: NetworkMode | null;
  asset: string;
  pay_to: string;
  amount: string;
  status: "reserved" | "settled" | "failed" | "unknown";
  tx_hash: string | null;
  error_code: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
  // A payment is "mock" when the server says so or its tx hash starts with the `0xmock` convention of the offline mock facilitator.
  mock?: boolean;
  // "fetch" for every payment made now; "chat" only on old rows written by the removed OpenAI-compatible gateway.
  kind: "fetch" | "chat";
}

/** `truncated`: the server holds more payments than it sent (it caps the list); `total`: how many it holds in all. */
export interface BillsList {
  payments: PaymentRow[];
  truncated: boolean;
  total: number;
}

export async function listBills(): Promise<BillsList> {
  const res = await request<{ payments: PaymentRow[]; truncated: boolean; total: number }>("/v1/admin/usage");
  return { payments: res.payments, truncated: res.truncated, total: res.total };
}

export function isMockPayment(p: PaymentRow): boolean {
  return Boolean(p.mock) || Boolean(p.tx_hash && p.tx_hash.startsWith("0xmock"));
}

// ---------------------------------------------------------------------------
// Wallet (SPEC.md §1: status, create, "I wrote it down", replace)
// ---------------------------------------------------------------------------

/** Why one unlock source did not open the wallet (never contains a credential). */
export type UnlockFailureReason = "env_wrong" | "secret_missing" | "secret_empty" | "secret_unreadable" | "secret_wrong";

/** GET /v1/admin/wallet → health: what would happen after a restart, whether the words were acknowledged, how much is at risk. */
export interface WalletHealth {
  /** How wallet.json is protected, as RECORDED in it: auto = a random secret kept on the server, password = a wallet made by an older version, none = no wallet. */
  protection: "auto" | "password" | "none";
  /** auto = the wallet's own unlock secret; env_or_file = MONEYSWITCH_WALLET_PASSWORD(_FILE); manual = a password wallet nobody gave the password to; none = no wallet. */
  unlock_mode: "auto" | "env_or_file" | "manual" | "none";
  /** Result of the last real decrypt attempt; null = no attempt (manual / none). */
  auto_unlock_ok: boolean | null;
  /** The last startup attempt per source, each with its own reason when it failed. */
  unlock_sources: Array<{ source: "env_or_file" | "auto"; ok: boolean; reason?: UnlockFailureReason }>;
  /** Auto wallets only: does the unlock secret file exist right now? false = the next restart leaves the wallet locked. */
  secret_file_present: boolean | null;
  /** Names of files inside retired/ that hold an unlock secret which still opens a legacy password wallet without its password. */
  retired_secrets_open_live_key: string[];
  /** false = the data folder / unlock secret could NOT be restricted to the server's account (red warning); null = nothing to protect. */
  secret_protected: boolean | null;
  secret_protection_detail: string | null;
  /** Credential files that belong to no live wallet.json. wallet_file_missing = wallet.json is gone but they remain. */
  orphan_files: { secrets: string[]; retired: number; wallet_file_missing: boolean };
  backup: "confirmed" | "missing" | "not_applicable";
  /** USDC, e.g. "50". */
  float_limit: string;
  /** Per enabled chain where the balance is known (CAIP-2 → over the limit?). */
  over_float_limit: Record<string, boolean>;
}

/** The same address on one chain. */
export interface WalletNetwork {
  network: string;
  label: string;
  explorer_base: string;
  is_mainnet: boolean;
  /** USDC; null = the RPC did not answer. */
  usdc_balance: string | null;
  over_float_limit: boolean | null;
}

export interface RetiredWalletRow {
  address: string;
  retired_at: string;
  reason: string;
  keystore_file: string;
  has_secret_file: boolean;
  replaced_by: string | null;
  /** USDC per enabled chain (CAIP-2); null = could not be read. */
  balances: Record<string, string | null>;
}

export interface WalletInfo {
  address: string | null;
  unlocked: boolean;
  has_keystore: boolean;
  /** Whether the keystore holds a 12-word recovery phrase (false for a wallet made from a bare private key by an older version). */
  has_recovery_phrase: boolean;
  backup_confirmed_at: string | null;
  /** The default chain, for the one-line balance. */
  network: string;
  usdc_balance: string | null;
  networks: WalletNetwork[];
  retired_wallets: RetiredWalletRow[];
  health: WalletHealth;
}

export async function getWallet(): Promise<WalletInfo> {
  return request("/v1/admin/wallet");
}

export interface CreatedWallet {
  address: string;
  /** The 12 words, returned exactly once. */
  recovery_phrase: string;
  backup_confirmed: boolean;
}

/** The wallet unlocks itself after a restart; there is no password to choose. */
export async function createWallet(): Promise<CreatedWallet> {
  return request("/v1/admin/wallet/create", { method: "POST" });
}

/**
 * "I wrote the 12 words down": records the acknowledgement for the wallet whose words were on screen. The server answers 409
 * WALLET_CHANGED when that is no longer the current wallet (it was replaced meanwhile), and records nothing.
 */
export async function confirmBackup(address: string): Promise<{ confirmed: boolean; backup_confirmed_at: string }> {
  return request("/v1/admin/wallet/backup/confirm", { method: "POST", body: JSON.stringify({ address }) });
}

export type ReplaceReason = "replaced" | "lost_password" | "suspected_leak";

export interface ReplacedWallet extends CreatedWallet {
  retired: { address: string; retired_at: string; reason: string; keystore_file: string };
}

/** The old wallet files are moved to <data dir>/retired/ (never deleted). 409 WALLET_BUSY while a payment is in flight. */
export async function replaceWallet(confirmAddress: string, reason: ReplaceReason): Promise<ReplacedWallet> {
  return request("/v1/admin/wallet/replace", {
    method: "POST",
    body: JSON.stringify({ confirm_address: confirmAddress, reason }),
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

// There is no dedicated whoami endpoint; GET /v1/keys is a cheap, side-effect-free admin route that answers 403 for a bad or missing
// token (see apps/server/src/auth.ts).
export async function verifyAdminToken(token: string): Promise<boolean> {
  const res = await fetch("/v1/keys", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** GET /v1/setup/status — unauthenticated; only says whether a one-time setup link is still claimable. */
export async function getSetupStatus(): Promise<{ setup_link_active: boolean }> {
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
  networks?: Array<{ network: string; chain_id: number; usdc_address: string; network_label: string; explorer_base: string; is_mainnet: boolean }>;
  /** CAIP-2 id of the default network. */
  network: string;
  chain_id: number | null;
  usdc_address: string;
  explorer_base: string;
  /** Human-readable network name, e.g. "Monad testnet" / "Monad mainnet". */
  network_label?: string;
  /** True when the default network is a mainnet (real USDC). */
  is_mainnet?: boolean;
  faucet_url: string | null;
  wallet_password_from_env: boolean;
  /** This MoneySwitch wallet's address (null if no wallet yet). */
  wallet_address: string | null;
  /** Base URL the skill is written for, e.g. "http://127.0.0.1:4020". */
  public_base: string;
  /** True when public_base comes from MONEYSWITCH_PUBLIC_URL rather than the browser's origin. */
  public_base_from_env: boolean;
}

/** GET /v1/admin/meta — admin only. */
export async function getAdminMeta(): Promise<AdminMeta> {
  return request<AdminMeta>("/v1/admin/meta");
}
