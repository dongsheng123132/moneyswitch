import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createMoneyKey, authenticateMoneyKey, revokeMoneyKey, getMoneyKeyById } from "../src/keys.js";
import { parseUsdcToMicros as usdc, formatMicrosToUsdc } from "../src/money.js";
import { evaluateAndReserve, evaluateAndReserveInTransaction, ApprovalRequiredError } from "../src/policy.js";
import { decideApproval, getApproval } from "../src/approval.js";
import { usedToday, usedTotal, ownUsedToday } from "../src/ledger.js";
import { settlePayment, failPayment } from "../src/payments.js";
import { checkRateLimit, checkHostAllowedForChain } from "../src/gate.js";
import { getKeyChain, effectiveStatus } from "../src/chain.js";
import {
  createChildKey,
  createChildKeyInTransaction,
  DelegationError,
  revokeDescendantKey,
  isStrictDescendant,
  listChildKeys,
  buildKeyTree,
  effectiveRemaining,
  parseMaxKeyDepth,
  type CreateChildKeyInput,
} from "../src/delegation.js";
import { MoneySwitchError } from "../src/types.js";
import type { MoneySwitchDb } from "@moneyswitch/db";
import type { MoneyKeyRow } from "../src/types.js";

const OPTS = { maxDepth: 3 };
const HOST = "example.com:443";

function root(db: MoneySwitchDb, over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
  return createMoneyKey(db, {
    name: "root",
    totalBudget: usdc("10"),
    dailyBudget: usdc("1"),
    perRequestLimit: usdc("0.5"),
    allowedHosts: [HOST],
    maxPaymentsPerMinute: 100,
    canDelegate: true,
    ...over,
  });
}

function childInput(over: Partial<CreateChildKeyInput> = {}): CreateChildKeyInput {
  return {
    name: "child",
    dailyBudget: usdc("1"),
    totalBudget: usdc("10"),
    perRequestLimit: usdc("0.5"),
    ...over,
  };
}

function child(db: MoneySwitchDb, parentId: string, over: Partial<CreateChildKeyInput> = {}) {
  return createChildKey(db, parentId, childInput(over), OPTS);
}

function pay(amount: string, over: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/deep-report",
    host: HOST,
    method: "GET",
    body: undefined,
    network: "eip155:10143",
    asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    payTo: "0xabc",
    amount: usdc(amount),
    ...over,
  };
}

function delegationErr(fn: () => unknown): DelegationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DelegationError);
    return e as DelegationError;
  }
  throw new Error("expected a DelegationError");
}

function msErr(fn: () => unknown): MoneySwitchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MoneySwitchError);
    return e as MoneySwitchError;
  }
  throw new Error("expected a MoneySwitchError");
}

function keyCount(db: MoneySwitchDb): number {
  return db.select().from(schema.moneyKeys).all().length;
}

describe("v0.4 child keys — creation constraints", () => {
  it("creates a child: parent_id, depth, created_by, can_delegate default false, plaintext key usable", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    const { plaintextKey, row: c } = child(db, p.id);
    expect(plaintextKey.startsWith("mk_live_")).toBe(true);
    expect(c.parentId).toBe(p.id);
    expect(c.depth).toBe(1);
    expect(c.createdBy).toBe(`key:${p.id}`);
    expect(c.canDelegate).toBe(false);
    expect(authenticateMoneyKey(db, plaintextKey).id).toBe(c.id);
  });

  it("admin-created keys are roots: depth 0, parent null, created_by admin, can_delegate as given", () => {
    const { db } = freshDb();
    const { row: a } = root(db, { canDelegate: false });
    const { row: b } = root(db);
    expect([a.depth, a.parentId, a.createdBy, a.canDelegate]).toEqual([0, null, "admin", false]);
    expect(b.canDelegate).toBe(true);
    const { row: dflt } = createMoneyKey(db, {
      name: "d",
      totalBudget: usdc("1"),
      dailyBudget: usdc("1"),
      perRequestLimit: usdc("1"),
      allowedHosts: [],
    });
    expect(dflt.canDelegate).toBe(false);
  });

  it("parent without can_delegate -> DELEGATION_NOT_ALLOWED (403), nothing inserted", () => {
    const { db } = freshDb();
    const { row: p } = root(db, { canDelegate: false });
    const e = delegationErr(() => child(db, p.id));
    expect(e.code).toBe("DELEGATION_NOT_ALLOWED");
    expect(e.httpStatus).toBe(403);
    expect(keyCount(db)).toBe(1);
  });

  it("revoked parent -> KEY_REVOKED (self); expired parent -> KEY_EXPIRED", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    revokeMoneyKey(db, p.id);
    const e1 = msErr(() => child(db, p.id));
    expect(e1.code).toBe("KEY_REVOKED");
    expect(e1.limit?.scope).toBe("self");

    const { row: p2 } = root(db, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(msErr(() => child(db, p2.id)).code).toBe("KEY_EXPIRED");
  });

  it("parent whose ancestor is revoked cannot create children (KEY_REVOKED, scope ancestor)", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id, { canDelegate: true });
    revokeMoneyKey(db, r.id);
    const e = msErr(() => child(db, c.id));
    expect(e.code).toBe("KEY_REVOKED");
    expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
  });

  it.each([
    ["per_request_limit", { perRequestLimit: usdc("0.500001") }, "0.5"],
    ["daily_budget", { dailyBudget: usdc("1.01") }, "1"],
    ["total_budget", { totalBudget: usdc("10.000001") }, "10"],
  ] as const)("%s above parent -> CHILD_EXCEEDS_PARENT naming the field", (field, over, parentVal) => {
    const { db } = freshDb();
    const { row: p } = root(db);
    const e = delegationErr(() => child(db, p.id, over));
    expect(e.code).toBe("CHILD_EXCEEDS_PARENT");
    expect(e.httpStatus).toBe(400);
    expect(e.field).toBe(field);
    expect(formatMicrosToUsdc(e.parentValue as bigint)).toBe(parentVal);
    expect(keyCount(db)).toBe(1);
  });

  it("limits exactly equal to the parent's are allowed", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    const { row: c } = child(db, p.id, {
      perRequestLimit: p.perRequestLimit,
      dailyBudget: p.dailyBudget,
      totalBudget: p.totalBudget,
    });
    expect(c.dailyBudget).toBe(p.dailyBudget);
  });

  it("approval_threshold: > parent's -> CHILD_EXCEEDS_PARENT; <= parent's or omitted (inherit) ok", () => {
    const { db } = freshDb();
    const { row: p } = root(db, { approvalThreshold: usdc("0.10") });
    const e = delegationErr(() => child(db, p.id, { approvalThreshold: usdc("0.11") }));
    expect(e.code).toBe("CHILD_EXCEEDS_PARENT");
    expect(e.field).toBe("approval_threshold");
    expect(child(db, p.id, { approvalThreshold: usdc("0.10") }).row.approvalThreshold).toBe(usdc("0.10"));
    expect(child(db, p.id, { approvalThreshold: usdc("0.05") }).row.approvalThreshold).toBe(usdc("0.05"));
    expect(child(db, p.id, {}).row.approvalThreshold).toBeNull();
  });

  it("approval_threshold is checked against the strictest ancestor threshold, not only the direct parent", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { approvalThreshold: usdc("0.10") });
    const { row: mid } = child(db, r.id, { canDelegate: true }); // no own threshold
    const e = delegationErr(() => child(db, mid.id, { approvalThreshold: usdc("0.20") }));
    expect(e.field).toBe("approval_threshold");
  });

  it("parent without a threshold: child may set any threshold <= its own per_request_limit", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    expect(child(db, p.id, { approvalThreshold: usdc("0.3") }).row.approvalThreshold).toBe(usdc("0.3"));
    const e = delegationErr(() => child(db, p.id, { perRequestLimit: usdc("0.2"), approvalThreshold: usdc("0.3") }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.field).toBe("approval_threshold");
  });

  it("allowed_hosts must be a subset of the parent's; omitted inherits the parent's", () => {
    const { db } = freshDb();
    const { row: p } = root(db, { allowedHosts: ["example.com:443", "api.test"] });
    const e = delegationErr(() => child(db, p.id, { allowedHosts: ["example.com:443", "evil.com:443"] }));
    expect(e.code).toBe("CHILD_EXCEEDS_PARENT");
    expect(e.field).toBe("allowed_hosts");
    expect(e.message).toContain("evil.com:443");
    // host:port under a bare-host parent entry is covered; port changes under host:port are not.
    expect(child(db, p.id, { allowedHosts: ["API.test:8443"] }).row.allowedHosts).toEqual(["API.test:8443"]);
    expect(delegationErr(() => child(db, p.id, { allowedHosts: ["example.com:8443"] })).field).toBe("allowed_hosts");
    expect(delegationErr(() => child(db, p.id, { allowedHosts: ["example.com"] })).field).toBe("allowed_hosts");
    expect(child(db, p.id, { allowedHosts: [] }).row.allowedHosts).toEqual([]);
    expect(child(db, p.id, {}).row.allowedHosts).toEqual(["example.com:443", "api.test"]);
  });

  it("expires_at: later than parent's -> CHILD_EXCEEDS_PARENT; omitted inherits; invalid -> INVALID_REQUEST", () => {
    const { db } = freshDb();
    const parentExp = new Date(Date.now() + 86_400_000).toISOString();
    const { row: p } = root(db, { expiresAt: parentExp });
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const e = delegationErr(() => child(db, p.id, { expiresAt: later }));
    expect(e.code).toBe("CHILD_EXCEEDS_PARENT");
    expect(e.field).toBe("expires_at");
    expect(child(db, p.id, {}).row.expiresAt).toBe(parentExp);
    const sooner = new Date(Date.now() + 3_600_000).toISOString();
    expect(child(db, p.id, { expiresAt: sooner }).row.expiresAt).toBe(sooner);
    expect(delegationErr(() => child(db, p.id, { expiresAt: "tomorrow" })).code).toBe("INVALID_REQUEST");

    const { row: noExp } = root(db);
    expect(child(db, noExp.id, { expiresAt: later }).row.expiresAt).toBe(later);
  });

  it("max_payments_per_minute: above parent's -> CHILD_EXCEEDS_PARENT; omitted = parent's", () => {
    const { db } = freshDb();
    const { row: p } = root(db, { maxPaymentsPerMinute: 20 });
    expect(delegationErr(() => child(db, p.id, { maxPaymentsPerMinute: 21 })).field).toBe("max_payments_per_minute");
    expect(child(db, p.id, {}).row.maxPaymentsPerMinute).toBe(20);
    expect(child(db, p.id, { maxPaymentsPerMinute: 5 }).row.maxPaymentsPerMinute).toBe(5);
    expect(delegationErr(() => child(db, p.id, { maxPaymentsPerMinute: 0 })).code).toBe("INVALID_REQUEST");
  });

  it("empty name -> INVALID_REQUEST", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    expect(delegationErr(() => child(db, p.id, { name: "  " })).field).toBe("name");
  });

  it("can_delegate on a child is honoured only when the parent can delegate (grandchild creation)", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: noDel } = child(db, r.id);
    expect(delegationErr(() => child(db, noDel.id)).code).toBe("DELEGATION_NOT_ALLOWED");
    const { row: del } = child(db, r.id, { canDelegate: true });
    expect(child(db, del.id).row.depth).toBe(2);
  });

  it("depth limit: root(0) -> 1 -> 2 -> 3; depth-3 key cannot create; can_delegate at max depth rejected", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: d1 } = child(db, r.id, { canDelegate: true });
    const { row: d2 } = child(db, d1.id, { canDelegate: true });
    const e = delegationErr(() => child(db, d2.id, { canDelegate: true }));
    expect(e.code).toBe("MAX_DEPTH_EXCEEDED");
    expect(e.field).toBe("can_delegate");
    const { row: d3 } = child(db, d2.id);
    expect(d3.depth).toBe(3);
    // Force can_delegate on the depth-3 row (as if created under a larger limit): depth still blocks it.
    db.update(schema.moneyKeys).set({ canDelegate: true }).where(eq(schema.moneyKeys.id, d3.id)).run();
    expect(delegationErr(() => child(db, d3.id)).code).toBe("MAX_DEPTH_EXCEEDED");
  });

  it("custom max depth (MONEYSWITCH_MAX_KEY_DEPTH=1) and env parsing", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: d1 } = createChildKey(db, r.id, childInput({}), { maxDepth: 1 });
    db.update(schema.moneyKeys).set({ canDelegate: true }).where(eq(schema.moneyKeys.id, d1.id)).run();
    expect(delegationErr(() => createChildKey(db, d1.id, childInput(), { maxDepth: 1 })).code).toBe("MAX_DEPTH_EXCEEDED");
    expect(delegationErr(() => createChildKey(db, r.id, childInput(), { maxDepth: 0 })).code).toBe("MAX_DEPTH_EXCEEDED");
    expect(parseMaxKeyDepth(undefined)).toBe(3);
    expect(parseMaxKeyDepth("")).toBe(3);
    expect(parseMaxKeyDepth("abc")).toBe(3);
    expect(parseMaxKeyDepth("-1")).toBe(3);
    expect(parseMaxKeyDepth("2")).toBe(2);
    expect(parseMaxKeyDepth("0")).toBe(0);
    expect(parseMaxKeyDepth("999")).toBe(10);
  });

  it("children-per-key cap -> CHILDREN_LIMIT_REACHED", () => {
    const { db } = freshDb();
    const { row: p } = root(db);
    createChildKey(db, p.id, childInput(), { maxDepth: 3, maxChildrenPerKey: 2 });
    createChildKey(db, p.id, childInput(), { maxDepth: 3, maxChildrenPerKey: 2 });
    expect(
      delegationErr(() => createChildKey(db, p.id, childInput(), { maxDepth: 3, maxChildrenPerKey: 2 })).code
    ).toBe("CHILDREN_LIMIT_REACHED");
  });

  it("createChildKeyInTransaction rolls back on rejection and commits on success", () => {
    const { db, sqlite } = freshDb();
    const { row: p } = root(db);
    expect(() =>
      createChildKeyInTransaction(sqlite, db, p.id, childInput({ dailyBudget: usdc("5") }), OPTS)
    ).toThrow(DelegationError);
    expect(sqlite.inTransaction).toBe(false);
    expect(keyCount(db)).toBe(1);
    createChildKeyInTransaction(sqlite, db, p.id, childInput(), OPTS);
    expect(sqlite.inTransaction).toBe(false);
    expect(keyCount(db)).toBe(2);
  });
});

describe("v0.4 child keys — policy walks the ancestor chain", () => {
  it("child payment counts toward the parent's and root's used (subtree), own used stays per key", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c1 } = child(db, r.id, { canDelegate: true });
    const { row: c2 } = child(db, c1.id);
    const res = evaluateAndReserve(db, c2, pay("0.15"));
    settlePayment(db, res.paymentId, "0xmock1");
    evaluateAndReserve(db, r, pay("0.05"));
    expect(usedToday(db, c2.id)).toBe(usdc("0.15"));
    expect(usedToday(db, c1.id)).toBe(usdc("0.15"));
    expect(usedToday(db, r.id)).toBe(usdc("0.2"));
    expect(usedTotal(db, r.id)).toBe(usdc("0.2"));
    expect(ownUsedToday(db, r.id)).toBe(usdc("0.05"));
    // failed payments release the reservation for every level
    const res2 = evaluateAndReserve(db, c2, pay("0.1"));
    failPayment(db, res2.paymentId, "PAYMENT_FAILED");
    expect(usedToday(db, r.id)).toBe(usdc("0.2"));
  });

  it("ancestor daily budget binds the child -> DAILY_BUDGET_EXCEEDED, scope ancestor + prefix", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { dailyBudget: usdc("1") });
    const { row: a } = child(db, r.id, { dailyBudget: usdc("1") });
    const { row: b } = child(db, r.id, { dailyBudget: usdc("1") });
    for (let i = 0; i < 6; i++) evaluateAndReserve(db, a, pay("0.15")); // 0.90 by sibling
    const e = msErr(() => evaluateAndReserve(db, b, pay("0.15")));
    expect(e.code).toBe("DAILY_BUDGET_EXCEEDED");
    expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
    // b's own daily is untouched and it can still spend what the root has left
    evaluateAndReserve(db, b, pay("0.1"));
    expect(usedToday(db, r.id)).toBe(usdc("1"));
  });

  it("own daily budget -> DAILY_BUDGET_EXCEEDED with scope self", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id, { dailyBudget: usdc("0.2") });
    evaluateAndReserve(db, c, pay("0.15"));
    const e = msErr(() => evaluateAndReserve(db, c, pay("0.15")));
    expect(e.code).toBe("DAILY_BUDGET_EXCEEDED");
    expect(e.limit).toEqual({ scope: "self", keyPrefix: c.keyPrefix });
  });

  it("ancestor total budget binds -> TOTAL_BUDGET_EXCEEDED scope ancestor (grandparent)", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { totalBudget: usdc("0.3"), dailyBudget: usdc("1") });
    const { row: c1 } = child(db, r.id, { canDelegate: true, totalBudget: usdc("0.3"), dailyBudget: usdc("1") });
    const { row: c2 } = child(db, c1.id, { totalBudget: usdc("0.3"), dailyBudget: usdc("1") });
    evaluateAndReserve(db, r, pay("0.2")); // root's own spend
    const e = msErr(() => evaluateAndReserve(db, c2, pay("0.15")));
    expect(e.code).toBe("TOTAL_BUDGET_EXCEEDED");
    expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
  });

  it("ancestor per_request limit is enforced at payment time even if lowered after the child was created", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    db.update(schema.moneyKeys).set({ perRequestLimit: 100_000 }).where(eq(schema.moneyKeys.id, r.id)).run();
    const e = msErr(() => evaluateAndReserve(db, c, pay("0.15")));
    expect(e.code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
    expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
  });

  it("ancestor daily budget lowered after creation is enforced (defense in depth)", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    db.update(schema.moneyKeys).set({ dailyBudget: 100_000 }).where(eq(schema.moneyKeys.id, r.id)).run();
    expect(msErr(() => evaluateAndReserve(db, c, pay("0.15"))).code).toBe("DAILY_BUDGET_EXCEEDED");
  });

  it("parent's own payments count against its budget together with its children", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { dailyBudget: usdc("0.3") });
    const { row: c } = child(db, r.id, { dailyBudget: usdc("0.3") });
    evaluateAndReserve(db, c, pay("0.2"));
    const e = msErr(() => evaluateAndReserve(db, r, pay("0.15")));
    expect(e.code).toBe("DAILY_BUDGET_EXCEEDED");
    expect(e.limit?.scope).toBe("self");
  });

  it("ancestor approval_threshold triggers approval for a child without its own threshold; approve + retry works", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { approvalThreshold: usdc("0.10") });
    const { row: c } = child(db, r.id);
    let approvalId = "";
    try {
      evaluateAndReserve(db, c, pay("0.15"));
      throw new Error("should require approval");
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalRequiredError);
      approvalId = (e as ApprovalRequiredError).approvalId;
    }
    expect(getApproval(db, approvalId)!.keyId).toBe(c.id);
    decideApproval(db, approvalId, "approved");
    expect(evaluateAndReserve(db, c, { ...pay("0.15"), approvalId }).approvalId).toBe(approvalId);
    // below every threshold: no approval
    expect(evaluateAndReserve(db, c, pay("0.05")).approvalId).toBeNull();
  });

  it("child's own (lower) threshold also triggers approval", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { approvalThreshold: usdc("0.40") });
    const { row: c } = child(db, r.id, { approvalThreshold: usdc("0.05") });
    expect(() => evaluateAndReserve(db, c, pay("0.06"))).toThrow(ApprovalRequiredError);
  });

  it("revoking the root cascades: child and grandchild -> KEY_REVOKED scope ancestor (policy + auth), rows untouched", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const c1 = child(db, r.id, { canDelegate: true });
    const c2 = child(db, c1.row.id);
    revokeMoneyKey(db, r.id);
    for (const k of [c1, c2]) {
      const e = msErr(() => evaluateAndReserve(db, k.row, pay("0.01")));
      expect(e.code).toBe("KEY_REVOKED");
      expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
      const a = msErr(() => authenticateMoneyKey(db, k.plaintextKey));
      expect(a.code).toBe("KEY_REVOKED");
      expect(a.limit?.scope).toBe("ancestor");
      expect(getMoneyKeyById(db, k.row.id)!.enabled).toBe(true); // query-time cascade, no batch update
    }
    expect(db.select().from(schema.payments).all().length).toBe(0);
  });

  it("revoking a middle key cascades only to its subtree", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: mid } = child(db, r.id, { canDelegate: true });
    const { row: leaf } = child(db, mid.id);
    const { row: sibling } = child(db, r.id);
    revokeMoneyKey(db, mid.id);
    expect(msErr(() => evaluateAndReserve(db, leaf, pay("0.01"))).limit).toEqual({
      scope: "ancestor",
      keyPrefix: mid.keyPrefix,
    });
    expect(msErr(() => evaluateAndReserve(db, mid, pay("0.01"))).limit?.scope).toBe("self");
    expect(evaluateAndReserve(db, sibling, pay("0.01")).paymentId).toBeTruthy();
    expect(evaluateAndReserve(db, r, pay("0.01")).paymentId).toBeTruthy();
  });

  it("ancestor expiry cascades -> KEY_EXPIRED scope ancestor", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    db.update(schema.moneyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.moneyKeys.id, r.id))
      .run();
    const e = msErr(() => evaluateAndReserve(db, c, pay("0.01")));
    expect(e.code).toBe("KEY_EXPIRED");
    expect(e.limit?.scope).toBe("ancestor");
  });

  it("ancestor revoked between auth and signing (TOCTOU) -> rolled back, no reservation", () => {
    const { db, sqlite } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    const snapshot = { ...c };
    revokeMoneyKey(db, r.id);
    const e = msErr(() => evaluateAndReserveInTransaction(sqlite, db, snapshot, pay("0.01")));
    expect(e.code).toBe("KEY_REVOKED");
    expect(sqlite.inTransaction).toBe(false);
    expect(db.select().from(schema.payments).all().length).toBe(0);
  });

  it("a forged/stale snapshot with a higher budget cannot bypass the fresh chain read", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { dailyBudget: usdc("0.1") });
    const { row: c } = child(db, r.id, { dailyBudget: usdc("0.1") });
    const forged: MoneyKeyRow = { ...c, parentId: null, dailyBudget: usdc("100"), perRequestLimit: usdc("100") };
    const e = msErr(() => evaluateAndReserve(db, forged, pay("0.15")));
    expect(e.code).toBe("DAILY_BUDGET_EXCEEDED");
  });

  it("rate limit is enforced per subtree along the chain (RATE_LIMITED scope ancestor)", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { maxPaymentsPerMinute: 3 });
    const { row: a } = child(db, r.id);
    const { row: b } = child(db, r.id);
    evaluateAndReserve(db, a, pay("0.01"));
    evaluateAndReserve(db, a, pay("0.01"));
    evaluateAndReserve(db, b, pay("0.01"));
    const e = msErr(() => checkRateLimit(db, b));
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.limit).toEqual({ scope: "ancestor", keyPrefix: r.keyPrefix });
  });

  it("host allow-list is checked along the chain", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { allowedHosts: ["example.com:443"] });
    const { row: c } = child(db, r.id);
    checkHostAllowedForChain(db, new URL("https://example.com/x"), c);
    // Corrupt the child's list to include a host the root never allowed.
    db.update(schema.moneyKeys).set({ allowedHosts: ["example.com:443", "evil.com:443"] }).where(eq(schema.moneyKeys.id, c.id)).run();
    const fresh = getMoneyKeyById(db, c.id)!;
    const e = msErr(() => checkHostAllowedForChain(db, new URL("https://evil.com/x"), fresh));
    expect(e.code).toBe("HOST_NOT_ALLOWED");
    expect(e.limit?.scope).toBe("ancestor");
  });

  it("effectiveRemaining = min over the chain, floored at 0, with the binding scope", () => {
    const { db } = freshDb();
    const { row: r } = root(db, { dailyBudget: usdc("1") });
    const { row: a } = child(db, r.id, { dailyBudget: usdc("0.5") });
    const { row: b } = child(db, r.id, { dailyBudget: usdc("1") });
    for (let i = 0; i < 3; i++) evaluateAndReserve(db, a, pay("0.15")); // 0.45
    let eff = effectiveRemaining(db, getKeyChain(db, b.id));
    expect(eff.today).toBe(usdc("0.55"));
    expect(eff.todayScope).toBe("ancestor");
    eff = effectiveRemaining(db, getKeyChain(db, a.id));
    expect(eff.today).toBe(usdc("0.05"));
    expect(eff.todayScope).toBe("self");
  });

  it("corrupted parent graph (cycle) fails closed", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    db.update(schema.moneyKeys).set({ parentId: c.id }).where(eq(schema.moneyKeys.id, r.id)).run();
    expect(msErr(() => evaluateAndReserve(db, c, pay("0.01"))).code).toBe("KEY_REVOKED");
  });
});

describe("v0.4 child keys — subtree revoke, listing, tree", () => {
  it("revokeDescendantKey only works inside the caller's subtree", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c1 } = child(db, r.id, { canDelegate: true });
    const { row: g } = child(db, c1.id);
    const { row: sib } = child(db, r.id);
    const { row: other } = root(db);

    expect(revokeDescendantKey(db, c1.id, sib.id)).toBeNull(); // sibling
    expect(revokeDescendantKey(db, c1.id, r.id)).toBeNull(); // own parent
    expect(revokeDescendantKey(db, c1.id, c1.id)).toBeNull(); // itself
    expect(revokeDescendantKey(db, c1.id, other.id)).toBeNull(); // other tree
    expect(revokeDescendantKey(db, g.id, c1.id)).toBeNull(); // child -> parent
    expect(revokeDescendantKey(db, c1.id, "does-not-exist")).toBeNull();
    for (const id of [sib.id, r.id, c1.id, other.id]) expect(getMoneyKeyById(db, id)!.enabled).toBe(true);

    expect(revokeDescendantKey(db, r.id, g.id)!.enabled).toBe(false); // grandchild via root
    expect(revokeDescendantKey(db, c1.id, g.id)!.enabled).toBe(false); // idempotent
    expect(revokeDescendantKey(db, r.id, sib.id)!.enabled).toBe(false);
    expect(isStrictDescendant(db, r.id, g.id)).toBe(true);
    expect(isStrictDescendant(db, g.id, r.id)).toBe(false);
  });

  it("listChildKeys returns direct children only; buildKeyTree nests the forest", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c1 } = child(db, r.id, { canDelegate: true, name: "c1" });
    child(db, c1.id, { name: "g" });
    child(db, r.id, { name: "c2" });
    root(db, { name: "r2" });
    expect(listChildKeys(db, r.id).map((k) => k.name)).toEqual(["c1", "c2"]);
    const tree = buildKeyTree(db);
    expect(tree.map((n) => n.key.name)).toEqual(["root", "r2"]);
    expect(tree[0].children.map((n) => n.key.name)).toEqual(["c1", "c2"]);
    expect(tree[0].children[0].children.map((n) => n.key.name)).toEqual(["g"]);
  });

  it("effectiveStatus reports ancestor revocation", () => {
    const { db } = freshDb();
    const { row: r } = root(db);
    const { row: c } = child(db, r.id);
    expect(effectiveStatus(getKeyChain(db, c.id))).toBe("active");
    revokeMoneyKey(db, r.id);
    expect(effectiveStatus(getKeyChain(db, c.id))).toBe("ancestor_revoked");
    expect(effectiveStatus(getKeyChain(db, r.id))).toBe("revoked");
  });
});

describe("v0.4 concurrency: whole-tree budget under simultaneous reservations", () => {
  it("parent daily=1.00, two children daily=1.00, 5 x 0.15 each concurrently -> exactly 6 succeed tree-wide", async () => {
    const { db, sqlite } = freshDb();
    const { row: r } = root(db, { dailyBudget: usdc("1.00"), perRequestLimit: usdc("1") });
    const { row: a } = child(db, r.id, { dailyBudget: usdc("1.00"), perRequestLimit: usdc("1") });
    const { row: b } = child(db, r.id, { dailyBudget: usdc("1.00"), perRequestLimit: usdc("1") });
    const attempts = [a, b].flatMap((k) =>
      Array.from({ length: 5 }, () =>
        Promise.resolve().then(() => {
          try {
            evaluateAndReserveInTransaction(sqlite, db, k, pay("0.15"));
            return "ok";
          } catch (e) {
            return (e as MoneySwitchError).code;
          }
        })
      )
    );
    const results = await Promise.all(attempts);
    expect(results.filter((x) => x === "ok").length).toBe(6);
    expect(results.filter((x) => x === "DAILY_BUDGET_EXCEEDED").length).toBe(4);
    expect(usedToday(db, r.id)).toBe(usdc("0.90"));
  });
});
