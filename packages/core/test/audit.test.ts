import { describe, it, expect } from "vitest";
import { redact } from "../src/audit.js";
import { generateMoneyKey, generateAdminToken } from "../src/moneykey.js";

describe("redact", () => {
  it("truncates full MoneyKey and admin token strings wherever found", () => {
    const key = generateMoneyKey();
    const admin = generateAdminToken();
    const out = redact({ authHeader: `Bearer ${key}`, plain: key, admin, nested: { deeper: key } }) as any;
    expect(out.plain).not.toBe(key);
    expect(out.plain.startsWith(key.slice(0, 12))).toBe(true);
    expect(out.plain).not.toContain(key.slice(20));
    expect(out.nested.deeper).not.toBe(key);
  });

  it("redacts known sensitive field names regardless of value shape", () => {
    const out = redact({
      password: "hunter2",
      privateKey: "0xdeadbeef",
      keystorePassword: "pw",
      ok: "fine",
    }) as any;
    expect(out.password).toBe("[REDACTED]");
    expect(out.privateKey).toBe("[REDACTED]");
    expect(out.keystorePassword).toBe("[REDACTED]");
    expect(out.ok).toBe("fine");
  });
});
