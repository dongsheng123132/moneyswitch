import { describe, it, expect, vi } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve } from "../src/policy.js";
import { markUnknown, recordPaymentAuthorization, getPayment } from "../src/payments.js";
import { usedToday } from "../src/ledger.js";
import { reconcileUnknownPayments, type AuthorizationReader } from "../src/reconcile.js";
import { listAudit } from "../src/audit.js";

function baseInput(overrides: Partial<Parameters<typeof evaluateAndReserve>[2]> = {}) {
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

function makeKey(db: ReturnType<typeof freshDb>["db"]) {
  return createMoneyKey(db, {
    name: "k",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("1"),
    perRequestLimit: parseUsdcToMicros("0.5"),
    allowedHosts: ["example.com:443"],
  }).row;
}

/** Reserves a payment, marks it `unknown` (as performPaidFetch does on NO_SETTLE_HEADER),
 * and captures an EIP-3009 authorization on it, all as of `validBeforeUnixSeconds`. */
function makeUnknownPayment(
  db: ReturnType<typeof freshDb>["db"],
  key: ReturnType<typeof makeKey>,
  validBeforeUnixSeconds: number,
  nonce = "0x" + "11".repeat(32)
) {
  const { paymentId } = evaluateAndReserve(db, key, baseInput());
  markUnknown(db, paymentId, "NO_SETTLE_HEADER");
  recordPaymentAuthorization(db, paymentId, {
    from: "0x000000000000000000000000000000000000aa",
    nonce,
    validBefore: validBeforeUnixSeconds,
  });
  return paymentId;
}

function fakeReader(overrides: Partial<AuthorizationReader> = {}): AuthorizationReader {
  return {
    authorizationState: vi.fn(async () => false),
    findAuthorizationUsedTx: vi.fn(async () => null),
    ...overrides,
  };
}

const NOW = new Date("2026-09-26T00:00:00.000Z");
const EXPIRED = Math.floor(NOW.getTime() / 1000) - 3600; // 1h in the past
const NOT_YET_EXPIRED = Math.floor(NOW.getTime() / 1000) + 3600; // 1h in the future

describe("reconcileUnknownPayments", () => {
  it("authorizationState=false -> failed/NOT_SETTLED_EXPIRED and quota is released", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);

    const usedBefore = usedToday(db, key.id, NOW);
    expect(usedBefore).toBeGreaterThan(0n);

    const reader = fakeReader({ authorizationState: vi.fn(async () => false) });
    const r = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(r.scanned).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.reconciledPaymentIds).toEqual([paymentId]);

    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("NOT_SETTLED_EXPIRED");
    expect(row.reconciledAt).toBeTruthy();

    // ledger.ts only counts settled/reserved/unknown -> failed releases the quota.
    const usedAfter = usedToday(db, key.id, NOW);
    expect(usedAfter).toBe(0n);

    const audit = listAudit(db, 10);
    expect(audit.some((a) => a.action === "payment.reconcile.failed")).toBe(true);
  });

  it("authorizationState=true and a matching log is found -> settled with tx_hash", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);

    const reader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => "0xdeadbeef"),
    });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.settledWithTx).toBe(1);
    expect(result.settledTxUnknown).toBe(0);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe("0xdeadbeef");
    expect(row.errorCode).toBeNull();
    expect(row.reconciledAt).toBeTruthy();

    // still counted against quota (settled counts too), so no incorrect release.
    const usedAfter = usedToday(db, key.id, NOW);
    expect(usedAfter).toBeGreaterThan(0n);
  });

  it("authorizationState=true but no matching log found -> settled with error_code SETTLED_TX_UNKNOWN and null tx_hash", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);

    const reader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null),
    });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.settledTxUnknown).toBe(1);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBeNull();
    expect(row.errorCode).toBe("SETTLED_TX_UNKNOWN");
  });

  it("RPC error (authorizationState throws) -> row is left completely untouched", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);

    const reader = fakeReader({
      authorizationState: vi.fn(async () => {
        throw new Error("RPC timeout");
      }),
    });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.rpcErrors).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.settledWithTx + result.settledTxUnknown).toBe(0);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("unknown");
    expect(row.reconciledAt).toBeNull();
  });

  it("authorization not yet expired -> not selected, reader never called", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, NOT_YET_EXPIRED);

    const reader = fakeReader();
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.scanned).toBe(0);
    expect(reader.authorizationState).not.toHaveBeenCalled();
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("unknown");
    expect(row.reconciledAt).toBeNull();
  });

  it("a mock/offline payment that never captured an authorization is skipped (never sent to the reader)", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    // No recordPaymentAuthorization call — e.g. a payment settled instantly by
    // a mock facilitator never goes through the NO_SETTLE_HEADER path, or an
    // older row from before this migration. Either way there is nothing to
    // check on-chain, so it must never be selected.
    const { paymentId } = evaluateAndReserve(db, key, baseInput());
    markUnknown(db, paymentId, "NO_SETTLE_HEADER");

    const reader = fakeReader();
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.scanned).toBe(0);
    expect(reader.authorizationState).not.toHaveBeenCalled();
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("unknown");
  });

  it("grace period: exactly-expired authorizations within the grace window are not yet selected", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const justExpired = Math.floor(NOW.getTime() / 1000) - 5; // 5s ago, within default 30s grace
    const paymentId = makeUnknownPayment(db, key, justExpired);

    const reader = fakeReader();
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });

    expect(result.scanned).toBe(0);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("unknown");
  });
});
