import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

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
  /** LEGACY (v0.2 model allow-list of the removed OpenAI-compatible gateway): kept in the table, no longer read or written. */
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

/** LEGACY (v0.2 model channels of the removed OpenAI-compatible gateway): the table stays, nothing reads or writes it any more. */
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
  /** "fetch" for every payment made now; old rows of the removed gateway are "chat" and still list. */
  kind: text("kind", { enum: ["fetch", "chat"] }).notNull().default("fetch"),
  /** LEGACY (chat rows only): no longer read or written. */
  model: text("model"),
  /** LEGACY (chat rows only): no longer read or written. */
  promptTokens: integer("prompt_tokens"),
  /** LEGACY (chat rows only): no longer read or written. */
  completionTokens: integer("completion_tokens"),
  /** v0.5: EIP-3009 authorization.from, captured right after the client signs it. */
  authFrom: text("auth_from"),
  /** v0.5: EIP-3009 authorization.nonce (bytes32 hex). */
  authNonce: text("auth_nonce"),
  /** v0.5: EIP-3009 authorization.validBefore, unix seconds. */
  authValidBefore: integer("auth_valid_before"),
  /** v0.5: when reconcileUnknownPayments last resolved this row (null = not yet reconciled). */
  reconciledAt: text("reconciled_at"),
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
  /** 'payment' = a price over the approval line; 'host' = a request to a host outside the key's allowed list (no price yet: network / asset / pay_to '' and amount 0). Migration 0008. */
  kind: text("kind", { enum: ["payment", "host"] }).notNull().default("payment"),
  /** LEGACY (push notifications, removed): no longer read or written; the column stays. */
  notifiedAt: text("notified_at"),
  /** Superseded by approval_notify_deliveries (migration 0006); no longer written, kept so 0005 databases stay valid. */
  notifyAttempts: integer("notify_attempts").notNull().default(0),
  /** Superseded by approval_notify_deliveries (migration 0006); no longer written. */
  notifyAttemptAt: text("notify_attempt_at"),
});

/** LEGACY (push-notification outbox, removed): the table stays in the database, nothing reads or writes it any more. */
export const approvalNotifyDeliveries = sqliteTable(
  "approval_notify_deliveries",
  {
    approvalId: text("approval_id").notNull(),
    channel: text("channel").notNull(),
    kind: text("kind").notNull().default("approval"),
    attempts: integer("attempts").notNull().default(0),
    attemptAt: text("attempt_at"),
    deliveredAt: text("delivered_at"),
    skipped: text("skipped"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.approvalId, t.channel] })]
);

/** LEGACY (push-notification channel settings, removed): the table stays in the database, nothing reads or writes it any more. */
export const notifySettings = sqliteTable("notify_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
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

/** One row per wallet address the server has managed (id = lower-case 0x address). */
export const walletMeta = sqliteTable("wallet_meta", {
  id: text("id").primaryKey(),
  address: text("address"),
  createdAt: text("created_at").notNull(),
  /** Set when the operator proved they hold the recovery phrase (two-word check), or imported the wallet. NULL = not confirmed. */
  backupConfirmedAt: text("backup_confirmed_at"),
  /** "generated" (created by the server) | "imported" (recovery phrase, private key or keystore). */
  origin: text("origin"),
});

/**
 * A wallet that was replaced. Its key files were moved into <dataDir>/retired/
 * (names recorded here, never absolute paths) and are never deleted.
 */
export const walletRetirements = sqliteTable("wallet_retirements", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  retiredAt: text("retired_at").notNull(),
  reason: text("reason").notNull(),
  keystoreFile: text("keystore_file").notNull(),
  secretFile: text("secret_file"),
  replacedBy: text("replaced_by"),
});

/** LEGACY (v0.5 seller toll booths, removed): the tables stay in the database, nothing reads or writes them any more. */
export const tollbooths = sqliteTable("tollbooths", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  upstreamUrl: text("upstream_url").notNull(),
  payTo: text("pay_to").notNull(),
  network: text("network").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  forwardHostHeader: integer("forward_host_header", { mode: "boolean" }).notNull().default(false),
  /** micro-USDC for unmatched requests; null = refuse them. */
  defaultPrice: integer("default_price"),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tollboothRoutes = sqliteTable("tollbooth_routes", {
  id: text("id").primaryKey(),
  tollboothId: text("tollbooth_id").notNull(),
  method: text("method").notNull(),
  pathPattern: text("path_pattern").notNull(),
  price: integer("price").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
});

export const earnings = sqliteTable("earnings", {
  id: text("id").primaryKey(),
  tollboothId: text("tollbooth_id").notNull(),
  tollboothSlug: text("tollbooth_slug").notNull(),
  tollboothName: text("tollbooth_name").notNull(),
  routeId: text("route_id"),
  method: text("method").notNull(),
  path: text("path").notNull(),
  amount: integer("amount").notNull(),
  payer: text("payer"),
  txHash: text("tx_hash"),
  network: text("network").notNull(),
  status: text("status", { enum: ["settled", "failed"] }).notNull(),
  upstreamStatus: integer("upstream_status"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
});
