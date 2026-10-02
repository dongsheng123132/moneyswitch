/**
 * How the Playground should present a POST /v1/fetch envelope. Pure (no React,
 * no i18n) so the decision can be unit-tested; PaidFetchPanel only renders it.
 *
 * The rule that matters: `charged` — not `status` or the presence of `payment` —
 * decides whether the panel may say "nothing was charged". A user who is told
 * "free" or "didn't go through" for a call that may have settled will press
 * Send again and pay twice.
 */
export type PaidFetchOutcome =
  | "paid" //                 ok + a confirmed settlement
  | "free" //                 ok, nothing was charged
  | "upstream_error" //       ok-envelope carrying an HTTP >= 400 from the seller, nothing settled
  | "charged_maybe" //        ok-envelope, but a payment was sent and its settlement was not confirmed
  | "payment_unknown" //      payment signed and sent, the response was lost (do not resend)
  | "body_incomplete" //      settled, but the response body was cut off (charged, content lost)
  | "payment_rejected_maybe" // payment_failed after a signature was sent: the authorization may still settle
  | "payment_failed" //       payment_failed before anything was signed: nothing was charged
  | "denied"
  | "approval_required"
  | "error";

/** The slice of a POST /v1/fetch envelope (PaidFetchResponse in api.ts) the decision needs; kept local so this module has no imports. */
export interface PaidFetchEnvelopeLike {
  status: "ok" | "denied" | "approval_required" | "payment_failed" | "payment_unknown" | "error";
  code: string | null;
  /** Absent on servers older than the field: behaves as before. */
  charged?: "yes" | "no" | "maybe";
  payment: object | null;
  http_status: number | null;
}

export function classifyPaidFetch(r: PaidFetchEnvelopeLike): PaidFetchOutcome {
  switch (r.status) {
    case "payment_unknown":
      return "payment_unknown";
    case "denied":
      return "denied";
    case "approval_required":
      return "approval_required";
    case "payment_failed":
      return r.charged === "maybe" ? "payment_rejected_maybe" : "payment_failed";
    case "error":
      return r.code === "UPSTREAM_BODY_INCOMPLETE" ? "body_incomplete" : "error";
    case "ok":
      if (r.charged === "maybe") return "charged_maybe";
      if (r.payment) return "paid";
      return (r.http_status ?? 0) >= 400 ? "upstream_error" : "free";
    default:
      return "error";
  }
}

/** Outcomes where money may have left (or did leave) the wallet and sending the same request again can pay twice. */
export function warnsAgainstResending(o: PaidFetchOutcome): boolean {
  return o === "payment_unknown" || o === "body_incomplete" || o === "charged_maybe" || o === "payment_rejected_maybe";
}
