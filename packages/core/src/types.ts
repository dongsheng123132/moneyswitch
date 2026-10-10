/** v0.7.2 (SPEC.md §1): which kind of chain a key pays on; chosen when the key is issued, never changed. */
export type NetworkMode = "testnet" | "mainnet";

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
  /** v0.4 (SPEC-v0.4 §A): parent key id; null for a root (admin-created) key. */
  parentId: string | null;
  /** v0.4: 0 for a root key, parent.depth + 1 for a child key. */
  depth: number;
  /** v0.4: may this key create child keys? */
  canDelegate: boolean;
  /** v0.4: "admin" or "key:<parentId>". */
  createdBy: string;
  /** v0.7.2: 'testnet' / 'mainnet'; null = a key issued before v0.7.2, which pays on every enabled network. */
  networkMode: NetworkMode | null;
  /** v0.7.4: the salted scrypt hash of the approval PIN (`scrypt$<salt>$<hash>`); null = none (a key issued before v0.7.4, and every child key: it uses its root key's). */
  approvalPin: string | null;
  /** v0.7.4: wrong approval PINs since the PIN was last set (a right one does not reset it); APPROVAL_PIN_MAX_FAILURES locks the PIN. */
  approvalPinFailures: number;
}

export type PaymentStatus = "reserved" | "settled" | "failed" | "unknown";
/** "chat" only on rows written by the removed OpenAI-compatible gateway; they stay readable in the history. */
export type PaymentKind = "fetch" | "chat";

export interface SvmPaymentEvidence {
  transaction: string;
  messageHash: string;
  payer: string;
  payerSignature: string;
  blockhash: string;
}

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
  kind: PaymentKind;
  /** v0.5: EIP-3009 authorization fields, captured right after the client signs (unknown-payment reconciliation). */
  authFrom: string | null;
  authNonce: string | null;
  authValidBefore: number | null;
  reconciledAt: string | null;
  svmEvidence?: SvmPaymentEvidence | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";

/** 'payment': a price over the approval line. 'host': a request to a host outside the key's allowed list (no price yet). */
export type ApprovalKind = "payment" | "host";

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
  kind: ApprovalKind;
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
  | "PRICE_INVALID"
  | "INSUFFICIENT_FUNDS"
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
