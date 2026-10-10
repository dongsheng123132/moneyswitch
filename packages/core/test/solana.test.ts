import { describe, it, expect, vi } from "vitest";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { evaluateAndReserve } from "../src/policy.js";
import { getPayment, recordSvmPaymentEvidence, sweepStaleReservations } from "../src/payments.js";
import { usedTotal } from "../src/ledger.js";
import { reconcileUnknownPayments } from "../src/reconcile.js";
import { createApproval, decideApproval, validateApprovalForUse } from "../src/approval.js";

const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const asset = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const evidence = { transaction: "signed-public-transaction", payer: "Payer", payerSignature: "payer-partial-signature", messageHash: "sha256", blockhash: "recent-blockhash" };

describe("Solana ledger safeguards", () => {
  it("preserves a signed SVM reservation through restart, RPC errors and no-match; settles only proven matches", async () => {
    const { db, sqlite } = freshDb();
    try {
      const key = createMoneyKey(db, { name: "svm", totalBudget: 100n, dailyBudget: 100n, perRequestLimit: 100n, allowedHosts: ["api.example:443"] }).row;
      const { paymentId } = evaluateAndReserve(db, key, { url: "https://api.example/item", host: "api.example:443", method: "GET", network, asset, payTo: "Recipient", amount: 10n });
      recordSvmPaymentEvidence(db, paymentId, evidence);
      expect(sweepStaleReservations(db, "2099-01-01T00:00:00Z").toUnknown).toContain(paymentId);
      expect(getPayment(db, paymentId)?.authNonce).toBeNull();
      expect(usedTotal(db, key.id)).toBe(10n);
      const reader = { authorizationState: vi.fn(async () => false), findAuthorizationUsedTx: vi.fn(async () => null), readSvmPayment: vi.fn(async () => ({ status: "pending" as const })) };
      await reconcileUnknownPayments({ db, reader });
      expect(getPayment(db, paymentId)?.status).toBe("unknown");
      reader.readSvmPayment.mockRejectedValueOnce(new Error("RPC unavailable"));
      expect((await reconcileUnknownPayments({ db, reader })).rpcErrors).toBe(1);
      expect(usedTotal(db, key.id)).toBe(10n);
      const settled = { ...reader, readSvmPayment: async () => ({ status: "settled" as const, txHash: "full-fee-payer-signature" }) };
      expect((await reconcileUnknownPayments({ db, reader: settled })).settledWithTx).toBe(1);
      expect(getPayment(db, paymentId)?.txHash).toBe("full-fee-payer-signature");
      expect(reader.authorizationState).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });

  it("releases quota for a proven execution failure and keeps its full chain transaction id", async () => {
    const { db, sqlite } = freshDb();
    try {
      const key = createMoneyKey(db, { name: "svm", totalBudget: 100n, dailyBudget: 100n, perRequestLimit: 100n, allowedHosts: ["api.example:443"] }).row;
      const { paymentId } = evaluateAndReserve(db, key, { url: "https://api.example/item", host: "api.example:443", method: "GET", network, asset, payTo: "Recipient", amount: 10n });
      recordSvmPaymentEvidence(db, paymentId, evidence);
      sweepStaleReservations(db, "2099-01-01T00:00:00Z");
      const reader = { authorizationState: async () => false, findAuthorizationUsedTx: async () => null, readSvmPayment: async () => ({ status: "failed" as const, txHash: "failed-full-transaction-id" }) };
      expect((await reconcileUnknownPayments({ db, reader })).failed).toBe(1);
      expect(usedTotal(db, key.id)).toBe(0n);
      expect(getPayment(db, paymentId)).toMatchObject({ status: "failed", errorCode: "SOLANA_TRANSACTION_FAILED", txHash: "failed-full-transaction-id" });
    } finally { sqlite.close(); }
  });

  it("binds Solana approvals to case-sensitive mint and recipient", () => {
    const { db, sqlite } = freshDb();
    try {
      const ctx = { keyId: "key", url: "https://api.example/item", method: "GET", body: undefined, network, asset, payTo: "Recipient", amount: 10n };
      const approval = createApproval(db, ctx); decideApproval(db, approval.id, "approved");
      expect(validateApprovalForUse(db, approval.id, ctx).id).toBe(approval.id);
      expect(() => validateApprovalForUse(db, approval.id, { ...ctx, asset: asset.toLowerCase() })).toThrow("APPROVAL_INVALID");
      expect(() => validateApprovalForUse(db, approval.id, { ...ctx, payTo: "recipient" })).toThrow("APPROVAL_INVALID");
    } finally { sqlite.close(); }
  });
});
