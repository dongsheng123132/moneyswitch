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
  | "PAYMENT_FAILED"
  | "UPSTREAM_ERROR"
  | "FORBIDDEN";

export class MoneySwitchError extends Error {
  code: MoneySwitchErrorCode;
  constructor(code: MoneySwitchErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
    this.name = "MoneySwitchError";
  }
}
