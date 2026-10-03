import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { microsToDbNumber } from "./money.js";
import { generateMoneyKey, sha256Hex, keyPrefix12 } from "./moneykey.js";
import { rowToMoneyKey } from "./keyrow.js";
import { getKeyChain, assertChainUsable } from "./chain.js";
import { usedToday, usedTotal } from "./ledger.js";
import { revokeMoneyKey } from "./keys.js";
import type { MoneyKeyRow } from "./types.js";

/**
 * v0.4 (SPEC-v0.4 §A): child MoneyKeys / multi-level delegation.
 *
 * Invariants enforced here at creation time (and re-enforced at payment time
 * by the policy engine walking the ancestor chain, so a child can never spend
 * beyond any ancestor even if these were somehow bypassed):
 *   - parent (and all its ancestors) enabled and unexpired
 *   - parent.can_delegate, parent.depth < maxDepth
 *   - child per_request / daily / total <= parent's
 *   - child allowed_hosts ⊆ parent's
 *   - child expires_at <= parent's effective expiry
 *   - child approval_threshold <= parent's effective threshold (or omitted = inherit)
 *   - child max_payments_per_minute <= parent's
 */

/** Default SPEC value: root + 3 levels of children. */
export const DEFAULT_MAX_KEY_DEPTH = 3;
/** Upper bound for MONEYSWITCH_MAX_KEY_DEPTH (keeps chain walks short). */
export const MAX_KEY_DEPTH_CEILING = 10;
/** Anti-spam cap on direct children per key (revoked ones included). */
export const DEFAULT_MAX_CHILDREN_PER_KEY = 100;

/** Parses MONEYSWITCH_MAX_KEY_DEPTH; anything invalid falls back to the default (3). */
export function parseMaxKeyDepth(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_KEY_DEPTH;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_MAX_KEY_DEPTH;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) return DEFAULT_MAX_KEY_DEPTH;
  return Math.min(n, MAX_KEY_DEPTH_CEILING);
}

export type DelegationErrorCode =
  | "CHILD_EXCEEDS_PARENT"
  | "DELEGATION_NOT_ALLOWED"
  | "MAX_DEPTH_EXCEEDED"
  | "CHILDREN_LIMIT_REACHED"
  | "INVALID_REQUEST";

/** A rejected child-key creation. `field` names the offending request field (snake_case, as on the wire). */
export class DelegationError extends Error {
  code: DelegationErrorCode;
  field: string | null;
  /** Parent's value for the field, in wire format, when that helps the caller (e.g. "1.00", ["a:1"]). */
  parentValue: unknown;
  httpStatus: number;
  constructor(code: DelegationErrorCode, message: string, opts: { field?: string; parentValue?: unknown } = {}) {
    super(`${code}: ${message}`);
    this.name = "DelegationError";
    this.code = code;
    this.field = opts.field ?? null;
    this.parentValue = opts.parentValue;
    this.httpStatus = code === "CHILD_EXCEEDS_PARENT" || code === "INVALID_REQUEST" ? 400 : 403;
  }
}

export interface CreateChildKeyInput {
  name: string;
  dailyBudget: bigint;
  totalBudget: bigint;
  perRequestLimit: bigint;
  /** undefined/null = no own threshold (the parent's thresholds still apply via the chain). */
  approvalThreshold?: bigint | null;
  /** undefined/null = inherit the parent's list. */
  allowedHosts?: string[] | null;
  /** undefined/null = inherit the parent's effective expiry. */
  expiresAt?: string | null;
  canDelegate?: boolean;
  /** undefined = the parent's value. */
  maxPaymentsPerMinute?: number;
}

export interface CreateChildKeyOptions {
  maxDepth: number;
  maxChildrenPerKey?: number;
}

/** Smallest non-null approval threshold along the chain (null = none anywhere). */
export function effectiveApprovalThreshold(chain: MoneyKeyRow[]): bigint | null {
  let min: bigint | null = null;
  for (const k of chain) {
    if (k.approvalThreshold == null) continue;
    if (min == null || k.approvalThreshold < min) min = k.approvalThreshold;
  }
  return min;
}

/** Earliest expiry along the chain (null = never). */
export function effectiveExpiresAt(chain: MoneyKeyRow[]): string | null {
  let earliest: { iso: string; ms: number } | null = null;
  for (const k of chain) {
    if (k.expiresAt == null) continue;
    const ms = new Date(k.expiresAt).getTime();
    if (Number.isNaN(ms)) continue;
    if (earliest == null || ms < earliest.ms) earliest = { iso: k.expiresAt, ms };
  }
  return earliest?.iso ?? null;
}

/** Smallest per-request limit along the chain. */
export function effectivePerRequestLimit(chain: MoneyKeyRow[]): bigint {
  return chain.reduce((min, k) => (k.perRequestLimit < min ? k.perRequestLimit : min), chain[0].perRequestLimit);
}

/**
 * What the key can actually still spend: min over the chain of
 * (budget − subtree used), floored at 0. `bindingScope` says which level is
 * the tightest ("self" when the key's own budget is the limit).
 */
export function effectiveRemaining(
  db: MoneySwitchDb,
  chain: MoneyKeyRow[],
  now: Date = new Date()
): { today: bigint; total: bigint; todayScope: "self" | "ancestor"; totalScope: "self" | "ancestor" } {
  let today: bigint | null = null;
  let total: bigint | null = null;
  let todayScope: "self" | "ancestor" = "self";
  let totalScope: "self" | "ancestor" = "self";
  chain.forEach((k, i) => {
    const t = k.dailyBudget - usedToday(db, k.id, now);
    if (today == null || t < today) {
      today = t;
      todayScope = i === 0 ? "self" : "ancestor";
    }
    const a = k.totalBudget - usedTotal(db, k.id);
    if (total == null || a < total) {
      total = a;
      totalScope = i === 0 ? "self" : "ancestor";
    }
  });
  const floor = (v: bigint | null) => (v == null || v < 0n ? 0n : v);
  return { today: floor(today), total: floor(total), todayScope, totalScope };
}

function normHost(h: string): string {
  return h.trim().toLowerCase();
}

/**
 * Is child allowed_hosts entry `entry` covered by the parent's list? Mirrors
 * checkHostAllowed's matching: a parent entry "host" allows any port of
 * that host, "host:port" allows only that port.
 */
function hostCoveredBy(entry: string, parentHosts: string[]): boolean {
  const e = normHost(entry);
  const parent = parentHosts.map(normHost);
  if (parent.includes(e)) return true;
  const m = /^(.*):(\d+)$/.exec(e);
  if (m && m[1] !== "" && !m[1].endsWith(":") && parent.includes(m[1])) return true;
  return false;
}

function isValidIso(s: string): boolean {
  return !Number.isNaN(new Date(s).getTime());
}

function countDirectChildren(db: MoneySwitchDb, parentId: string): number {
  const row = db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM ${schema.moneyKeys} WHERE ${schema.moneyKeys.parentId} = ${parentId}`
  );
  return row?.n ?? 0;
}

/**
 * Validates and inserts a child key under `parentId`. MUST run inside a
 * transaction (see createChildKeyInTransaction) so the parent state it
 * validates against cannot change before the insert.
 */
export function createChildKey(
  db: MoneySwitchDb,
  parentId: string,
  input: CreateChildKeyInput,
  opts: CreateChildKeyOptions
): { plaintextKey: string; row: MoneyKeyRow } {
  // Fresh read of the parent + its ancestors. Throws KEY_* MoneySwitchError
  // if the parent or any ancestor is revoked/expired.
  const parentChain = getKeyChain(db, parentId);
  const parent = parentChain[0];
  assertChainUsable(parentChain);

  if (!parent.canDelegate) {
    throw new DelegationError("DELEGATION_NOT_ALLOWED", "This MoneyKey is not allowed to create child keys");
  }
  const childDepth = parent.depth + 1;
  if (childDepth > opts.maxDepth) {
    throw new DelegationError(
      "MAX_DEPTH_EXCEEDED",
      `Maximum key depth is ${opts.maxDepth}; this key is already at depth ${parent.depth}`
    );
  }
  const maxChildren = opts.maxChildrenPerKey ?? DEFAULT_MAX_CHILDREN_PER_KEY;
  if (countDirectChildren(db, parent.id) >= maxChildren) {
    throw new DelegationError("CHILDREN_LIMIT_REACHED", `A key can have at most ${maxChildren} child keys`);
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 200) {
    throw new DelegationError("INVALID_REQUEST", "name is required (1-200 characters)", { field: "name" });
  }

  // Money limits: each must be <= the parent's own limit.
  const moneyChecks: Array<[string, bigint, bigint]> = [
    ["per_request_limit", input.perRequestLimit, parent.perRequestLimit],
    ["daily_budget", input.dailyBudget, parent.dailyBudget],
    ["total_budget", input.totalBudget, parent.totalBudget],
  ];
  for (const [field, childVal, parentVal] of moneyChecks) {
    if (childVal < 0n) {
      throw new DelegationError("INVALID_REQUEST", `${field} must be >= 0`, { field });
    }
    if (childVal > parentVal) {
      throw new DelegationError("CHILD_EXCEEDS_PARENT", `${field} exceeds the parent key's ${field}`, {
        field,
        parentValue: parentVal,
      });
    }
  }

  // Approval threshold: <= the parent's effective threshold (the strictest
  // along its chain — anything above it would never matter anyway), and
  // (existing rule) <= the child's own per_request_limit.
  const parentThreshold = effectiveApprovalThreshold(parentChain);
  const childThreshold = input.approvalThreshold ?? null;
  if (childThreshold != null) {
    if (childThreshold < 0n) {
      throw new DelegationError("INVALID_REQUEST", "approval_threshold must be >= 0", { field: "approval_threshold" });
    }
    if (parentThreshold != null && childThreshold > parentThreshold) {
      throw new DelegationError(
        "CHILD_EXCEEDS_PARENT",
        "approval_threshold is higher than the parent key's approval threshold",
        { field: "approval_threshold", parentValue: parentThreshold }
      );
    }
    if (childThreshold > input.perRequestLimit) {
      throw new DelegationError("INVALID_REQUEST", "approval_threshold must be <= per_request_limit", {
        field: "approval_threshold",
      });
    }
  }

  // allowed_hosts ⊆ parent's (null/omitted = inherit).
  let allowedHosts: string[];
  if (input.allowedHosts == null) {
    allowedHosts = [...parent.allowedHosts];
  } else {
    if (!Array.isArray(input.allowedHosts) || input.allowedHosts.some((h) => typeof h !== "string" || h.trim() === "")) {
      throw new DelegationError("INVALID_REQUEST", "allowed_hosts must be an array of non-empty strings", {
        field: "allowed_hosts",
      });
    }
    const outside = input.allowedHosts.filter((h) => !hostCoveredBy(h, parent.allowedHosts));
    if (outside.length > 0) {
      throw new DelegationError(
        "CHILD_EXCEEDS_PARENT",
        `allowed_hosts must be a subset of the parent key's allowed_hosts (not allowed: ${outside.join(", ")})`,
        { field: "allowed_hosts", parentValue: parent.allowedHosts }
      );
    }
    allowedHosts = input.allowedHosts.map((h) => h.trim());
  }

  // expires_at <= parent's effective expiry (null/omitted = inherit it).
  const parentExpiry = effectiveExpiresAt(parentChain);
  let expiresAt: string | null;
  if (input.expiresAt == null) {
    expiresAt = parentExpiry;
  } else {
    if (typeof input.expiresAt !== "string" || !isValidIso(input.expiresAt)) {
      throw new DelegationError("INVALID_REQUEST", "expires_at must be an ISO-8601 date-time", { field: "expires_at" });
    }
    if (parentExpiry != null && new Date(input.expiresAt).getTime() > new Date(parentExpiry).getTime()) {
      throw new DelegationError("CHILD_EXCEEDS_PARENT", "expires_at is later than the parent key's expiry", {
        field: "expires_at",
        parentValue: parentExpiry,
      });
    }
    expiresAt = new Date(input.expiresAt).toISOString();
  }

  // max_payments_per_minute <= parent's (omitted = parent's).
  let maxPerMinute = parent.maxPaymentsPerMinute;
  if (input.maxPaymentsPerMinute !== undefined) {
    const n = input.maxPaymentsPerMinute;
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new DelegationError("INVALID_REQUEST", "max_payments_per_minute must be a positive integer", {
        field: "max_payments_per_minute",
      });
    }
    if (n > parent.maxPaymentsPerMinute) {
      throw new DelegationError(
        "CHILD_EXCEEDS_PARENT",
        "max_payments_per_minute exceeds the parent key's max_payments_per_minute",
        { field: "max_payments_per_minute", parentValue: parent.maxPaymentsPerMinute }
      );
    }
    maxPerMinute = n;
  }

  // can_delegate: only if the parent may delegate (checked above) AND the
  // child would still be allowed to have children of its own.
  const canDelegate = input.canDelegate === true;
  if (canDelegate && childDepth >= opts.maxDepth) {
    throw new DelegationError(
      "MAX_DEPTH_EXCEEDED",
      `A key at depth ${childDepth} cannot delegate (maximum depth ${opts.maxDepth})`,
      { field: "can_delegate" }
    );
  }

  const plaintextKey = generateMoneyKey();
  const id = randomUUID();
  db.insert(schema.moneyKeys)
    .values({
      id,
      name,
      keyPrefix: keyPrefix12(plaintextKey),
      keyHash: sha256Hex(plaintextKey),
      enabled: true,
      totalBudget: microsToDbNumber(input.totalBudget),
      dailyBudget: microsToDbNumber(input.dailyBudget),
      perRequestLimit: microsToDbNumber(input.perRequestLimit),
      approvalThreshold: childThreshold == null ? null : microsToDbNumber(childThreshold),
      allowedHosts,
      maxPaymentsPerMinute: maxPerMinute,
      expiresAt,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      parentId: parent.id,
      depth: childDepth,
      canDelegate,
      createdBy: `key:${parent.id}`,
    })
    .run();
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get();
  if (!row) throw new Error("failed to read back created child key");
  return { plaintextKey, row: rowToMoneyKey(row) };
}

/** createChildKey inside BEGIN IMMEDIATE / COMMIT (ROLLBACK on any error). */
export function createChildKeyInTransaction(
  sqlite: { exec(sql: string): unknown },
  db: MoneySwitchDb,
  parentId: string,
  input: CreateChildKeyInput,
  opts: CreateChildKeyOptions
): { plaintextKey: string; row: MoneyKeyRow } {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = createChildKey(db, parentId, input, opts);
    sqlite.exec("COMMIT");
    return result;
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}

/** Direct children of a key, oldest first. */
export function listChildKeys(db: MoneySwitchDb, parentId: string): MoneyKeyRow[] {
  return db
    .select()
    .from(schema.moneyKeys)
    .where(eq(schema.moneyKeys.parentId, parentId))
    .orderBy(schema.moneyKeys.createdAt)
    .all()
    .map(rowToMoneyKey);
}

/** Number of direct children per key id (keys without children are absent). */
export function childrenCounts(db: MoneySwitchDb): Map<string, number> {
  const rows = db.all<{ parent_id: string; n: number }>(
    sql`SELECT parent_id, COUNT(*) AS n FROM ${schema.moneyKeys} WHERE parent_id IS NOT NULL GROUP BY parent_id`
  );
  return new Map(rows.map((r) => [r.parent_id, r.n]));
}

/** True iff `targetId` is a strict descendant of `ancestorId` (not the key itself). */
export function isStrictDescendant(db: MoneySwitchDb, ancestorId: string, targetId: string): boolean {
  if (ancestorId === targetId) return false;
  let chain: MoneyKeyRow[];
  try {
    chain = getKeyChain(db, targetId);
  } catch {
    return false;
  }
  return chain.slice(1).some((k) => k.id === ancestorId);
}

/**
 * Revokes `targetId` on behalf of key `callerId`, only if the target is in
 * the caller's subtree (strict descendant). Returns the revoked row, or null
 * if the target does not exist or is outside the caller's subtree (the
 * caller cannot tell the two apart). Revocation cascades to the target's
 * own subtree at query time.
 */
export function revokeDescendantKey(db: MoneySwitchDb, callerId: string, targetId: string): MoneyKeyRow | null {
  if (!isStrictDescendant(db, callerId, targetId)) return null;
  revokeMoneyKey(db, targetId);
  const row = db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, targetId)).get();
  return row ? rowToMoneyKey(row) : null;
}

export interface KeyTreeNode {
  key: MoneyKeyRow;
  children: KeyTreeNode[];
}

/** All keys as a forest (roots = keys without a parent), children oldest first. */
export function buildKeyTree(db: MoneySwitchDb): KeyTreeNode[] {
  const rows = db.select().from(schema.moneyKeys).orderBy(schema.moneyKeys.createdAt).all().map(rowToMoneyKey);
  const nodes = new Map<string, KeyTreeNode>(rows.map((k) => [k.id, { key: k, children: [] }]));
  const roots: KeyTreeNode[] = [];
  for (const k of rows) {
    const node = nodes.get(k.id)!;
    const parent = k.parentId ? nodes.get(k.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

