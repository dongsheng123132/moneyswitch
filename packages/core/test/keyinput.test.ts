import { describe, it, expect } from "vitest";
import {
  parseKeyFields,
  parseKeyAmount,
  parseKeyAllowedHosts,
  isAllowedHostEntry,
  assertOwnLimits,
} from "../src/keyinput.js";
import { DelegationError } from "../src/types.js";

/**
 * The one reading of a key-creation body (shared by POST /v1/keys and
 * POST /v1/keys/children). Two things this module deliberately does not do
 * are asserted below, because both were live bugs while the rules were
 * duplicated: an omitted allowed_hosts must stay omitted (a child inherits
 * its parent's list), and the parent-bound answer must win over the
 * key's-own-limits one.
 */

const BODY = {
  name: "agent",
  total_budget: "10",
  daily_budget: "1",
  per_request_limit: "0.5",
  allowed_hosts: ["example.com:443"],
};

describe("parseKeyFields: the fields both creation routes share", () => {
  it("a valid body is read into trimmed, typed values", () => {
    expect(parseKeyFields({ ...BODY, name: "  spaced  ", allowed_hosts: ["  example.com:443  "] })).toMatchObject({
      name: "spaced",
      totalBudget: 10_000_000n,
      dailyBudget: 1_000_000n,
      perRequestLimit: 500_000n,
      allowedHosts: ["example.com:443"],
      canDelegate: false,
      expiresAt: null,
    });
  });

  it("an omitted allowed_hosts stays omitted: a child inherits its parent's, a root key gets none", () => {
    expect(parseKeyFields({ ...BODY, allowed_hosts: undefined }).allowedHosts).toBeUndefined();
    expect(parseKeyFields(BODY).allowedHosts).toEqual(["example.com:443"]);
    // an explicit empty list is not an omission: it means "every site asks"
    expect(parseKeyFields({ ...BODY, allowed_hosts: [] }).allowedHosts).toEqual([]);
  });

  it("approval_threshold is optional: omitted means null, not 0", () => {
    expect(parseKeyFields(BODY).approvalThreshold).toBeNull();
    expect(parseKeyFields({ ...BODY, approval_threshold: "0.2" }).approvalThreshold).toBe(200_000n);
  });

  it("every missing or malformed field names itself, in the order the API lists them", () => {
    // A body of {} is a distinct case: it has no name at all. (The other cases
    // start from a valid body, so {} is passed as the whole body, not an override.)
    for (const [body, field] of [[{}, "name"]] as const) {
      let err: DelegationError | null = null;
      try {
        parseKeyFields(body);
      } catch (e) {
        err = e instanceof DelegationError ? e : null;
      }
      expect(err).toBeInstanceOf(DelegationError);
      expect(err!.field).toBe(field);
    }
    for (const [over, field] of [
      [{ name: "" }, "name"],
      [{ name: "   " }, "name"],
      [{ name: 42 }, "name"],
      [{ name: "x".repeat(201) }, "name"],
      [{ total_budget: undefined }, "total_budget"],
      [{ total_budget: null }, "total_budget"],
      [{ daily_budget: "" }, "daily_budget"],
      [{ per_request_limit: "abc" }, "per_request_limit"],
      [{ per_request_limit: "-1" }, "per_request_limit"],
      [{ approval_threshold: "x" }, "approval_threshold"],
      [{ allowed_hosts: "example.com:443" }, "allowed_hosts"],
      [{ allowed_hosts: [42] }, "allowed_hosts"],
      [{ allowed_hosts: [""] }, "allowed_hosts"],
      [{ allowed_hosts: ["https://example.com"] }, "allowed_hosts"],
      [{ allowed_hosts: ["example.com/v1"] }, "allowed_hosts"],
      [{ max_payments_per_minute: 0 }, "max_payments_per_minute"],
      [{ max_payments_per_minute: 1.5 }, "max_payments_per_minute"],
      [{ max_payments_per_minute: "10" }, "max_payments_per_minute"],
      [{ expires_at: 42 }, "expires_at"],
      [{ expires_at: "soon" }, "expires_at"],
      [{ can_delegate: "yes" }, "can_delegate"],
    ] as const) {
      let err: DelegationError | null = null;
      try {
        parseKeyFields({ ...BODY, ...(over as Record<string, unknown>) });
      } catch (e) {
        err = e instanceof DelegationError ? e : null;
      }
      expect(err, JSON.stringify(over)).toBeInstanceOf(DelegationError);
      expect(err!.code, JSON.stringify(over)).toBe("INVALID_REQUEST");
      expect(err!.field, JSON.stringify(over)).toBe(field);
      expect(err!.httpStatus, JSON.stringify(over)).toBe(400);
    }
  });

  it("amounts are accepted as finite numbers too (the API caller's convenience, not the Dashboard's)", () => {
    expect(parseKeyFields({ ...BODY, total_budget: 10, daily_budget: 1, per_request_limit: 0.5 })).toMatchObject({
      totalBudget: 10_000_000n,
      perRequestLimit: 500_000n,
    });
    // but an unrepresentable number is refused, not rounded
    expect(() => parseKeyAmount(Infinity, "total_budget", true)).toThrow(DelegationError);
    expect(() => parseKeyAmount(NaN, "total_budget", true)).toThrow(DelegationError);
  });

  it("a negative amount is refused: -1 would otherwise be read as a magnitude of 1", () => {
    for (const field of ["total_budget", "daily_budget", "per_request_limit", "approval_threshold"] as const) {
      let err: DelegationError | null = null;
      try {
        parseKeyAmount("-1", field, true);
      } catch (e) {
        err = e instanceof DelegationError ? e : null;
      }
      expect(err, field).toBeInstanceOf(DelegationError);
      expect(err!.field, field).toBe(field);
    }
  });
});

describe("isAllowedHostEntry: only what the gate can ever match", () => {
  it("host and host:port are allowed, including the trailing dot and IPv6 the gate compares", () => {
    for (const ok of [
      "example.com",
      "example.com:443",
      "example.com.",
      "example.com.:443",
      "API.test:8443",
      "127.0.0.1",
      "127.0.0.1:4020",
      "100.100.100.200:80",
      "[::1]",
      "[::1]:8080",
      "localhost",
    ]) {
      expect(isAllowedHostEntry(ok), ok).toBe(true);
    }
  });

  it("a scheme, a path, userinfo, whitespace or a bad port is refused: none can ever match a URL's host", () => {
    for (const bad of [
      "https://example.com",
      "http://example.com:443",
      "example.com/v1",
      "example.com:443/path",
      "//example.com",
      "user@example.com",
      "example.com:0",
      "example.com:65536",
      "example.com:80a",
      "example com",
      "example.com :443",
      "",
      "   ",
      "[::1",
      "ex ample.com",
    ]) {
      expect(isAllowedHostEntry(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a single label is a host too (localhost is, and a key for a local service lists it)", () => {
    for (const ok of ["localhost", "localhost:4020", "svc.localhost:8080"]) {
      expect(isAllowedHostEntry(ok), ok).toBe(true);
    }
  });

  it("parseKeyAllowedHosts trims, and keeps an entry's case and dot as typed (the gate normalizes)", () => {
    expect(parseKeyAllowedHosts(["  example.com.:443  ", "API.test"])).toEqual(["example.com.:443", "API.test"]);
  });
});

describe("assertOwnLimits: a key's own limits must agree", () => {
  it("an approval_threshold above the per-request limit is refused: it could never fire", () => {
    expect(() => assertOwnLimits({ perRequestLimit: 500_000n, approvalThreshold: 600_000n })).toThrow(DelegationError);
    // at the limit, or with no threshold at all, it is fine
    expect(() => assertOwnLimits({ perRequestLimit: 500_000n, approvalThreshold: 500_000n })).not.toThrow();
    expect(() => assertOwnLimits({ perRequestLimit: 500_000n, approvalThreshold: null })).not.toThrow();
  });

  it("it is not part of parseKeyFields: the parent's bound decides first for a child", () => {
    // a child may carry a threshold above its own per-request limit when the
    // parent allows it; the answer then has to be CHILD_EXCEEDS_PARENT, which
    // is thrown by delegation.ts, not INVALID_REQUEST from the shared parser.
    expect(() =>
      parseKeyFields({ ...BODY, per_request_limit: "0.2", approval_threshold: "0.5" }).approvalThreshold
    ).not.toThrow();
  });
});
