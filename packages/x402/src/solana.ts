import { createHash } from "node:crypto";
import { address, getBase58Decoder, getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import type { PaymentRow, SvmPaymentEvidence } from "@moneyswitch/core";
import type { NetworkConfig } from "./networks.js";

/** Fee payer signature (the tx id) may still be absent; record OUR signature, never invent a tx id. */
export function captureSvmPayment(transaction: unknown, payer: string): SvmPaymentEvidence {
  if (typeof transaction !== "string" || transaction.length > 1644) throw new Error("Invalid SVM payment transaction");
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signature = tx.signatures[address(payer)];
  if (!signature || signature.every((b) => b === 0)) throw new Error("SVM payer signature missing");
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return {
    transaction, payer,
    payerSignature: getBase58Decoder().decode(signature),
    messageHash: createHash("sha256").update(Uint8Array.from(tx.messageBytes)).digest("hex"),
    blockhash: message.lifetimeToken,
  };
}

/** Uses the server's fetch/proxy transport, bounded deadlines and finalized chain evidence. */
export async function readSvmPayment(network: NetworkConfig, payment: PaymentRow): Promise<{ status: "pending" | "settled" | "failed"; txHash?: string }> {
  if (!payment.svmEvidence) return { status: "pending" };
  const evidence = payment.svmEvidence;
  async function rpc(method: string, params: unknown[]): Promise<any> {
    const response = await fetch(network.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error("SVM reconciliation RPC failed");
    const body = await response.json() as any;
    if (body.error || !("result" in body)) throw new Error("Invalid SVM reconciliation response");
    return body.result;
  }
  async function check(txHash: string): Promise<{ status: "settled" | "failed"; txHash: string } | null> {
    const result = await rpc("getTransaction", [txHash, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
    if (!result || !result.meta || !Array.isArray(result.transaction) || result.transaction[1] !== "base64") return null;
    // An incoming or otherwise unrelated transaction may mention our address without our signature.
    let captured: SvmPaymentEvidence;
    try { captured = captureSvmPayment(result.transaction[0], evidence.payer); }
    catch { return null; }
    if (captured.messageHash !== evidence.messageHash || captured.payerSignature !== evidence.payerSignature) return null;
    // The confirmed full transaction id is its first (fee payer) signature, not the payer's partial signature.
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(result.transaction[0]));
    const firstSignature = Object.values(tx.signatures)[0];
    if (!firstSignature || getBase58Decoder().decode(firstSignature) !== txHash) return null;
    if (!("err" in result.meta) || result.meta.err === undefined) throw new Error("SVM transaction outcome missing");
    if (result.meta.err !== null && typeof result.meta.err !== "string" && (typeof result.meta.err !== "object" || Array.isArray(result.meta.err))) throw new Error("Invalid SVM transaction outcome");
    return { status: result.meta.err === null ? "settled" : "failed", txHash };
  }
  if (payment.txHash) {
    const outcome = await check(payment.txHash);
    if (outcome) return outcome;
  }
  // A bounded recent-history lookup finds a sponsored transaction without confusing the payer signature with the tx id.
  // No result, pruned history or expiration alone NEVER releases a reservation.
  const signatures = await rpc("getSignaturesForAddress", [evidence.payer, { commitment: "finalized", limit: 25 }]);
  if (!Array.isArray(signatures)) throw new Error("Invalid SVM signature history");
  for (const entry of signatures) {
    if (typeof entry.signature !== "string" || entry.signature === payment.txHash) continue;
    const outcome = await check(entry.signature);
    if (outcome) return outcome;
  }
  return { status: "pending" };
}
