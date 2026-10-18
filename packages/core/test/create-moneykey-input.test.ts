import { describe, it, expect } from "vitest";
import { schema } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createMoneyKey, getMoneyKeyById } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { isHostListed } from "../src/host-approval.js";
import { checkHostAllowedForChain } from "../src/gate.js";
import { MoneySwitchError } from "../src/types.js";

const usdc = parseUsdcToMicros;

function base(over: Record<string, unknown> = {}) {
  return {
    name: "test",
    totalBudget: usdc("10"),
    dailyBudget: usdc("1"),
    perRequestLimit: usdc("0.5"),
    allowedHosts: ["example.com:443"],
    ...over,
  } as Parameters<typeof createMoneyKey>[1];
}

describe("parseUsdcToMicros: non-string input", () => {
  it("undefined / null / object throw INVALID_AMOUNT, not TypeError on .trim()", () => {
    for (const bad of [undefined, null, {}, [], true] as unknown[]) {
      expect(() => parseUsdcToMicros(bad as string), JSON.stringify(bad)).toThrowError(/INVALID_AMOUNT/);
    }
  });

  it("finite numbers are accepted", () => {
    expect(parseUsdcToMicros(0.01)).toBe(usdc("0.01"));
  });
});

describe("createMoneyKey input validation", () => {
  it("empty / whitespace / non-string name is refused before any insert", () => {
    const { db } = freshDb();
    for (const name of ["", "   ", 42, null, undefined] as unknown[]) {
      expect(() => createMoneyKey(db, base({ name })), JSON.stringify(name)).toThrowError(/name is required/);
    }
  });

  it("non-array or empty host entries are refused; scheme / path entries are refused", () => {
    const { db } = freshDb();
    for (const allowedHosts of ["example.com:443", [""], ["https://example.com"], ["example.com/path"], [42]] as unknown[]) {
      expect(() => createMoneyKey(db, base({ allowedHosts })), JSON.stringify(allowedHosts)).toThrowError(
        /allowed_hosts/
      );
    }
    // host[:port] and a bare host stay valid
    expect(() => createMoneyKey(db, base({ allowedHosts: ["example.com", "api.test:8443"] }))).not.toThrow();
  });

  it("negative budgets are refused", () => {
    const { db } = freshDb();
    expect(() => createMoneyKey(db, base({ totalBudget: -1n }))).toThrowError(/budgets must be/);
    expect(() => createMoneyKey(db, base({ approvalThreshold: -1n }))).toThrowError(/budgets must be/);
  });

  it("name and host entries are trimmed on the stored row", () => {
    const { db } = freshDb();
    const { row } = createMoneyKey(db, base({ name: "  spaced  ", allowedHosts: ["  example.com:443  "] }));
    expect(row.name).toBe("spaced");
    expect(row.allowedHosts).toEqual(["example.com:443"]);
  });
});

describe("isHostListed with a malformed allowed_hosts row", () => {
  it("a non-array is treated as empty (deny), not a TypeError", () => {
    const url = new URL("https://example.com/");
    expect(isHostListed(url, "example.com" as unknown as string[])).toBe(false);
    expect(isHostListed(url, ["example.com"])).toBe(true);
    expect(isHostListed(url, [42 as unknown as string])).toBe(false);
  });
});

describe("checkHostAllowedForChain with a malformed allowed_hosts row", () => {
  it("a string allowed_hosts denies with HOST_NOT_ALLOWED (never TypeError / undefined code)", () => {
    const { db } = freshDb();
    // Bypass createMoneyKey validation: a legacy / hand-edited row whose
    // allowed_hosts is a string used to make isHostListed throw TypeError,
    // which gate.ts re-wrapped as MoneySwitchError(undefined code) and
    // /v1/fetch then omitted `code` from its envelope.
    db.insert(schema.moneyKeys)
      .values({
        id: "malformed",
        name: "malformed",
        keyPrefix: "mk_live_malfo",
        keyHash: "x",
        enabled: true,
        totalBudget: 10,
        dailyBudget: 10,
        perRequestLimit: 10,
        approvalThreshold: null,
        allowedHosts: "example.com" as unknown as string[],
        maxPaymentsPerMinute: 10,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        parentId: null,
        depth: 0,
        canDelegate: false,
        createdBy: "admin",
        networkMode: "testnet",
        approvalPin: null,
        approvalPinFailures: 0,
      })
      .run();
    const row = getMoneyKeyById(db, "malformed")!;
    try {
      checkHostAllowedForChain(db, new URL("https://example.com/"), row);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MoneySwitchError);
      expect((e as MoneySwitchError).code).toBe("HOST_NOT_ALLOWED");
      expect((e as MoneySwitchError).code).toBeTruthy();
    }
  });

  it("still wraps HOST_NOT_ALLOWED with limit scope", () => {
    const { db } = freshDb();
    const { row } = createMoneyKey(db, base({ allowedHosts: ["example.com:443"] }));
    try {
      checkHostAllowedForChain(db, new URL("https://other.example/"), row);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MoneySwitchError);
      expect((e as MoneySwitchError).code).toBe("HOST_NOT_ALLOWED");
      expect((e as MoneySwitchError).limit?.scope).toBe("self");
    }
  });
});
