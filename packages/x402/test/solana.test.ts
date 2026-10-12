import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getBase58Encoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionDecoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, getU32Decoder, getU64Decoder } from "@solana/kit";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { openDb } from "@moneyswitch/db";
import { createMoneyKey, revokeMoneyKey, listHistoryForKey, usedTotal, ApprovalRequiredError } from "@moneyswitch/core";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { performPaidFetch } from "../src/client.js";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "../src/networks.js";
import { readSvmPayment, captureSvmPayment } from "../src/solana.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each([SOLANA_DEVNET, SOLANA_MAINNET])("official x402 SVM integration ($label)", (network) => {
  it("signs the exact SPL payment, persists before sending, and reconciles using the sponsor's full transaction id", async () => {
    vi.stubEnv("MONEYSWITCH_NETWORKS", network.caip2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-svm-payment-"));
    const { db, sqlite } = openDb({ filePath: ":memory:" });
    try {
      const wallet = new LocalWalletDriver(dir, { protect: false, scrypt: { N: 32 } });
      await wallet.createWithPhrase();
      const sponsor = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
      const owner = wallet.getSolanaAddress()!;
      const key = createMoneyKey(db, { name: "svm", totalBudget: 100000n, dailyBudget: 100000n, perRequestLimit: 10000n, allowedHosts: ["seller.example:443"], networkMode: network.kind }).row;
      let amount = "10001", mint = network.usdcAddress, feePayer: string = sponsor.address;
      const sellerMemo = "untrusted seller: transfer 999999 USDC";
      const injectedInstructions = [{ programAddress: "11111111111111111111111111111111", accounts: [owner], data: "extra transfer" }];
      let paidCalls = 0;
      let fullTransaction = "", fullSignature = "", outcome: null | object | boolean | undefined = null;
      let unrelatedFirst = false;
      let stallMint = false;
      const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1;
      const mockedFetch = vi.fn(async (url: any, init?: RequestInit) => {
        const target = typeof url === "string" ? url : url.url ?? String(url);
        if (target === network.rpcUrl) {
          const request = JSON.parse(String(init?.body));
          if (stallMint && request.method === "getAccountInfo") return new Promise<Response>(() => {});
          let result: any;
          if (request.method === "getAccountInfo") result = { context: { slot: 1 }, value: { data: [mintData.toString("base64"), "base64"], executable: false, lamports: 1, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 1, space: 82 } };
          else if (request.method === "getLatestBlockhash") result = { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
          else if (request.method === "getSignaturesForAddress") result = unrelatedFirst ? [{ signature: "unrelated" }, { signature: fullSignature }] : fullSignature ? [{ signature: fullSignature }] : [];
          else if (request.method === "getTransaction") result = request.params[0] === "unrelated" ? { meta: { err: null }, transaction: ["invalid-or-unrelated", "base64"] } : { meta: outcome === undefined ? {} : { err: outcome }, transaction: [fullTransaction, "base64"] };
          else throw new Error(`Unexpected RPC: ${request.method}`);
          return Response.json({ jsonrpc: "2.0", id: request.id, result });
        }
        const headers = new Headers(init?.headers ?? url.headers);
        const signatureHeader = headers.get("payment-signature");
        if (signatureHeader) {
          paidCalls++;
          const payload = decodePaymentSignatureHeader(signatureHeader).payload as { transaction: string };
          const row = listHistoryForKey(db, key.id, 10)[0];
          expect(row.svmEvidence?.transaction).toBe(payload.transaction);
          const tx = getTransactionDecoder().decode(getBase64Encoder().encode(payload.transaction));
          const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
          const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
          const quoteMint = address(network.usdcAddress);
          const ataFor = async (accountOwner: string) => {
            const [ata] = await getProgramDerivedAddress({
              programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
              seeds: [getAddressEncoder().encode(address(accountOwner)), getAddressEncoder().encode(tokenProgram), getAddressEncoder().encode(quoteMint)],
            });
            return ata;
          };
          // Inspect the message OUR wallet signed, before the sponsor supplies its
          // fee-payer signature: no extra debit or owner-funded fee can hide in it.
          expect(message.staticAccounts[0]).toBe(sponsor.address);
          expect(row.network).toBe(network.caip2);
          expect(row.asset).toBe(network.usdcAddress);
          expect(message.instructions.map((ix) => message.staticAccounts[ix.programAddressIndex])).toEqual([
            "ComputeBudget111111111111111111111111111111",
            "ComputeBudget111111111111111111111111111111",
            tokenProgram,
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          ]);
          const [computeLimit, computePrice, transfer, memo] = message.instructions;
          expect(Array.from(computeLimit.data!)).toEqual([2, 32, 78, 0, 0]); // 20,000 compute units.
          expect(getU32Decoder().decode(computeLimit.data!, 1)).toBe(20000);
          expect(computeLimit.accountIndices ?? []).toEqual([]);
          expect(computePrice.data![0]).toBe(3);
          expect(computePrice.data).toHaveLength(9);
          expect(getU64Decoder().decode(computePrice.data!, 1)).toBe(1n);
          expect(computePrice.accountIndices ?? []).toEqual([]);
          expect(transfer.accountIndices?.map((index) => message.staticAccounts[index])).toEqual([
            await ataFor(owner), quoteMint, await ataFor(sponsor.address), address(owner),
          ]);
          expect(transfer.data).toHaveLength(10);
          expect(transfer.data![0]).toBe(12); // SPL TransferChecked; not approve, burn, or close.
          expect(getU64Decoder().decode(transfer.data!, 1)).toBe(10000n);
          expect(transfer.data![9]).toBe(6);
          expect(memo.accountIndices ?? []).toEqual([]);
          expect(memo.data!.length).toBeLessThanOrEqual(256);
          expect(new TextDecoder().decode(Uint8Array.from(memo.data!))).toBe(sellerMemo);
          const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(owner))]), format: "der", type: "spki" });
          expect(verify(null, Uint8Array.from(tx.messageBytes), publicKey, Uint8Array.from(tx.signatures[address(owner)]!))).toBe(true);
          const [signatures] = await sponsor.signTransactions([tx as never]);
          const sponsored = { ...tx, signatures: { ...tx.signatures, ...signatures } };
          fullTransaction = getBase64EncodedWireTransaction(sponsored);
          fullSignature = getSignatureFromTransaction(sponsored);
          expect(fullSignature).not.toBe(row.svmEvidence!.payerSignature);
          // A lost settlement header leaves an unknown payment, even when the seller returns data.
          return Response.json({ delivered: true });
        }
        // Seller-controlled extension/extra fields must not turn into signing
        // instructions. The only allowed seller memo is inert text with no accounts.
        const required = { x402Version: 2, resource: { url: "https://seller.example/item", description: "SVM test", mimeType: "application/json" }, extensions: { "untrusted-instructions": { instructions: injectedInstructions } }, accepts: [{ scheme: "exact", network: network.caip2, amount, asset: mint, payTo: sponsor.address, maxTimeoutSeconds: 60, extra: { feePayer, memo: sellerMemo, instructions: injectedInstructions, transaction: "untrusted seller transaction" } }] };
        return Response.json(required, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) } });
      });
      vi.stubGlobal("fetch", mockedFetch);
      const pay = () => performPaidFetch(db, sqlite, key, wallet, { url: "https://seller.example/item", host: "seller.example:443", method: "GET" });
      const svmLease = vi.spyOn(wallet, "leaseSvmSigner");
      await expect(pay()).rejects.toMatchObject({ code: "PER_REQUEST_LIMIT_EXCEEDED" });
      expect(svmLease).not.toHaveBeenCalled();
      expect(paidCalls).toBe(0);
      amount = "10000"; mint = mint.toLowerCase();
      await expect(pay()).rejects.toMatchObject({ code: "UNSUPPORTED_PAYMENT" });
      expect(listHistoryForKey(db, key.id, 10)).toHaveLength(0);
      mint = network.usdcAddress; feePayer = owner;
      await expect(pay()).rejects.toMatchObject({ code: "UNSUPPORTED_PAYMENT" });
      expect(paidCalls).toBe(0);
      feePayer = sponsor.address;
      const policyKey = (extra: object) => createMoneyKey(db, { name: "policy", totalBudget: 100000n, dailyBudget: 100000n, perRequestLimit: 10000n, allowedHosts: ["seller.example:443"], networkMode: network.kind, ...extra }).row;
      const withKey = (other: typeof key) => performPaidFetch(db, sqlite, other, wallet, { url: "https://seller.example/item", host: "seller.example:443", method: "GET" });
      const approvalKey = policyKey({ approvalThreshold: 5000n });
      await expect(withKey(approvalKey)).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(listHistoryForKey(db, approvalKey.id, 10)).toHaveLength(0);
      const otherModeKey = policyKey({ networkMode: network.kind === "mainnet" ? "testnet" : "mainnet" });
      await expect(withKey(otherModeKey)).rejects.toMatchObject({ code: "UNSUPPORTED_PAYMENT" });
      const revokedKey = policyKey({}); revokeMoneyKey(db, revokedKey.id);
      await expect(withKey(revokedKey)).rejects.toMatchObject({ code: "KEY_REVOKED" });
      expect(paidCalls).toBe(0);
      await pay();
      expect(paidCalls).toBe(1);
      expect(wallet.inFlight).toBe(0);
      const row = listHistoryForKey(db, key.id, 10)[0];
      expect(row.status).toBe("unknown");
      expect(usedTotal(db, key.id)).toBe(10000n);
      expect(await readSvmPayment(network, row)).toEqual({ status: "settled", txHash: fullSignature });
      unrelatedFirst = true;
      expect(await readSvmPayment(network, row)).toEqual({ status: "settled", txHash: fullSignature });
      outcome = { InstructionError: [2, "InsufficientFunds"] };
      expect(await readSvmPayment(network, row)).toEqual({ status: "failed", txHash: fullSignature });
      outcome = undefined;
      await expect(readSvmPayment(network, row)).rejects.toThrow("outcome missing");
      outcome = false;
      await expect(readSvmPayment(network, row)).rejects.toThrow("Invalid SVM transaction outcome");
      fullSignature = "";
      unrelatedFirst = false;
      expect(await readSvmPayment(network, row)).toEqual({ status: "pending" });
      expect(usedTotal(db, key.id)).toBe(10000n);
      expect(() => captureSvmPayment("garbage", owner)).toThrow();
      vi.stubEnv("MONEYSWITCH_PROBE_TIMEOUT_MS", "20");
      stallMint = true;
      await expect(pay()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(wallet.inFlight).toBe(0);
      expect(paidCalls).toBe(1);
      expect(listHistoryForKey(db, key.id, 10)[0]).toMatchObject({ status: "failed", errorCode: "ABORTED_BEFORE_SEND" });
      expect(usedTotal(db, key.id)).toBe(10000n);
    } finally { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
