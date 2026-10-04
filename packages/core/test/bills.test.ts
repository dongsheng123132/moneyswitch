// The Bills page lists every payment (SPEC.md §2), newest first. The list used to stop silently at the newest 200; now it stops only at
// a hard cap, and says so: `truncated` is true only when rows exist that were not returned, and `total` is the size of the payments table.
import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { BILLS_MAX_ROWS, listPaymentsForBills } from "../src/payments.js";

type Fresh = ReturnType<typeof freshDb>;

/** `count` settled payments, one second apart: p0 is the oldest, p{count-1} the newest. */
function withPayments(count: number): Fresh {
  const fresh = freshDb();
  const key = createMoneyKey(fresh.db, {
    name: "k",
    totalBudget: parseUsdcToMicros("10"),
    dailyBudget: parseUsdcToMicros("5"),
    perRequestLimit: parseUsdcToMicros("0.5"),
    allowedHosts: ["example.com:443"],
  }).row;
  const insert = fresh.sqlite.prepare(
    `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind)
     VALUES (?, ?, 'https://example.com/premium', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, 'settled', ?, ?, 'fetch')`
  );
  const base = Date.parse("2026-10-04T00:00:00.000Z");
  fresh.sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const at = new Date(base + i * 1000).toISOString();
      insert.run(`p${i}`, key.id, at, at);
    }
  })();
  return fresh;
}

describe("listPaymentsForBills", () => {
  it("the cap is a named constant and is far above the old 200", () => {
    expect(BILLS_MAX_ROWS).toBe(10_000);
  });

  it("more than 200 payments: all of them come back, newest first, not truncated, total counted", () => {
    const { db } = withPayments(250);
    const { rows, truncated, total } = listPaymentsForBills(db);
    expect(rows).toHaveLength(250);
    expect(truncated).toBe(false);
    expect(total).toBe(250);
    expect(rows[0].id).toBe("p249");
    expect(rows[249].id).toBe("p0");
  });

  it("a small max: the newest rows, truncated = true, total is still the whole table", () => {
    const { db } = withPayments(10);
    const { rows, truncated, total } = listPaymentsForBills(db, 4);
    expect(rows.map((r) => r.id)).toEqual(["p9", "p8", "p7", "p6"]);
    expect(truncated).toBe(true);
    expect(total).toBe(10);
  });

  it("exactly max rows: nothing is missing, so truncated = false", () => {
    const { db } = withPayments(5);
    const { rows, truncated, total } = listPaymentsForBills(db, 5);
    expect(rows).toHaveLength(5);
    expect(truncated).toBe(false);
    expect(total).toBe(5);
  });

  it("one row more than max is truncated", () => {
    const { db } = withPayments(6);
    const { rows, truncated, total } = listPaymentsForBills(db, 5);
    expect(rows).toHaveLength(5);
    expect(truncated).toBe(true);
    expect(total).toBe(6);
  });

  it("the default cap is what the route gets: BILLS_MAX_ROWS + 1 rows are cut to BILLS_MAX_ROWS and say so", () => {
    const { db } = withPayments(BILLS_MAX_ROWS + 1);
    const res = listPaymentsForBills(db);
    expect(res.rows).toHaveLength(BILLS_MAX_ROWS);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(BILLS_MAX_ROWS + 1);
    expect(res.rows[0]!.id).toBe(`p${BILLS_MAX_ROWS}`);
  });

  it("no payments at all: an empty list, not truncated, total 0", () => {
    const { db } = withPayments(0);
    expect(listPaymentsForBills(db)).toEqual({ rows: [], truncated: false, total: 0 });
  });

  it("every row keeps the fields the bills page shows", () => {
    const { db } = withPayments(1);
    expect(listPaymentsForBills(db).rows[0]).toMatchObject({
      id: "p0",
      url: "https://example.com/premium",
      host: "example.com:443",
      method: "GET",
      network: "eip155:10143",
      payTo: "0xb",
      amount: 10000n,
      status: "settled",
      approvalId: null,
      kind: "fetch",
    });
  });
});
