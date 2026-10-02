import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

const KEY = "MONEYSWITCH_NOTIFY_INTERVAL_MS";
const saved = process.env[KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("MONEYSWITCH_NOTIFY_INTERVAL_MS", () => {
  it("defaults to 2500", () => {
    delete process.env[KEY];
    expect(loadConfig().notifyIntervalMs).toBe(2500);
  });

  it("accepts a positive number and 0 (= loop disabled)", () => {
    process.env[KEY] = "1000";
    expect(loadConfig().notifyIntervalMs).toBe(1000);
    process.env[KEY] = "0";
    expect(loadConfig().notifyIntervalMs).toBe(0);
  });

  it("falls back to the default for garbage, negatives and blanks", () => {
    for (const bad of ["abc", "-5", "", "   ", "NaN"]) {
      process.env[KEY] = bad;
      expect(loadConfig().notifyIntervalMs, JSON.stringify(bad)).toBe(2500);
    }
  });
});
