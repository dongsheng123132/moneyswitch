/**
 * Human-readable explanations for the two "we paid but did not get the answer"
 * outcomes of performPaidFetch (packages/x402/src/client.ts), used by the /v1/fetch
 * envelope (routes/agent.ts): you may have been charged, and a retry would pay again.
 */

/** A payment was signed and sent, then the response was lost (deadline or transport error). */
export function paymentUnknownReason(code: string, amount: string, detail: string): string {
  const what =
    code === "TIMEOUT_AFTER_PAYMENT"
      ? "the seller did not finish answering before the deadline"
      : "the request failed after the payment was sent";
  return (
    `A payment of ${amount} USDC was signed and sent, but ${what} (${detail}). ` +
    `The seller may still settle it, so you may have been charged. ` +
    `Do NOT retry automatically: a retry would sign and pay again. ` +
    `The amount stays reserved against this key's budget until it is reconciled on-chain ` +
    `(see GET /v1/history: status "unknown" becomes "settled" or "failed"), or ask the key owner.`
  );
}

/** Settlement was confirmed from the response headers, but the body could not be read completely. */
export function bodyIncompleteReason(amount: string, txHash: string | null, detail: string): string {
  return (
    `The payment of ${amount} USDC was settled${txHash ? ` (tx ${txHash})` : ""}, but the seller's response body ` +
    `could not be read completely (${detail}). You HAVE been charged. ` +
    `Do NOT retry automatically: a retry would pay again. Contact the seller with the tx hash if you need the content.`
  );
}
