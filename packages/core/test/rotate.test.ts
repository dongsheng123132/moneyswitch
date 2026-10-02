import { describe, it, expect } from "vitest";
import { schema } from "@moneyswitch/db";
import { eq } from "drizzle-orm";
import { freshDb } from "./helpers.js";
import { createMoneyKey, authenticateMoneyKey, revokeMoneyKey, getMoneyKeyById } from "../src/keys.js";
import { rotateMoneyKeySecret } from "../src/rotate.js";
import { createChildKey } from "../src/delegation.js";
import { MoneySwitchError } from "../src/types.js";
import { parseUsdcToMicros } from "../src/money.js";
import { sha256Hex } from "../src/moneykey.js";

function mk(db: ReturnType<typeof freshDb>["db"], over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
  return createMoneyKey(db, {
    name: "codex",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("2"),
    perRequestLimit: parseUsdcToMicros("1"),
    approvalThreshold: parseUsdcToMicros("0.5"),
    allowedHosts: ["example.com:443"],
    canDelegate: true,
    ...over,
  });
}

describe("rotateMoneyKeySecret", () => {
  it("swaps prefix and hash; the old secret stops authenticating, the new one authenticates", () => {
    const { db } = freshDb();
    const { plaintextKey: oldKey, row } = mk(db);
    const res = rotateMoneyKeySecret(db, row.id)!;
    expect(res.plaintextKey).not.toBe(oldKey);
    expect(res.plaintextKey.startsWith("mk_live_")).toBe(true);
    expect(res.row.keyHash).toBe(sha256Hex(res.plaintextKey));
    expect(res.row.keyPrefix).toBe(res.plaintextKey.slice(0, 12));
    expect(res.previousPrefix).toBe(row.keyPrefix);
    expect(() => authenticateMoneyKey(db, oldKey)).toThrowError(/KEY_INVALID/);
    expect(authenticateMoneyKey(db, res.plaintextKey).id).toBe(row.id);
  });

  it("changes nothing but key_prefix and key_hash", () => {
    const { db } = freshDb();
    const { row } = mk(db, { expiresAt: "2099-01-01T00:00:00.000Z", allowedModels: ["m1"], maxPaymentsPerMinute: 7 });
    const res = rotateMoneyKeySecret(db, row.id)!;
    const { keyPrefix: _p1, keyHash: _h1, ...before } = row;
    const { keyPrefix: _p2, keyHash: _h2, ...after } = res.row;
    expect(after).toEqual(before);
  });

  it("keeps child keys attached and working, and payments/approvals rows untouched", () => {
    const { db } = freshDb();
    const { row: parent } = mk(db);
    const kid = createChildKey(
      db,
      parent.id,
      { name: "kid", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") },
      { maxDepth: 3 }
    );
    const now = new Date().toISOString();
    db.insert(schema.payments)
      .values({ id: "p1", keyId: parent.id, url: "https://example.com/x", host: "example.com:443", method: "GET", network: "n", asset: "a", payTo: "t", amount: 1000, status: "settled", txHash: "0x1", errorCode: null, approvalId: null, createdAt: now, updatedAt: now, kind: "fetch" })
      .run();
    rotateMoneyKeySecret(db, parent.id);
    expect(authenticateMoneyKey(db, kid.plaintextKey).parentId).toBe(parent.id);
    expect(db.select().from(schema.payments).where(eq(schema.payments.keyId, parent.id)).all()).toHaveLength(1);
  });

  it("unknown id -> undefined", () => {
    const { db } = freshDb();
    expect(rotateMoneyKeySecret(db, "nope")).toBeUndefined();
  });

  it("a revoked key cannot be rotated (KEY_REVOKED) and stays revoked with its old hash", () => {
    const { db } = freshDb();
    const { plaintextKey, row } = mk(db);
    revokeMoneyKey(db, row.id);
    let err: unknown;
    try {
      rotateMoneyKeySecret(db, row.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MoneySwitchError);
    expect((err as MoneySwitchError).code).toBe("KEY_REVOKED");
    const after = getMoneyKeyById(db, row.id)!;
    expect(after.enabled).toBe(false);
    expect(after.keyHash).toBe(sha256Hex(plaintextKey));
  });
});
