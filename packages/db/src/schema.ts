import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * All money fields are stored as SQLite INTEGER (micro-USDC, 6 decimals).
 * They are read/written as JS `number` at the SQLite boundary (safe: max
 * representable value ~9e15 micro-USDC >> any realistic budget) and MUST be
 * converted to/from `bigint` at the application boundary in packages/core.
 * No floating point is ever used for money arithmetic.
 */

export const moneyKeys = sqliteTable("money_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  totalBudget: integer("total_budget").notNull(),
  dailyBudget: integer("daily_budget").notNull(),
  perRequestLimit: integer("per_request_limit").notNull(),
  approvalThreshold: integer("approval_threshold"),
  allowedHosts: text("allowed_hosts", { mode: "json" }).notNull().$type<string[]>(),
  maxPaymentsPerMinute: integer("max_payments_per_minute").notNull().default(10),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  /** v0.2 (SPEC-v0.2 §1): JSON array of allowed model ids, or NULL = all enabled channels' models. */
  allowedModels: text("allowed_models", { mode: "json" }).$type<string[] | null>(),
  /** v0.4 (SPEC-v0.4 §A): parent key id, NULL for a root key (created by the admin). */
  parentId: text("parent_id"),
  /** v0.4: 0 for a root key, parent.depth + 1 for a child. */
  depth: integer("depth").notNull().default(0),
  /** v0.4: whether this key may create child keys (POST /v1/keys/children). */
  canDelegate: integer("can_delegate", { mode: "boolean" }).notNull().default(false),
  /** v0.4: "admin" or "key:<parentId>". */
  createdBy: text("created_by").notNull().default("admin"),
});

/** v0.2 (SPEC-v0.2 §1): an upstream that speaks OpenAI protocol and charges via x402. */
export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  models: text("models", { mode: "json" }).notNull().$type<string[]>(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  keyId: text("key_id").notNull(),
  url: text("url").notNull(),
  host: text("host").notNull(),
  method: text("method").notNull(),
  network: text("network").notNull(),
  asset: text("asset").notNull(),
  payTo: text("pay_to").notNull(),
  amount: integer("amount").notNull(),
  status: text("status", { enum: ["reserved", "settled", "failed", "unknown"] }).notNull(),
  txHash: text("tx_hash"),
  errorCode: text("error_code"),
  approvalId: text("approval_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** v0.2 (SPEC-v0.2 §2 step 7): "fetch" (default, /v1/fetch) or "chat" (/v1/chat/completions). */
  kind: text("kind", { enum: ["fetch", "chat"] }).notNull().default("fetch"),
  model: text("model"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  keyId: text("key_id").notNull(),
  url: text("url").notNull(),
  method: text("method").notNull(),
  bodySha256: text("body_sha256").notNull(),
  network: text("network").notNull(),
  asset: text("asset").notNull(),
  payTo: text("pay_to").notNull(),
  amount: integer("amount").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied", "expired", "used"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  createdAt: text("created_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: text("detail", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

export const adminAuth = sqliteTable("admin_auth", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

export const walletMeta = sqliteTable("wallet_meta", {
  id: text("id").primaryKey(),
  address: text("address"),
  createdAt: text("created_at").notNull(),
});
