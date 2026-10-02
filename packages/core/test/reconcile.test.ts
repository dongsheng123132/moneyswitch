import { describe, it, expect, vi } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve } from "../src/policy.js";
import {
  markUnknown,
  recordPaymentAuthorization,
  getPayment,
  reconcilePaymentToFailed,
  reconcilePaymentToSettled,
} from "../src/payments.js";
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

describe("reconcile: a tx hash the seller already reported is kept, overlapping runs cannot undo each other", () => {
  it("markUnknown(..., {txHash}) keeps the reported hash; reconcile settles with it and does not need a log lookup", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const { paymentId } = evaluateAndReserve(db, key, baseInput());
    markUnknown(db, paymentId, "SETTLE_NOT_CONFIRMED", { txHash: "0xreported" });
    recordPaymentAuthorization(db, paymentId, {
      from: "0x000000000000000000000000000000000000aa",
      nonce: "0x" + "22".repeat(32),
      validBefore: EXPIRED,
    });
    expect(getPayment(db, paymentId)!.txHash).toBe("0xreported");
    expect(getPayment(db, paymentId)!.status).toBe("unknown");

    const reader = fakeReader({ authorizationState: vi.fn(async () => true) });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });
    expect(result.settledWithTx).toBe(1);
    expect(reader.findAuthorizationUsedTx).not.toHaveBeenCalled();
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe("0xreported");
    expect(row.errorCode).toBeNull();
  });

  it("markUnknown without a txHash leaves an existing tx_hash alone", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const { paymentId } = evaluateAndReserve(db, key, baseInput());
    markUnknown(db, paymentId, "A", { txHash: "0xfirst" });
    markUnknown(db, paymentId, "B");
    expect(getPayment(db, paymentId)!.txHash).toBe("0xfirst");
    expect(getPayment(db, paymentId)!.errorCode).toBe("B");
  });

  it("the reconcile transitions only apply to a row that is still unknown and unreconciled (an overlapping run cannot overwrite a found tx hash)", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);
    expect(reconcilePaymentToSettled(db, paymentId, "0xfound", "2026-09-26T00:00:00.000Z")).toBe(true);
    // a second, slower run now arrives with nothing found / with "never used"
    expect(reconcilePaymentToSettled(db, paymentId, null, "2026-09-26T00:00:05.000Z")).toBe(false);
    expect(reconcilePaymentToFailed(db, paymentId, "2026-09-26T00:00:05.000Z")).toBe(false);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe("0xfound");
    expect(row.errorCode).toBeNull();
  });

  it("two overlapping runs: the one that finds the hash first wins; the slower run neither overwrites it nor writes a second audit entry", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);

    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => (releaseSlow = resolve));
    const slowReader = fakeReader({
      authorizationState: vi.fn(async () => {
        await gate; // run B sits here until run A has finished
        return true;
      }),
      findAuthorizationUsedTx: vi.fn(async () => null), // B's lookup runs dry (rate limit, call cap, ...)
    });
    const fastReader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => "0xfound"),
    });

    const runB = reconcileUnknownPayments({ db, reader: slowReader, now: NOW }); // selects the row, then waits
    const resultA = await reconcileUnknownPayments({ db, reader: fastReader, now: NOW });
    expect(resultA.settledWithTx).toBe(1);
    releaseSlow();
    const resultB = await runB;

    expect(resultB.scanned).toBe(1); // it did select the same row ...
    expect(resultB.settledTxUnknown).toBe(0); // ... but its write was refused
    expect(resultB.reconciledPaymentIds).toEqual([]);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe("0xfound");
    expect(row.errorCode).toBeNull();
    expect(listAudit(db, 20).filter((a) => a.action === "payment.reconcile.settled")).toHaveLength(1);
  });
});

describe("reconcile: backfill of the tx hash for rows already settled as SETTLED_TX_UNKNOWN", () => {
  async function settledWithoutHash(
    db: ReturnType<typeof freshDb>["db"],
    key: ReturnType<typeof makeKey>,
    nonce = "0x" + "11".repeat(32)
  ) {
    const paymentId = makeUnknownPayment(db, key, EXPIRED, nonce);
    const reader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null),
    });
    await reconcileUnknownPayments({ db, reader, now: NOW });
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBeNull();
    expect(row.errorCode).toBe("SETTLED_TX_UNKNOWN");
    return paymentId;
  }

  it("a row the main pass settled without a hash in THIS run is not scanned a second time by the backfill pass of the same run", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = makeUnknownPayment(db, key, EXPIRED);
    const reader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null),
    });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW, backfillTxLimit: 3 });
    expect(result.settledTxUnknown).toBe(1);
    expect(result.backfillScanned).toBe(0);
    expect(reader.findAuthorizationUsedTx).toHaveBeenCalledTimes(1); // the main pass's lookup only
    expect(getPayment(db, paymentId)!.errorCode).toBe("SETTLED_TX_UNKNOWN");
  });

  it("off by default: an already-settled row is not looked up again", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    await settledWithoutHash(db, key);
    const reader = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => "0xlate") });
    const result = await reconcileUnknownPayments({ db, reader, now: NOW });
    expect(result.backfillScanned).toBe(0);
    expect(reader.findAuthorizationUsedTx).not.toHaveBeenCalled();
  });

  it("backfillTxLimit > 0: the hash found later is stored, SETTLED_TX_UNKNOWN cleared, audited; the row is then no longer a candidate", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = await settledWithoutHash(db, key);
    const reader = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => "0xlate") });

    const first = await reconcileUnknownPayments({ db, reader, now: NOW, backfillTxLimit: 3 });
    expect(first.backfillScanned).toBe(1);
    expect(first.backfilledTx).toBe(1);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe("0xlate");
    expect(row.errorCode).toBeNull();
    expect(listAudit(db, 20).some((a) => a.action === "payment.reconcile.tx_backfilled")).toBe(true);

    const second = await reconcileUnknownPayments({ db, reader, now: NOW, backfillTxLimit: 3 });
    expect(second.backfillScanned).toBe(0);
    expect(reader.findAuthorizationUsedTx).toHaveBeenCalledTimes(1);
  });

  it("a lookup that finds nothing or throws leaves the row as it was (retried on a later pass) and never breaks the run", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const paymentId = await settledWithoutHash(db, key);

    const dry = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => null) });
    const r1 = await reconcileUnknownPayments({ db, reader: dry, now: NOW, backfillTxLimit: 3 });
    expect(r1.backfillScanned).toBe(1);
    expect(r1.backfilledTx).toBe(0);

    const broken = fakeReader({
      findAuthorizationUsedTx: vi.fn(async () => {
        throw new Error("429 rate limited");
      }),
    });
    const r2 = await reconcileUnknownPayments({ db, reader: broken, now: NOW, backfillTxLimit: 3 });
    expect(r2.backfilledTx).toBe(0);

    const row = getPayment(db, paymentId)!;
    expect(row.txHash).toBeNull();
    expect(row.errorCode).toBe("SETTLED_TX_UNKNOWN");

    const good = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => "0xlate") });
    const r3 = await reconcileUnknownPayments({ db, reader: good, now: NOW, backfillTxLimit: 3 });
    expect(r3.backfilledTx).toBe(1);
  });

  it("tries at most backfillTxLimit rows per pass and only looks back backfillMaxAgeDays", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    await settledWithoutHash(db, key, "0x" + "11".repeat(32));
    await settledWithoutHash(db, key, "0x" + "33".repeat(32));

    const limited = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => null) });
    const lim = await reconcileUnknownPayments({ db, reader: limited, now: NOW, backfillTxLimit: 1 });
    expect(lim.backfillScanned).toBe(1);

    const farFuture = new Date(NOW.getTime() + 60 * 86_400_000); // both rows are now ~60 days old
    const old = fakeReader({ findAuthorizationUsedTx: vi.fn(async () => "0xlate") });
    const res = await reconcileUnknownPayments({
      db,
      reader: old,
      now: farFuture,
      backfillTxLimit: 5,
      backfillMaxAgeDays: 14,
    });
    expect(res.backfillScanned).toBe(0);
    expect(old.findAuthorizationUsedTx).not.toHaveBeenCalled();
  });
});
