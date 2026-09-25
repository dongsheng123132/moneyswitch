import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve } from "../src/policy.js";
import { MoneySwitchError } from "../src/types.js";

describe("Concurrency: daily budget under simultaneous reservations", () => {
  it("daily=1.00, 10 concurrent 0.15 payments -> exactly 6 settled(reserved), 4 DAILY_BUDGET_EXCEEDED", async () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "concurrent",
      totalBudget: parseUsdcToMicros("100"),
      dailyBudget: parseUsdcToMicros("1.00"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
      maxPaymentsPerMinute: 100,
    });
    const input = {
      url: "https://example.com/deep-report",
      host: "example.com:443",
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0xasset",
      payTo: "0xpay",
      amount: parseUsdcToMicros("0.15"),
    };

    const attempts = Array.from({ length: 10 }, () =>
      // Each task is scheduled as a microtask; the actual reservation work
      // inside evaluateAndReserve is fully synchronous (single SQLite
      // transaction, no `await` inside), so Node's single-threaded event
      // loop cannot interleave two reservations — this reproduces the
      // real server's per-request atomicity without needing real threads.
      Promise.resolve().then(() => {
        try {
          evaluateAndReserve(db, key, input);
          return "ok" as const;
        } catch (e) {
          return (e as MoneySwitchError).code;
        }
      })
    );

    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r === "ok").length;
    const denied = results.filter((r) => r === "DAILY_BUDGET_EXCEEDED").length;
    expect(ok).toBe(6);
    expect(denied).toBe(4);
  });
});
