import { describe, it, expect, vi } from "vitest";
import { openDb } from "@moneyswitch/db";
import {
  createMoneyKey,
  evaluateAndReserve,
  getPayment,
  markUnknown,
  parseUsdcToMicros,
  recordPaymentAuthorization,
  type AuthorizationReader,
} from "@moneyswitch/core";
import type { AppContext } from "../../src/context.js";
import { BACKFILL_ROWS_PER_PASS, runReconcileOnce } from "../../src/reconcileJob.js";

/**
 * The reconcile run is shared by the 60 s background loop and POST /v1/admin/reconcile.
 * A run can take minutes on a slow RPC (chunked eth_getLogs), so (1) runs must not
 * overlap and (2) the expensive tx-hash backfill must not run on every tick.
 */

function makeCtx(reader: AuthorizationReader | undefined) {
  const { db } = openDb({ filePath: ":memory:" });
  const ctx = { db, chainReader: reader } as unknown as AppContext;
  const key = createMoneyKey(db, {
    name: "k",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("1"),
    perRequestLimit: parseUsdcToMicros("0.5"),
    allowedHosts: ["example.com:443"],
  }).row;
  let n = 0;
  /** An `unknown` payment whose authorization expired an hour ago. */
  function expiredUnknownPayment() {
    n++;
    const { paymentId } = evaluateAndReserve(db, key, {
      url: "https://example.com/x",
      host: "example.com:443",
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      payTo: "0xabc",
      amount: parseUsdcToMicros("0.01"),
    });
    markUnknown(db, paymentId, "TIMEOUT_AFTER_PAYMENT");
    recordPaymentAuthorization(db, paymentId, {
      from: "0x000000000000000000000000000000000000aa",
      nonce: "0x" + n.toString(16).padStart(2, "0").repeat(32),
      validBefore: Math.floor(Date.now() / 1000) - 3600,
    });
    return paymentId;
  }
  return { ctx, db, expiredUnknownPayment };
}

describe("runReconcileOnce", () => {
  it("is a no-op without a chain reader", async () => {
    const { ctx } = makeCtx(undefined);
    const r = await runReconcileOnce(ctx);
    expect(r.scanned).toBe(0);
  });

  it("never runs two reconciles at once for the same context: a second call joins the run in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reader: AuthorizationReader = {
      authorizationState: vi.fn(async () => {
        await gate; // a slow RPC
        return true;
      }),
      findAuthorizationUsedTx: vi.fn(async () => "0xfound"),
    };
    const { ctx, db, expiredUnknownPayment } = makeCtx(reader);
    const id = expiredUnknownPayment();

    const first = runReconcileOnce(ctx);
    const second = runReconcileOnce(ctx); // the next 60 s tick / an admin click while the first is still running
    expect(second).toBe(first);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(a.settledWithTx).toBe(1);
    expect(reader.authorizationState).toHaveBeenCalledTimes(1);
    expect(getPayment(db, id)!.txHash).toBe("0xfound");

    // once finished, the next call is a fresh run
    const third = runReconcileOnce(ctx);
    expect(third).not.toBe(first);
    await third;
  });

  it("a failed run frees the slot (the next call starts a new run)", async () => {
    const reader: AuthorizationReader = {
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null),
    };
    const { ctx } = makeCtx(reader);
    // Break the DB under the run: reconcileUnknownPayments rejects.
    (ctx as unknown as { db: unknown }).db = null;
    await expect(runReconcileOnce(ctx)).rejects.toBeTruthy();
    const again = runReconcileOnce(ctx);
    await expect(again).rejects.toBeTruthy();
  });

  it("tx-hash backfill: runs on the first tick, is throttled afterwards, and 'now' (admin) bypasses the throttle", async () => {
    const reader: AuthorizationReader = {
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null), // the lookup finds nothing at first
    };
    const { ctx, db, expiredUnknownPayment } = makeCtx(reader);
    const id = expiredUnknownPayment();

    // run 1: reconciles the row (settled, no hash) and, being the first run, also backfills (finds nothing)
    const r1 = await runReconcileOnce(ctx);
    expect(r1.settledTxUnknown).toBe(1);
    expect(r1.backfillScanned).toBe(0); // the row was only just settled in THIS run: backfill looks at rows settled before it started
    expect(getPayment(db, id)!.errorCode).toBe("SETTLED_TX_UNKNOWN");
    const lookupsAfterRun1 = (reader.findAuthorizationUsedTx as ReturnType<typeof vi.fn>).mock.calls.length;

    // the log lookup would succeed now (RPC recovered / indexer caught up)
    (reader.findAuthorizationUsedTx as ReturnType<typeof vi.fn>).mockImplementation(async () => "0xlate");

    // run 2, right after: inside the throttle window -> no backfill
    const r2 = await runReconcileOnce(ctx);
    expect(r2.backfillScanned).toBe(0);
    expect((reader.findAuthorizationUsedTx as ReturnType<typeof vi.fn>).mock.calls.length).toBe(lookupsAfterRun1);
    expect(getPayment(db, id)!.txHash).toBeNull();

    // admin "now": backfill regardless of the throttle
    const r3 = await runReconcileOnce(ctx, { backfill: "now" });
    expect(r3.backfillScanned).toBe(1);
    expect(r3.backfilledTx).toBe(1);
    expect(getPayment(db, id)!.txHash).toBe("0xlate");
    expect(getPayment(db, id)!.errorCode).toBeNull();
  });

  it("backfill is bounded per pass", async () => {
    const reader: AuthorizationReader = {
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => null),
    };
    const { ctx, expiredUnknownPayment } = makeCtx(reader);
    for (let i = 0; i < BACKFILL_ROWS_PER_PASS + 2; i++) expiredUnknownPayment();
    await runReconcileOnce(ctx); // settles them all without a hash
    const r = await runReconcileOnce(ctx, { backfill: "now" });
    expect(r.backfillScanned).toBe(BACKFILL_ROWS_PER_PASS);
  });
});
