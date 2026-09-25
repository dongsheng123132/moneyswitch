import { describe, it, expect } from "vitest";
import { assertNotSsrf } from "../src/ssrf.js";
import { checkHostAllowed, checkRateLimit } from "../src/gate.js";
import { MoneySwitchError } from "../src/types.js";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { parseUsdcToMicros } from "../src/money.js";
import { evaluateAndReserve } from "../src/policy.js";

describe("SSRF guard", () => {
  it("always blocks MoneySwitch's own loopback:4020, even if allow-listed", () => {
    expect(() =>
      assertNotSsrf(new URL("http://127.0.0.1:4020/v1/fetch"), {
        selfPort: 4020,
        allowedHosts: ["127.0.0.1:4020"],
      })
    ).toThrowError(/SSRF_BLOCKED/);
    expect(() =>
      assertNotSsrf(new URL("http://localhost:4020/"), {
        selfPort: 4020,
        allowedHosts: ["localhost:4020"],
      })
    ).toThrowError(/SSRF_BLOCKED/);
  });

  it("blocks private/loopback hosts unless explicitly allow-listed as host:port", () => {
    expect(() =>
      assertNotSsrf(new URL("http://127.0.0.1:4021/free"), {
        selfPort: 4020,
        allowedHosts: [],
      })
    ).toThrowError(/SSRF_BLOCKED/);
  });

  it("allows a private/loopback host when explicitly listed (demo-seller case)", () => {
    expect(() =>
      assertNotSsrf(new URL("http://127.0.0.1:4021/free"), {
        selfPort: 4020,
        allowedHosts: ["127.0.0.1:4021"],
      })
    ).not.toThrow();
  });

  it("allows a public host regardless of allowlist content (allowlist enforced separately)", () => {
    expect(() =>
      assertNotSsrf(new URL("https://api.example.com/x"), {
        selfPort: 4020,
        allowedHosts: [],
      })
    ).not.toThrow();
  });
});

describe("Host allowlist gate", () => {
  const key = {
    allowedHosts: ["example.com:443"],
  } as any;

  it("HOST_NOT_ALLOWED when host is not listed", () => {
    try {
      checkHostAllowed(new URL("https://evil.com/"), key);
      throw new Error("should throw");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("HOST_NOT_ALLOWED");
    }
  });

  it("empty allowed_hosts rejects everything", () => {
    try {
      checkHostAllowed(new URL("https://example.com/"), { allowedHosts: [] } as any);
      throw new Error("should throw");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("HOST_NOT_ALLOWED");
    }
  });

  it("allows a listed host", () => {
    expect(() => checkHostAllowed(new URL("https://example.com/x"), key)).not.toThrow();
  });
});

describe("Rate limit gate", () => {
  it("RATE_LIMITED after max_payments_per_minute reservations within 60s", () => {
    const { db } = freshDb();
    const { row: key } = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("100"),
      dailyBudget: parseUsdcToMicros("100"),
      perRequestLimit: parseUsdcToMicros("1"),
      allowedHosts: ["example.com:443"],
      maxPaymentsPerMinute: 2,
    });
    const input = {
      url: "https://example.com/x",
      host: "example.com:443",
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0xasset",
      payTo: "0xpay",
      amount: parseUsdcToMicros("0.01"),
    };
    checkRateLimit(db, key);
    evaluateAndReserve(db, key, input);
    checkRateLimit(db, key);
    evaluateAndReserve(db, key, input);
    try {
      checkRateLimit(db, key);
      throw new Error("should throw");
    } catch (e) {
      expect((e as MoneySwitchError).code).toBe("RATE_LIMITED");
    }
  });
});
