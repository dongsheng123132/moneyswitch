export interface MoneyKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  enabled: boolean;
  totalBudget: bigint;
  dailyBudget: bigint;
  perRequestLimit: bigint;
  approvalThreshold: bigint | null;
  allowedHosts: string[];
  maxPaymentsPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** v0.2 (SPEC-v0.2 §1): null = allowed to use all enabled channels' models. */
  allowedModels: string[] | null;
  /** v0.4 (SPEC-v0.4 §A): parent key id; null for a root (admin-created) key. */
  parentId: string | null;
  /** v0.4: 0 for a root key, parent.depth + 1 for a child key. */
  depth: number;
  /** v0.4: may this key create child keys? */
  canDelegate: boolean;
  /** v0.4: "admin" or "key:<parentId>". */
  createdBy: string;
}

export type PaymentStatus = "reserved" | "settled" | "failed" | "unknown";
export type PaymentKind = "fetch" | "chat";

export interface PaymentRow {
  id: string;
  keyId: string;
  url: string;
  host: string;
  method: string;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
  status: PaymentStatus;
  txHash: string | null;
  errorCode: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  /** v0.2 (SPEC-v0.2 §2 step 7). */
  kind: PaymentKind;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** v0.5: EIP-3009 authorization fields, captured right after the client signs (unknown-payment reconciliation). */
  authFrom: string | null;
  authNonce: string | null;
  authValidBefore: number | null;
  reconciledAt: string | null;
}

/** v0.2 (SPEC-v0.2 §1): a channel = an OpenAI-protocol, x402-billed upstream. */
export interface ChannelRow {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";

export interface ApprovalRow {
  id: string;
  keyId: string;
  url: string;
  method: string;
  bodySha256: string;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

/** Error codes from SPEC §6. */
export type MoneySwitchErrorCode =
  | "KEY_INVALID"
  | "KEY_REVOKED"
  | "KEY_EXPIRED"
  | "RATE_LIMITED"
  | "HOST_NOT_ALLOWED"
  | "SSRF_BLOCKED"
  | "UNSUPPORTED_PAYMENT"
  | "PER_REQUEST_LIMIT_EXCEEDED"
  | "MAX_PRICE_EXCEEDED"
  | "DAILY_BUDGET_EXCEEDED"
  | "TOTAL_BUDGET_EXCEEDED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "WALLET_LOCKED"
  | "WALLET_BUSY"
  | "PAYMENT_FAILED"
  | "UPSTREAM_ERROR"
  | "FORBIDDEN";

/**
 * v0.4 (SPEC-v0.4 §A): which level of the key chain produced a key/limit
 * denial — the paying key itself, or one of its ancestors.
 */
export type LimitScope = "self" | "ancestor";

export interface LimitInfo {
  scope: LimitScope;
  /** key_prefix (public, 12 chars) of the key whose state/limit denied the request. */
  keyPrefix: string;
}

export class MoneySwitchError extends Error {
  code: MoneySwitchErrorCode;
  /** v0.4: set for key-state and budget denials (KEY_*, *_LIMIT_EXCEEDED, *_BUDGET_EXCEEDED). */
  limit?: LimitInfo;
  constructor(code: MoneySwitchErrorCode, message?: string, limit?: LimitInfo) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
    this.name = "MoneySwitchError";
    if (limit) this.limit = limit;
  }
}

/** Wire shape of MoneySwitchError.limit (`limit_scope` / `limit_key_prefix`), or {} when absent. */
export function limitFields(e: unknown): { limit_scope?: LimitScope; limit_key_prefix?: string } {
  if (e instanceof MoneySwitchError && e.limit) {
    return { limit_scope: e.limit.scope, limit_key_prefix: e.limit.keyPrefix };
  }
  return {};
}
