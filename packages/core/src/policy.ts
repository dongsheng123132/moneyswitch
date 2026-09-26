import { randomUUID } from "node:crypto";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { microsToDbNumber } from "./money.js";
import { sumUsedSubtree, startOfUtcDay } from "./ledger.js";
import { createApproval, validateApprovalForUse, markApprovalUsed } from "./approval.js";
import { getKeyChain, assertChainUsable, scopeAt } from "./chain.js";
import type { MoneyKeyRow, LimitInfo } from "./types.js";
import { MoneySwitchError } from "./types.js";

function limitAt(chain: MoneyKeyRow[], i: number): LimitInfo {
  return { scope: scopeAt(i), keyPrefix: chain[i].keyPrefix };
}

export class ApprovalRequiredError extends MoneySwitchError {
  approvalId: string;
  constructor(approvalId: string) {
    super("APPROVAL_REQUIRED", "Payment requires manual approval");
    this.approvalId = approvalId;
  }
}

export interface PolicyInput {
  url: string;
  host: string;
  method: string;
  body: unknown;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
  maxPrice?: bigint;
  approvalId?: string | null;
  /** v0.2 (SPEC-v0.2 §2 step 7): "fetch" (default) or "chat". */
  kind?: "fetch" | "chat";
  model?: string | null;
}

export interface PolicyResult {
  paymentId: string;
  approvalId: string | null;
}

/**
 * The policy engine gate from SPEC §6 step 5. MUST be called inside a single
 * SQLite transaction (the caller in packages/x402 wraps this in
 * db's synchronous better-sqlite3 transaction so the reservation and every
 * check happen atomically).
 *
 * `keyHint` is only used to locate the key id — the transaction re-reads the
 * MoneyKey row fresh (by id) right after BEGIN, and re-checks
 * enabled/expires_at plus every budget field against that fresh row. This
 * closes a TOCTOU window: the caller authenticates the key once at the top
 * of the request, but signing can happen much later (after a round trip to
 * the upstream 402 resource), during which an admin could have revoked the
 * key or changed its limits.
 */
export function evaluateAndReserve(
  db: MoneySwitchDb,
  keyHint: MoneyKeyRow,
  input: PolicyInput
): PolicyResult {
  const now = new Date();

  // v0.4 (SPEC-v0.4 §A): re-read the key AND its whole ancestor chain fresh,
  // inside the transaction. Every level must be enabled and unexpired
  // (revocation/expiry cascades down at query time), and every level's
  // per-request / daily / total limit must hold, where a level's "used" is
  // the settled+reserved+unknown sum of its entire subtree. The first
  // violated level wins; errors carry limit_scope ("self" | "ancestor") and
  // the violating key's public prefix. For a root key (chain of length 1)
  // this is exactly the pre-v0.4 behaviour.
  const chain = getKeyChain(db, keyHint.id);
  const key = chain[0];
  assertChainUsable(chain, now.getTime());

  chain.forEach((k, i) => {
    if (input.amount > k.perRequestLimit) {
      throw new MoneySwitchError("PER_REQUEST_LIMIT_EXCEEDED", undefined, limitAt(chain, i));
    }
  });
  if (input.maxPrice != null && input.amount > input.maxPrice) {
    throw new MoneySwitchError("MAX_PRICE_EXCEEDED");
  }

  const dayStart = startOfUtcDay(now);
  chain.forEach((k, i) => {
    const usedToday = sumUsedSubtree(db, k.id, dayStart);
    if (usedToday + input.amount > k.dailyBudget) {
      throw new MoneySwitchError("DAILY_BUDGET_EXCEEDED", undefined, limitAt(chain, i));
    }
  });
  chain.forEach((k, i) => {
    const usedTotal = sumUsedSubtree(db, k.id);
    if (usedTotal + input.amount > k.totalBudget) {
      throw new MoneySwitchError("TOTAL_BUDGET_EXCEEDED", undefined, limitAt(chain, i));
    }
  });

  let usedApprovalId: string | null = null;
  // v0.4: the key's own threshold OR any ancestor's triggers approval.
  // Approvals are still decided by the admin (no parent-holder approval in
  // v0.4); the approval row is bound to the paying key.
  const needsApproval = chain.some(
    (k) => k.approvalThreshold != null && input.amount >= k.approvalThreshold
  );

  if (needsApproval) {
    if (input.approvalId) {
      // Throws APPROVAL_INVALID (via MoneySwitchError with that message) if mismatched.
      try {
        validateApprovalForUse(db, input.approvalId, {
          keyId: key.id,
          url: input.url,
          method: input.method,
          body: input.body,
          payTo: input.payTo,
          amount: input.amount,
        });
      } catch {
        throw new MoneySwitchError("APPROVAL_INVALID");
      }
      usedApprovalId = input.approvalId;
    } else {
      const approval = createApproval(db, {
        keyId: key.id,
        url: input.url,
        method: input.method,
        body: input.body,
        network: input.network,
        asset: input.asset,
        payTo: input.payTo,
        amount: input.amount,
      });
      throw new ApprovalRequiredError(approval.id);
    }
  }

  const paymentId = randomUUID();
  const nowIso = now.toISOString();
  // The reservation is recorded against the paying key only; ancestors see
  // it through their subtree sums.
  db.insert(schema.payments)
    .values({
      id: paymentId,
      keyId: key.id,
      url: input.url,
      host: input.host,
      method: input.method,
      network: input.network,
      asset: input.asset,
      payTo: input.payTo,
      amount: microsToDbNumber(input.amount),
      status: "reserved",
      txHash: null,
      errorCode: null,
      approvalId: usedApprovalId,
      createdAt: nowIso,
      updatedAt: nowIso,
      kind: input.kind ?? "fetch",
      model: input.model ?? null,
      promptTokens: null,
      completionTokens: null,
    })
    .run();

  if (usedApprovalId) {
    markApprovalUsed(db, usedApprovalId);
  }

  return { paymentId, approvalId: usedApprovalId };
}

/**
 * Runs `evaluateAndReserve` inside a single explicit SQLite transaction
 * (BEGIN IMMEDIATE / COMMIT / ROLLBACK), per SPEC §6 step 5.
 *
 * A plain `db.transaction()` wrapper would roll back on ANY thrown error —
 * but `ApprovalRequiredError` deliberately writes a `pending` approval row
 * that must survive so a later retry with `approval_id` can find it. So:
 *   - success (no throw)              -> COMMIT, return result
 *   - ApprovalRequiredError thrown    -> COMMIT (keep the approval row), rethrow
 *   - any other MoneySwitchError      -> ROLLBACK (nothing was written), rethrow
 */
export function evaluateAndReserveInTransaction(
  sqlite: { exec(sql: string): unknown },
  db: MoneySwitchDb,
  key: MoneyKeyRow,
  input: PolicyInput
): PolicyResult {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = evaluateAndReserve(db, key, input);
    sqlite.exec("COMMIT");
    return result;
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      sqlite.exec("COMMIT");
      throw e;
    }
    sqlite.exec("ROLLBACK");
    throw e;
  }
}
