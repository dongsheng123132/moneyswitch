import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros, formatMicrosToUsdc } from "../src/money.js";
import { evaluateAndReserve, checkPriceLimits, ApprovalRequiredError } from "../src/policy.js";
import { decideApproval } from "../src/approval.js";
import { MoneySwitchError } from "../src/types.js";
import { settlePayment } from "../src/payments.js";

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

describe("Policy engine — DENY / ALLOW / PENDING", () => {
  it("ALLOW: amount within all limits reserves a payment", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: ["example.com:443"],
    });
    const result = evaluateAndReserve(db, key, baseInput());
    expect(result.paymentId).toBeTruthy();
    expect(result.approvalId).toBeNull();
  });

  it("DENY: amount > per_request_limit -> PER_REQUEST_LIMIT_EXCEEDED", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.01"),
      allowedHosts: ["example.com:443"],
    });
    expect(() =>
      evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("5.00") }))
    ).toThrowError();
    try {
      evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("5.00") }));
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
    }
  });

  it("DENY: max_price given and amount > max_price -> MAX_PRICE_EXCEEDED", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });
    try {
      evaluateAndReserve(
        db,
        key,
        baseInput({ amount: parseUsdcToMicros("0.05"), maxPrice: parseUsdcToMicros("0.01") })
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("MAX_PRICE_EXCEEDED");
    }
  });

  it("DENY: daily budget exceeded -> DAILY_BUDGET_EXCEEDED", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("0.015"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });
    evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("0.01") }));
    try {
      evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("0.01") }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("DAILY_BUDGET_EXCEEDED");
    }
  });

  it("DENY: total budget exceeded -> TOTAL_BUDGET_EXCEEDED", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("0.015"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
    });
    evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("0.01") }));
    try {
      evaluateAndReserve(db, key, baseInput({ amount: parseUsdcToMicros("0.01") }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("TOTAL_BUDGET_EXCEEDED");
    }
  });

  it("PENDING: amount >= approval_threshold without approval_id -> APPROVAL_REQUIRED, then approve+retry succeeds", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      approvalThreshold: parseUsdcToMicros("0.10"),
      allowedHosts: ["example.com:443"],
    });
    const input = baseInput({ amount: parseUsdcToMicros("0.15") });
    let approvalId = "";
    try {
      evaluateAndReserve(db, key, input);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalRequiredError);
      approvalId = (e as ApprovalRequiredError).approvalId;
    }
    decideApproval(db, approvalId, "approved");
    const result = evaluateAndReserve(db, key, { ...input, approvalId });
    expect(result.approvalId).toBe(approvalId);
  });

  it("approval reused a second time -> APPROVAL_INVALID", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      approvalThreshold: parseUsdcToMicros("0.10"),
      allowedHosts: ["example.com:443"],
    });
    const input = baseInput({ amount: parseUsdcToMicros("0.15") });
    let approvalId = "";
    try {
      evaluateAndReserve(db, key, input);
    } catch (e) {
      approvalId = (e as ApprovalRequiredError).approvalId;
    }
    decideApproval(db, approvalId, "approved");
    evaluateAndReserve(db, key, { ...input, approvalId });
    try {
      evaluateAndReserve(db, key, { ...input, approvalId });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("APPROVAL_INVALID");
    }
  });

  it("approval used with a different URL -> APPROVAL_INVALID", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros("1"),
      approvalThreshold: parseUsdcToMicros("0.10"),
      allowedHosts: ["example.com:443"],
    });
    const input = baseInput({ amount: parseUsdcToMicros("0.15") });
    let approvalId = "";
    try {
      evaluateAndReserve(db, key, input);
    } catch (e) {
      approvalId = (e as ApprovalRequiredError).approvalId;
    }
    decideApproval(db, approvalId, "approved");
    try {
      evaluateAndReserve(db, key, {
        ...input,
        url: "https://example.com/other",
        approvalId,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("APPROVAL_INVALID");
    }
  });

  describe("an approval is for one chain and one asset", () => {
    function approvedOnChainA() {
      const { db } = freshDb();
      const { row: key } = createMoneyKey(db, {
        name: "k",
        totalBudget: parseUsdcToMicros("10"),
        dailyBudget: parseUsdcToMicros("10"),
        perRequestLimit: parseUsdcToMicros("1"),
        approvalThreshold: parseUsdcToMicros("0.10"),
        allowedHosts: ["example.com:443"],
      });
      const input = baseInput({ amount: parseUsdcToMicros("0.15") });
      let approvalId = "";
      try {
        evaluateAndReserve(db, key, input);
      } catch (e) {
        approvalId = (e as ApprovalRequiredError).approvalId;
      }
      decideApproval(db, approvalId, "approved");
      return { db, key, input, approvalId };
    }
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (e) {
        return (e as MoneySwitchError).code;
      }
      return "no error";
    };

    it("the same payment on another chain -> APPROVAL_INVALID, and the approval is still unused", () => {
      const { db, key, input, approvalId } = approvedOnChainA();
      expect(codeOf(() => evaluateAndReserve(db, key, { ...input, network: "eip155:84532", approvalId }))).toBe("APPROVAL_INVALID");
      expect(evaluateAndReserve(db, key, { ...input, approvalId }).approvalId, "on the approved chain it still works").toBe(approvalId);
    });

    it("the same chain with another asset -> APPROVAL_INVALID; the asset's letter case does not matter", () => {
      const { db, key, input, approvalId } = approvedOnChainA();
      expect(codeOf(() => evaluateAndReserve(db, key, { ...input, asset: "0x1111111111111111111111111111111111111111", approvalId }))).toBe("APPROVAL_INVALID");
      expect(evaluateAndReserve(db, key, { ...input, asset: input.asset.toLowerCase(), approvalId }).approvalId).toBe(approvalId);
    });
  });
});

describe("checkPriceLimits (the refusals that need only the price)", () => {
  function chainOf(perRequestLimit: string) {
    const { db } = freshDb();
    const { row } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("10"),
      perRequestLimit: parseUsdcToMicros(perRequestLimit),
      allowedHosts: ["example.com:443"],
    });
    return [row];
  }

  it("passes a price within the limit and within max_price (equal counts as within)", () => {
    expect(checkPriceLimits(chainOf("0.5"), parseUsdcToMicros("0.5"), parseUsdcToMicros("0.5"))).toBeNull();
    expect(checkPriceLimits(chainOf("0.5"), parseUsdcToMicros("0.01"))).toBeNull();
  });

  it("returns (does not throw) PER_REQUEST_LIMIT_EXCEEDED with the limit's scope, before MAX_PRICE_EXCEEDED", () => {
    const refusal = checkPriceLimits(chainOf("0.5"), parseUsdcToMicros("0.6"), parseUsdcToMicros("0.1"));
    expect(refusal).toBeInstanceOf(MoneySwitchError);
    expect(refusal!.code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
    expect(refusal!.limit?.scope).toBe("self");
  });

  it("returns MAX_PRICE_EXCEEDED when only the caller's max_price is exceeded", () => {
    expect(checkPriceLimits(chainOf("0.5"), parseUsdcToMicros("0.2"), parseUsdcToMicros("0.1"))!.code).toBe("MAX_PRICE_EXCEEDED");
  });
});

describe("formatMicrosToUsdc / parseUsdcToMicros round trip", () => {
  it("round trips exactly", () => {
    expect(formatMicrosToUsdc(parseUsdcToMicros("0.01"))).toBe("0.01");
    expect(formatMicrosToUsdc(parseUsdcToMicros("5"))).toBe("5");
    expect(formatMicrosToUsdc(parseUsdcToMicros("0.10"))).toBe("0.1");
  });
});
