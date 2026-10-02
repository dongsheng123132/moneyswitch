import { describe, it, expect } from "vitest";
import {
  parseTimeoutMs,
  resolvePaidFetchTimeouts,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PAID_TIMEOUT_MS,
} from "../src/client.js";

describe("paid-fetch deadlines", () => {
  it("defaults: probe 30s, paid 300s", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_PAID_TIMEOUT_MS).toBe(300_000);
    expect(resolvePaidFetchTimeouts({})).toEqual({ probeMs: 30_000, paidMs: 300_000 });
  });

  it("MONEYSWITCH_PROBE_TIMEOUT_MS / MONEYSWITCH_PAID_TIMEOUT_MS override the defaults", () => {
    expect(
      resolvePaidFetchTimeouts({ MONEYSWITCH_PROBE_TIMEOUT_MS: "1500", MONEYSWITCH_PAID_TIMEOUT_MS: "45000" })
    ).toEqual({ probeMs: 1500, paidMs: 45_000 });
  });

  it("invalid values fall back to the defaults and can never disable the timeout", () => {
    for (const bad of ["0", "-1", "", "  ", "abc", "NaN", "Infinity", "-Infinity", "0.4", "30s", "99999999999999"]) {
      expect(parseTimeoutMs(bad, 1234)).toBe(1234);
    }
    expect(parseTimeoutMs(undefined, 1234)).toBe(1234);
    expect(
      resolvePaidFetchTimeouts({ MONEYSWITCH_PROBE_TIMEOUT_MS: "0", MONEYSWITCH_PAID_TIMEOUT_MS: "off" })
    ).toEqual({ probeMs: 30_000, paidMs: 300_000 });
  });

  it("accepts plain numbers (incl. surrounding whitespace, exponent form) and floors fractions >= 1", () => {
    expect(parseTimeoutMs(" 2500 ", 1)).toBe(2500);
    expect(parseTimeoutMs("1e3", 1)).toBe(1000);
    expect(parseTimeoutMs("1500.9", 1)).toBe(1500);
    expect(parseTimeoutMs("2147483647", 1)).toBe(2_147_483_647);
    expect(parseTimeoutMs("2147483648", 1)).toBe(1); // above setTimeout's ceiling -> fallback
  });
});
