import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, type TransactionPartialSigner } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { openDb } from "@moneyswitch/db";
import { createMoneyKey, listHistoryForKey, usedTotal } from "@moneyswitch/core";
import { LocalWalletDriver, WalletError } from "@moneyswitch/wallet";
import { performPaidFetch } from "../src/client.js";
import { SOLANA_DEVNET } from "../src/networks.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function svmFixture() {
  vi.stubEnv("MONEYSWITCH_NETWORKS", SOLANA_DEVNET.caip2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-payment-lifecycle-"));
  const { db, sqlite } = openDb({ filePath: ":memory:" });
  const wallet = new LocalWalletDriver(dir, { protect: false, scrypt: { N: 32 } });
  await wallet.createWithPhrase();
  const sponsor = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const key = createMoneyKey(db, { name: "lifecycle", totalBudget: 100000n, dailyBudget: 100000n,
    perRequestLimit: 10000n, allowedHosts: ["seller.example:443"], networkMode: "testnet" }).row;
  const controls = { failMintRpc: false, paidCalls: 0, stallRetryBlockhash: false, stalledRpcCalls: 0,
    deadlineStatuses: [] as string[], deadlineBudget: null as bigint | null };
  let paidDeadlineSignal: AbortSignal | undefined;
  let innerSigner: TransactionPartialSigner;
  const signTransactions = vi.fn<TransactionPartialSigner["signTransactions"]>((transactions, config) => innerSigner.signTransactions(transactions, config));
  const realLease = wallet.leaseSvmSigner.bind(wallet);
  vi.spyOn(wallet, "leaseSvmSigner").mockImplementation(() => {
    const lease = realLease();
    if (!lease) return null;
    innerSigner = lease.signer;
    return { ...lease, signer: { address: lease.signer.address, signTransactions } };
  });
  const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === new URL(SOLANA_DEVNET.rpcUrl).href) {
      const rpc = JSON.parse(await request.text());
      if (rpc.method === "getAccountInfo") {
        if (controls.failMintRpc) throw new TypeError("RPC transport failed before signing");
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { context: { slot: 1 }, value: {
          data: [mintData.toString("base64"), "base64"], executable: false, lamports: 1,
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 1, space: 82,
        } } });
      }
      if (rpc.method === "getLatestBlockhash") {
        if (controls.stallRetryBlockhash && controls.paidCalls > 0) {
          controls.stalledRpcCalls++;
          // Registered after the construction abort listener: catch/markUnknown
          // must not hide a transient failed row that briefly releases budget.
          paidDeadlineSignal!.addEventListener("abort", () => {
            controls.deadlineStatuses = listHistoryForKey(db, key.id).map((row) => row.status);
            controls.deadlineBudget = usedTotal(db, key.id);
          }, { once: true });
          return new Promise<Response>(() => {});
        }
        return Response.json({ jsonrpc: "2.0", id: rpc.id,
          result: { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } } });
      }
      throw new Error("Unexpected test RPC");
    }
    expect(request.url).toBe("https://seller.example/item");
    if (request.headers.has("payment-signature") || request.headers.has("x-payment")) {
      controls.paidCalls++;
      paidDeadlineSignal = init?.signal ?? request.signal;
      return Response.json({ delivered: true });
    }
    const required = { x402Version: 2, resource: { url: request.url, mimeType: "application/json" }, accepts: [{
      scheme: "exact", network: SOLANA_DEVNET.caip2, amount: "10000", asset: SOLANA_DEVNET.usdcAddress,
      payTo: sponsor.address, maxTimeoutSeconds: 60, extra: { feePayer: sponsor.address },
    }] };
    return Response.json(required, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) } });
  }));
  return {
    db, sqlite, wallet, key, controls, signTransactions,
    pay: () => performPaidFetch(db, sqlite, key, wallet, { url: "https://seller.example/item", host: "seller.example:443",
      method: "GET", network: SOLANA_DEVNET.caip2, purpose: "payment construction regression" }),
    close: () => { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("payment construction failure classification", () => {
  it("releases the Solana reservation when mint RPC fails before any signer or paid request", async () => {
    const fixture = await svmFixture();
    try {
      fixture.controls.failMintRpc = true;
      await expect(fixture.pay()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(fixture.signTransactions).not.toHaveBeenCalled();
      expect(fixture.controls.paidCalls).toBe(0);
      expect(fixture.wallet.inFlight).toBe(0);
      expect(listHistoryForKey(fixture.db, fixture.key.id)).toMatchObject([{ status: "failed", errorCode: "UPSTREAM_ERROR",
        svmEvidence: null, purpose: "payment construction regression" }]);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(0n);
    } finally { fixture.close(); }
  });

  it("keeps the budget and reports maybe when a real signature precedes an evidence write failure", async () => {
    const fixture = await svmFixture();
    try {
      fixture.sqlite.exec("CREATE TEMP TRIGGER deny_svm_evidence BEFORE UPDATE OF svm_evidence ON payments BEGIN SELECT RAISE(FAIL, 'simulated evidence write failure'); END");
      const result = await fixture.pay();
      expect(result).toMatchObject({ charged: "maybe", httpStatus: 0, paymentUnknown: { code: "UPSTREAM_ERROR_AFTER_PAYMENT" } });
      expect(result.paymentUnknown?.detail).toContain("simulated evidence write failure");
      expect(fixture.signTransactions).toHaveBeenCalledTimes(1);
      expect(fixture.controls.paidCalls).toBe(0);
      expect(fixture.wallet.inFlight).toBe(0);
      expect(listHistoryForKey(fixture.db, fixture.key.id)).toMatchObject([{ status: "unknown", errorCode: "UPSTREAM_ERROR_AFTER_PAYMENT", svmEvidence: null }]);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(10000n);
    } finally { fixture.close(); }
  });

  it("keeps both reservations when SDK creation recovery refuses a second signature before the after-creation hook ever completed", async () => {
    const fixture = await svmFixture();
    try {
      fixture.sqlite.exec("CREATE TEMP TRIGGER deny_svm_evidence BEFORE UPDATE OF svm_evidence ON payments BEGIN SELECT RAISE(FAIL, 'simulated evidence write failure'); END");
      const registerAfterCreation = x402Client.prototype.onAfterPaymentCreation;
      vi.spyOn(x402Client.prototype, "onAfterPaymentCreation").mockImplementation(function (hook) {
        let recoveryStarted = false;
        this.onPaymentCreationFailure(async (context) => {
          if (recoveryStarted) return;
          recoveryStarted = true;
          return { recovered: true, payload: await this.createPaymentPayload(context.paymentRequired) };
        });
        return registerAfterCreation.call(this, hook);
      });
      const realSign = fixture.signTransactions.getMockImplementation()!;
      fixture.signTransactions.mockImplementationOnce(realSign)
        .mockRejectedValueOnce(new WalletError("WALLET_CHANGED", "wallet changed during SDK creation recovery"));
      const result = await fixture.pay();
      expect(result).toMatchObject({ charged: "maybe", httpStatus: 0, paymentUnknown: { code: "UPSTREAM_ERROR_AFTER_PAYMENT" } });
      expect(fixture.signTransactions).toHaveBeenCalledTimes(2);
      expect(fixture.controls.paidCalls).toBe(0);
      expect(fixture.wallet.inFlight).toBe(0);
      const history = listHistoryForKey(fixture.db, fixture.key.id);
      expect(history).toHaveLength(2);
      expect(history.some((row) => row.status === "failed")).toBe(false);
      expect(history.some((row) => row.status === "unknown" && row.errorCode === "UPSTREAM_ERROR_AFTER_PAYMENT")).toBe(true);
      expect(history.every((row) => row.svmEvidence === null)).toBe(true);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(20000n);
    } finally { fixture.close(); }
  });

  it("does not release either reservation when SDK recovery's second signer call refuses after an earlier paid request", async () => {
    const fixture = await svmFixture();
    try {
      vi.spyOn(x402HTTPClient.prototype, "processPaymentResult").mockResolvedValueOnce({ recovered: true });
      const realSign = fixture.signTransactions.getMockImplementation()!;
      fixture.signTransactions.mockImplementationOnce(realSign)
        .mockRejectedValueOnce(new WalletError("WALLET_CHANGED", "wallet changed before retry signing"));
      const result = await fixture.pay();
      expect(result).toMatchObject({ charged: "maybe", httpStatus: 0, paymentUnknown: { code: "UPSTREAM_ERROR_AFTER_PAYMENT" } });
      expect(fixture.signTransactions).toHaveBeenCalledTimes(2);
      expect(fixture.controls.paidCalls).toBe(1);
      expect(fixture.wallet.inFlight).toBe(0);
      const history = listHistoryForKey(fixture.db, fixture.key.id);
      expect(history).toHaveLength(2);
      expect(history.some((row) => row.status === "failed")).toBe(false);
      expect(history.some((row) => row.status === "unknown" && row.errorCode === "UPSTREAM_ERROR_AFTER_PAYMENT")).toBe(true);
      expect(history.some((row) => row.svmEvidence !== null)).toBe(true);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(20000n);
    } finally { fixture.close(); }
  });

  it("keeps prior risk budgets when SDK recovery stalls at blockhash RPC until the paid deadline", async () => {
    const fixture = await svmFixture();
    try {
      vi.stubEnv("MONEYSWITCH_PROBE_TIMEOUT_MS", "1000");
      vi.stubEnv("MONEYSWITCH_PAID_TIMEOUT_MS", "250");
      fixture.controls.stallRetryBlockhash = true;
      vi.spyOn(x402HTTPClient.prototype, "processPaymentResult").mockResolvedValueOnce({ recovered: true });
      const result = await fixture.pay();
      expect(result).toMatchObject({ charged: "maybe", httpStatus: 0, paymentUnknown: { code: "TIMEOUT_AFTER_PAYMENT" } });
      expect(fixture.controls.stalledRpcCalls).toBe(1);
      expect(fixture.controls.paidCalls).toBe(1);
      expect(fixture.controls.deadlineStatuses).toHaveLength(2);
      expect(fixture.controls.deadlineStatuses).not.toContain("failed");
      expect(fixture.controls.deadlineBudget).toBe(20000n);
      expect(fixture.signTransactions).toHaveBeenCalledTimes(1);
      expect(fixture.wallet.inFlight).toBe(0);
      const history = listHistoryForKey(fixture.db, fixture.key.id);
      expect(history).toHaveLength(2);
      expect(history.some((row) => row.status === "failed")).toBe(false);
      expect(history.some((row) => row.status === "unknown" && row.errorCode === "TIMEOUT_AFTER_PAYMENT")).toBe(true);
      expect(history.some((row) => row.svmEvidence !== null)).toBe(true);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(20000n);
    } finally { fixture.close(); }
  });

  it("releases a first cancelled construction whose late local signature cannot reach an after-creation hook or paid HTTP", async () => {
    const fixture = await svmFixture();
    let finishSigning!: () => void;
    const signingGate = new Promise<void>((resolve) => { finishSigning = resolve; });
    try {
      vi.stubEnv("MONEYSWITCH_PROBE_TIMEOUT_MS", "100");
      let localSignatureCreated = false;
      let afterCreationCalls = 0;
      const registerAfterCreation = x402Client.prototype.onAfterPaymentCreation;
      vi.spyOn(x402Client.prototype, "onAfterPaymentCreation").mockImplementation(function (hook) {
        return registerAfterCreation.call(this, async (context) => { afterCreationCalls++; await hook(context); });
      });
      const realSign = fixture.signTransactions.getMockImplementation()!;
      fixture.signTransactions.mockImplementationOnce(async (transactions, config) => {
        const signatures = await realSign(transactions, config);
        localSignatureCreated = true;
        await signingGate;
        return signatures;
      });
      await expect(fixture.pay()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(localSignatureCreated).toBe(true);
      expect(fixture.wallet.inFlight).toBe(0);
      finishSigning();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(afterCreationCalls).toBe(0);
      expect(fixture.controls.paidCalls).toBe(0);
      expect(listHistoryForKey(fixture.db, fixture.key.id)).toMatchObject([{ status: "failed", errorCode: "ABORTED_BEFORE_SEND", svmEvidence: null }]);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(0n);
    } finally { finishSigning(); fixture.close(); }
  });

  it("still releases a first signer call definitively refused before signing", async () => {
    const fixture = await svmFixture();
    try {
      fixture.signTransactions.mockRejectedValueOnce(new WalletError("WALLET_CHANGED", "wallet changed before signing"));
      await expect(fixture.pay()).rejects.toMatchObject({ code: "WALLET_LOCKED" });
      expect(fixture.controls.paidCalls).toBe(0);
      expect(fixture.wallet.inFlight).toBe(0);
      expect(listHistoryForKey(fixture.db, fixture.key.id)).toMatchObject([{ status: "failed", errorCode: "WALLET_CHANGED", svmEvidence: null }]);
      expect(usedTotal(fixture.db, fixture.key.id)).toBe(0n);
    } finally { fixture.close(); }
  });
});
