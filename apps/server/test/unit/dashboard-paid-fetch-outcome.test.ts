import { describe, it, expect } from "vitest";
// The dashboard has no test runner of its own; its presentation rules live in a pure, import-free
// module that is tested here (nothing React/DOM is pulled in).
import { classifyPaidFetch, warnsAgainstResending, type PaidFetchEnvelopeLike } from "../../../dashboard/src/paidFetchOutcome.js";

type Env = PaidFetchEnvelopeLike;

const settled = { amount: "0.01", tx_hash: "0xabc", network: "eip155:10143", mock: false };
const unsettled = { amount: "0.01", tx_hash: null, network: "eip155:10143" };

describe("Playground paid-fetch outcome (what the panel may tell the user)", () => {
  it("payment_unknown (seller slow after payment) -> its own warning, never 'free' or 'didn't go through'", () => {
    const env: Env = { status: "payment_unknown", code: "TIMEOUT_AFTER_PAYMENT", charged: "maybe", payment: unsettled, http_status: null };
    expect(classifyPaidFetch(env)).toBe("payment_unknown");
    expect(warnsAgainstResending("payment_unknown")).toBe(true);
  });

  it("ok + charged maybe + no payment (200 without a settlement header) -> NOT 'free'", () => {
    const env: Env = { status: "ok", code: null, charged: "maybe", payment: null, http_status: 200 };
    expect(classifyPaidFetch(env)).toBe("charged_maybe");
    expect(warnsAgainstResending("charged_maybe")).toBe(true);
  });

  it("payment_failed + charged maybe (PAYMENT_REJECTED / settle not confirmed) -> NOT 'nothing was charged'", () => {
    const env: Env = { status: "payment_failed", code: "PAYMENT_REJECTED", charged: "maybe", payment: null, http_status: 402 };
    expect(classifyPaidFetch(env)).toBe("payment_rejected_maybe");
    expect(warnsAgainstResending("payment_rejected_maybe")).toBe(true);
  });

  it("payment_failed + charged no (failed before anything was signed) -> the 'nothing was charged' text is still right", () => {
    const env: Env = { status: "payment_failed", code: "PAYMENT_FAILED", charged: "no", payment: null, http_status: null };
    expect(classifyPaidFetch(env)).toBe("payment_failed");
    expect(warnsAgainstResending("payment_failed")).toBe(false);
  });

  it("UPSTREAM_BODY_INCOMPLETE (charged yes) -> its own outcome that shows the transaction, not a generic error", () => {
    const env: Env = { status: "error", code: "UPSTREAM_BODY_INCOMPLETE", charged: "yes", payment: settled, http_status: 200 };
    expect(classifyPaidFetch(env)).toBe("body_incomplete");
    expect(warnsAgainstResending("body_incomplete")).toBe(true);
  });

  it("other errors stay generic errors", () => {
    expect(classifyPaidFetch({ status: "error", code: "UPSTREAM_ERROR", charged: "no", payment: null, http_status: null })).toBe("error");
    expect(classifyPaidFetch({ status: "error", code: "WALLET_LOCKED", charged: "no", payment: null, http_status: null })).toBe("error");
  });

  it("unchanged outcomes: paid, free, upstream error without settlement, denied, approval", () => {
    expect(classifyPaidFetch({ status: "ok", code: null, charged: "yes", payment: settled, http_status: 200 })).toBe("paid");
    expect(classifyPaidFetch({ status: "ok", code: null, charged: "no", payment: null, http_status: 200 })).toBe("free");
    expect(classifyPaidFetch({ status: "ok", code: null, charged: "no", payment: null, http_status: 503 })).toBe("upstream_error");
    expect(classifyPaidFetch({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", payment: null, http_status: null })).toBe("denied");
    expect(classifyPaidFetch({ status: "approval_required", code: "APPROVAL_REQUIRED", charged: "no", payment: null, http_status: null })).toBe("approval_required");
    for (const o of ["paid", "free", "upstream_error", "denied", "approval_required", "error"] as const) {
      expect(warnsAgainstResending(o)).toBe(false);
    }
  });

  it("an older server without the `charged` field behaves exactly as before", () => {
    expect(classifyPaidFetch({ status: "ok", code: null, payment: settled, http_status: 200 })).toBe("paid");
    expect(classifyPaidFetch({ status: "ok", code: null, payment: null, http_status: 200 })).toBe("free");
    expect(classifyPaidFetch({ status: "payment_failed", code: "PAYMENT_REJECTED", payment: null, http_status: 402 })).toBe("payment_failed");
  });
});
