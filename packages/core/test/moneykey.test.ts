import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey, authenticateMoneyKey, revokeMoneyKey } from "../src/keys.js";
import { MoneySwitchError } from "../src/types.js";
import { parseUsdcToMicros } from "../src/money.js";

describe("MoneyKey auth", () => {
  it("creates a key and authenticates with the plaintext secret", () => {
    const { db } = freshDb();
    const { plaintextKey } = createMoneyKey(db, {
      name: "test",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: ["example.com:443"],
    });
    expect(plaintextKey.startsWith("mk_live_")).toBe(true);
    const row = authenticateMoneyKey(db, plaintextKey);
    expect(row.name).toBe("test");
  });

  it("rejects an invalid key -> KEY_INVALID", () => {
    const { db } = freshDb();
    createMoneyKey(db, {
      name: "test",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: [],
    });
    expect(() => authenticateMoneyKey(db, "mk_live_totallybogus0000000000000000")).toThrowError(
      /KEY_INVALID/
    );
    try {
      authenticateMoneyKey(db, "mk_live_totallybogus0000000000000000");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("KEY_INVALID");
    }
  });

  it("rejects a revoked key -> KEY_REVOKED", () => {
    const { db } = freshDb();
    const { plaintextKey, row } = createMoneyKey(db, {
      name: "test",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: [],
    });
    revokeMoneyKey(db, row.id);
    try {
      authenticateMoneyKey(db, plaintextKey);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("KEY_REVOKED");
    }
  });

  it("rejects creating a key with approval_threshold > per_request_limit", () => {
    const { db } = freshDb();
    expect(() =>
      createMoneyKey(db, {
        name: "bad",
        totalBudget: parseUsdcToMicros("10"),
        dailyBudget: parseUsdcToMicros("5"),
        perRequestLimit: parseUsdcToMicros("0.1"),
        approvalThreshold: parseUsdcToMicros("0.2"),
        allowedHosts: [],
      })
    ).toThrow();
  });
});
