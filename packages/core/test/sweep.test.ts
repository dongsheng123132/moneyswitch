// M4(a): a process that dies (or is restarted) while a payment is in flight leaves a `reserved` row behind that nothing
// will ever finish. `reserved` counts against the key's budget forever, so at startup, before serving, each such row is
// resolved from what is known about it:
//   - an EIP-3009 authorization was captured (the buyer signed it)  -> `unknown`: the money may have moved, reconcile
//     decides from the chain;
//   - none was captured (nothing was ever signed)                   -> `failed`: nothing can have moved, the budget is released.
import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve } from "../src/policy.js";
import { getPayment, markUnknown, recordPaymentAuthorization, settlePayment, sweepStaleReservations } from "../src/payments.js";
import { usedTotal } from "../src/ledger.js";
import { listAudit } from "../src/audit.js";
import { reconcileUnknownPayments, type AuthorizationReader } from "../src/reconcile.js";

type Db = ReturnType<typeof freshDb>["db"];

function makeKey(db: Db) {
  return createMoneyKey(db, {
    name: "k",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("5"),
    perRequestLimit: parseUsdcToMicros("0.5"),
    allowedHosts: ["example.com:443"],
  }).row;
}

const input = {
  url: "https://example.com/premium",
  host: "example.com:443",
  method: "GET",
  body: undefined,
  network: "eip155:10143",
  asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  payTo: "0xabc",
  amount: parseUsdcToMicros("0.01"),
};

function reserve(db: Db, key: ReturnType<typeof makeKey>): string {
  return evaluateAndReserve(db, key, input).paymentId;
}
function withAuthorization(db: Db, id: string, validBefore = Math.floor(Date.now() / 1000) + 60) {
  recordPaymentAuthorization(db, id, { from: "0x000000000000000000000000000000000000aa", nonce: "0x" + "22".repeat(32), validBefore });
}

/** A moment after everything the test created so far, i.e. "this boot". */
const afterNow = () => new Date(Date.now() + 1000).toISOString();

describe("sweepStaleReservations", () => {
  it("a reserved row WITH a captured authorization becomes unknown (it still counts against the budget; reconcile resolves it)", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const id = reserve(db, key);
    withAuthorization(db, id);
    expect(getPayment(db, id)?.status).toBe("reserved");

    const result = sweepStaleReservations(db, afterNow());

    expect(result).toEqual({ toUnknown: [id], toFailed: [] });
    const row = getPayment(db, id)!;
    expect(row.status).toBe("unknown");
    expect(row.errorCode).toBe("RESTARTED_IN_FLIGHT");
    expect(row.authFrom).toBeTruthy(); // the lead reconcile needs is kept
    expect(usedTotal(db, key.id)).toBe(parseUsdcToMicros("0.01")); // the money may have moved: still counted
  });

  it("a reserved row WITHOUT any authorization becomes failed and the budget is released", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const id = reserve(db, key);
    expect(usedTotal(db, key.id)).toBe(parseUsdcToMicros("0.01"));

    const result = sweepStaleReservations(db, afterNow());

    expect(result).toEqual({ toUnknown: [], toFailed: [id] });
    const row = getPayment(db, id)!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("RESTARTED_BEFORE_SIGNING");
    expect(usedTotal(db, key.id)).toBe(0n); // nothing was signed, nothing can have been spent
  });

  it("handles both kinds at once and leaves every other row alone", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const signed = reserve(db, key);
    withAuthorization(db, signed);
    const unsigned = reserve(db, key);
    const settled = reserve(db, key);
    settlePayment(db, settled, "0x" + "ab".repeat(32));
    const unknown = reserve(db, key);
    markUnknown(db, unknown, "NO_SETTLE_HEADER");

    const result = sweepStaleReservations(db, afterNow());

    expect(result.toUnknown).toEqual([signed]);
    expect(result.toFailed).toEqual([unsigned]);
    expect(getPayment(db, settled)?.status).toBe("settled");
    expect(getPayment(db, unknown)?.status).toBe("unknown");
    expect(getPayment(db, unknown)?.errorCode).toBe("NO_SETTLE_HEADER");
  });

  it("only rows created BEFORE this boot are touched (a payment already started by this process is not swept)", () => {
    const { db, sqlite } = freshDb();
    const key = makeKey(db);
    const old = reserve(db, key);
    const bootedAt = afterNow();
    // a row of the running process: created after the boot timestamp
    const live = reserve(db, key);
    sqlite.prepare(`UPDATE payments SET created_at = ? WHERE id = ?`).run(new Date(Date.parse(bootedAt) + 5000).toISOString(), live);

    const result = sweepStaleReservations(db, bootedAt);

    expect(result.toFailed).toEqual([old]);
    expect(getPayment(db, live)?.status).toBe("reserved");
  });

  it("is idempotent: a second sweep finds nothing", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    reserve(db, key);
    const signed = reserve(db, key);
    withAuthorization(db, signed);
    const bootedAt = afterNow();
    expect(sweepStaleReservations(db, bootedAt).toFailed).toHaveLength(1);
    expect(sweepStaleReservations(db, bootedAt)).toEqual({ toUnknown: [], toFailed: [] });
  });

  it("writes one audit entry per row it changed, naming the payment and what became of it", () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const signed = reserve(db, key);
    withAuthorization(db, signed);
    const unsigned = reserve(db, key);

    sweepStaleReservations(db, afterNow());

    const entries = listAudit(db, 50).filter((a) => a.action.startsWith("payment.startup_sweep"));
    expect(entries.map((a) => a.action).sort()).toEqual(["payment.startup_sweep.failed", "payment.startup_sweep.unknown"]);
    const byAction = Object.fromEntries(entries.map((a) => [a.action, a.detail as Record<string, unknown>]));
    expect(byAction["payment.startup_sweep.unknown"]).toMatchObject({ paymentId: signed, keyId: key.id });
    expect(byAction["payment.startup_sweep.failed"]).toMatchObject({ paymentId: unsigned, keyId: key.id });
  });

  it("a swept unknown row is then resolved by reconcile from the chain once its authorization has expired", async () => {
    const { db } = freshDb();
    const key = makeKey(db);
    const id = reserve(db, key);
    withAuthorization(db, id, Math.floor(Date.now() / 1000) - 3600);
    sweepStaleReservations(db, afterNow());
    expect(getPayment(db, id)?.status).toBe("unknown");

    const reader: AuthorizationReader = {
      authorizationState: async () => false,
      findAuthorizationUsedTx: async () => null,
    };
    const result = await reconcileUnknownPayments({ db, reader });

    expect(result.failed).toBe(1);
    expect(getPayment(db, id)?.status).toBe("failed");
    expect(usedTotal(db, key.id)).toBe(0n);
  });
});
