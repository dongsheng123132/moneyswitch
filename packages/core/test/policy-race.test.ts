import { describe, it, expect } from "vitest";
import { schema } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createMoneyKey, revokeMoneyKey, authenticateMoneyKey } from "../src/keys.js";
import { rotateMoneyKeySecret } from "../src/rotate.js";
import { createChildKey } from "../src/delegation.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve, evaluateAndReserveInTransaction } from "../src/policy.js";
import { MoneySwitchError } from "../src/types.js";

function fetchInput(overrides: Partial<Parameters<typeof evaluateAndReserve>[2]> = {}) {
  return {
    url: "https://example.com/premium",
    host: "example.com:443",
    method: "GET",
    body: undefined,
    network: "eip155:10143",
    asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    payTo: "0xabc",
    amount: parseUsdcToMicros("0.01"),
    ...overrides,
  };
}

describe("Policy engine — TOCTOU: key state re-checked inside the transaction", () => {
  it("key revoked after auth but before signing -> KEY_REVOKED, no payment reserved", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });

    // Simulates the request-start auth snapshot (still `enabled: true` here).
    const staleKeySnapshot = { ...key };

    // Admin revokes the key in between auth and the policy-engine call
    // (e.g. while the agent is round-tripping to the upstream 402 resource).
    revokeMoneyKey(db, key.id);

    expect(() => evaluateAndReserve(db, staleKeySnapshot, fetchInput())).toThrowError();
    try {
      evaluateAndReserve(db, staleKeySnapshot, fetchInput());
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("KEY_REVOKED");
    }

    const payments = db.select().from(schema.payments).all();
    expect(payments.length).toBe(0);
  });

  it("key expired after auth but before signing -> KEY_EXPIRED, no payment reserved", () => {
    const { db } = freshDb();
    const soon = new Date(Date.now() + 50).toISOString();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
      expiresAt: soon,
    });
    const staleKeySnapshot = { ...key, expiresAt: null as string | null }; // pretend auth happened before expiry was set/observed

    // Wait past expiry.
    const start = Date.now();
    while (Date.now() - start < 80) {
      /* busy-wait a few ms past `soon` */
    }

    try {
      evaluateAndReserve(db, staleKeySnapshot, fetchInput());
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("KEY_EXPIRED");
    }
    const payments = db.select().from(schema.payments).all();
    expect(payments.length).toBe(0);
  });

  it("budget change after auth is honored: raising daily_budget mid-flight lets a previously-over-budget amount through", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("0.005"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });
    const staleKeySnapshot = { ...key };

    // A stale snapshot would have denied this (daily_budget 0.005 < amount 0.01).
    // Raise the real row's daily_budget before the transaction re-reads it.
    db.update(schema.moneyKeys)
      .set({ dailyBudget: 1_000_000 }) // 1.00 USDC in micros
      .run();

    const result = evaluateAndReserve(db, staleKeySnapshot, fetchInput({ amount: parseUsdcToMicros("0.01") }));
    expect(result.paymentId).toBeTruthy();
  });

  it("evaluateAndReserveInTransaction (the real call path) also re-checks and rolls back on revoke", () => {
    const { db, sqlite } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });
    const staleKeySnapshot = { ...key };
    revokeMoneyKey(db, key.id);

    try {
      evaluateAndReserveInTransaction(sqlite, db, staleKeySnapshot, fetchInput());
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("KEY_REVOKED");
    }
    const payments = db.select().from(schema.payments).all();
    expect(payments.length).toBe(0);
  });
});

// "Reset secret" keeps the key id and replaces key_hash. A request that authenticated with the OLD secret and is
// still waiting for the seller's 402 when the admin resets it must not be able to reserve or sign a payment:
// revoke is caught by the enabled check, a replaced secret by the key_hash comparison.
describe("Policy engine — TOCTOU: a secret reset after auth but before signing", () => {
  function mkKey(db: ReturnType<typeof freshDb>["db"], over: Partial<Parameters<typeof createMoneyKey>[1]> = {}) {
    return createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
      canDelegate: true,
      ...over,
    });
  }

  it("old-secret request -> KEY_INVALID, nothing reserved; the key itself stays enabled", () => {
    const { db } = freshDb();
    const { plaintextKey: oldSecret, row } = mkKey(db);
    // What requireMoneyKey stored on the request: authenticated with the OLD secret.
    const authenticatedWithOld = authenticateMoneyKey(db, oldSecret);

    rotateMoneyKeySecret(db, row.id); // admin clicks "Reset secret" while the request awaits the seller

    let err: unknown;
    try {
      evaluateAndReserve(db, authenticatedWithOld, fetchInput());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MoneySwitchError);
    expect((err as MoneySwitchError).code).toBe("KEY_INVALID");
    expect(db.select().from(schema.payments).all()).toHaveLength(0);
  });

  it("the real call path (BEGIN IMMEDIATE ... ROLLBACK) refuses too and leaves no row behind", () => {
    const { db, sqlite } = freshDb();
    const { plaintextKey: oldSecret, row } = mkKey(db);
    const authenticatedWithOld = authenticateMoneyKey(db, oldSecret);
    rotateMoneyKeySecret(db, row.id);

    let err: unknown;
    try {
      evaluateAndReserveInTransaction(sqlite, db, authenticatedWithOld, fetchInput());
    } catch (e) {
      err = e;
    }
    expect((err as MoneySwitchError).code).toBe("KEY_INVALID");
    expect(db.select().from(schema.payments).all()).toHaveLength(0);
    // the connection is not stuck in a transaction: a following request works
    const fresh = authenticateMoneyKey(db, rotateMoneyKeySecret(db, row.id)!.plaintextKey);
    expect(evaluateAndReserveInTransaction(sqlite, db, fresh, fetchInput()).paymentId).toBeTruthy();
  });

  it("a request that authenticated with the NEW secret pays normally", () => {
    const { db } = freshDb();
    const { row } = mkKey(db);
    const res = rotateMoneyKeySecret(db, row.id)!;
    const authenticatedWithNew = authenticateMoneyKey(db, res.plaintextKey);
    expect(evaluateAndReserve(db, authenticatedWithNew, fetchInput()).paymentId).toBeTruthy();
    expect(db.select().from(schema.payments).all()).toHaveLength(1);
  });

  it("resetting a PARENT's secret does not stop a request the child authenticated with its own secret", () => {
    const { db } = freshDb();
    const { row: parent } = mkKey(db);
    const kid = createChildKey(
      db,
      parent.id,
      { name: "kid", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") },
      { maxDepth: 3 }
    );
    const kidRequest = authenticateMoneyKey(db, kid.plaintextKey);
    rotateMoneyKeySecret(db, parent.id);
    expect(evaluateAndReserve(db, kidRequest, fetchInput({ amount: parseUsdcToMicros("0.01") })).paymentId).toBeTruthy();
  });

  it("revoke still wins when both happened (reset, then revoke): the request is refused either way", () => {
    const { db } = freshDb();
    const { plaintextKey: oldSecret, row } = mkKey(db);
    const authenticatedWithOld = authenticateMoneyKey(db, oldSecret);
    rotateMoneyKeySecret(db, row.id);
    revokeMoneyKey(db, row.id);
    expect(() => evaluateAndReserve(db, authenticatedWithOld, fetchInput())).toThrowError(MoneySwitchError);
    expect(db.select().from(schema.payments).all()).toHaveLength(0);
  });
});
