import { describe, it, expect } from "vitest";
import { SetupTokenStore, SETUP_TOKEN_PREFIX } from "../src/index.js";

describe("SetupTokenStore (first-run setup link)", () => {
  it("is inactive until issued", () => {
    const s = new SetupTokenStore();
    expect(s.isActive()).toBe(false);
    expect(s.claim("ms_setup_whatever")).toEqual({ ok: false, reason: "SETUP_INACTIVE" });
  });

  it("issues a prefixed high-entropy token and hands over the admin token exactly once", () => {
    const s = new SetupTokenStore();
    const token = s.issue("ms_admin_abc");
    expect(token.startsWith(SETUP_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBe(SETUP_TOKEN_PREFIX.length + 32);
    expect(s.isActive()).toBe(true);
    expect(s.claim(token)).toEqual({ ok: true, adminToken: "ms_admin_abc" });
    expect(s.isActive()).toBe(false);
    expect(s.claim(token)).toEqual({ ok: false, reason: "SETUP_USED" });
  });

  it("rejects wrong / non-string candidates without consuming the token", () => {
    const s = new SetupTokenStore();
    const token = s.issue("ms_admin_abc");
    expect(s.claim("ms_setup_wrong")).toEqual({ ok: false, reason: "SETUP_INVALID" });
    expect(s.claim(undefined)).toEqual({ ok: false, reason: "SETUP_INVALID" });
    expect(s.claim({ token })).toEqual({ ok: false, reason: "SETUP_INVALID" });
    expect(s.claim(token).ok).toBe(true);
  });

  it("expires after ttl", () => {
    let t = 1_000;
    const s = new SetupTokenStore({ ttlMs: 500, now: () => t });
    const token = s.issue("ms_admin_abc");
    t = 1_501;
    expect(s.isActive()).toBe(false);
    expect(s.claim(token).ok).toBe(false);
  });

  it("expired claim reports SETUP_EXPIRED", () => {
    let t = 0;
    const s = new SetupTokenStore({ ttlMs: 10, now: () => t });
    const token = s.issue("ms_admin_abc");
    t = 11;
    expect(s.claim(token)).toEqual({ ok: false, reason: "SETUP_EXPIRED" });
  });

  it("burns itself after too many failed attempts, even for the right token afterwards", () => {
    const s = new SetupTokenStore({ maxFailedAttempts: 3 });
    const token = s.issue("ms_admin_abc");
    s.claim("x");
    s.claim("y");
    expect(s.isActive()).toBe(true);
    s.claim("z");
    expect(s.isActive()).toBe(false);
    expect(s.claim(token).ok).toBe(false);
  });
});
