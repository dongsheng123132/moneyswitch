#!/usr/bin/env node
// Isolated development harness: local in-process seller, real Devnet RPC.
// No public HTTP seller/facilitator or production deployment is claimed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createPublicKey, verify } from "node:crypto";
import { LocalWalletDriver } from "../packages/wallet/dist/index.js";
import { openDb } from "../packages/db/dist/index.js";
import { createMoneyKey, getMoneyKeyById, listHistoryForKey, reconcilePaymentToSettled, usedTotal } from "../packages/core/dist/index.js";
import { SOLANA_DEVNET, performPaidFetch, readSvmPayment } from "../packages/x402/dist/index.js";
import { installOutboundProxy, closeOutboundProxy } from "../packages/net/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = path.join(root, ".data", "solana-live");
const requireSvm = createRequire(path.join(root, "packages/x402/package.json"));
const kit = requireSvm("@solana/kit");
const token = createRequire(requireSvm.resolve("@x402/svm"))("@solana-program/token");
const { encodePaymentRequiredHeader, decodePaymentSignatureHeader } = requireSvm("@x402/core/http");
const command = process.argv[2] ?? "--status";
if (!["--prepare", "--status", "--pay"].includes(command)) throw Error("Use --prepare, --status or --pay");
// Pin the network and RPC; this harness cannot switch to mainnet through env.
process.env.MONEYSWITCH_NETWORKS = SOLANA_DEVNET.caip2;
process.env.MONEYSWITCH_SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com";
if (SOLANA_DEVNET.rpcUrl !== "https://api.devnet.solana.com") throw Error("Unset custom Solana RPC before running this isolated harness");
installOutboundProxy();
const originalFetch = globalThis.fetch;
async function rpc(method, params) {
  const response = await originalFetch("https://api.devnet.solana.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000), redirect: "error",
  });
  if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !("result" in body)) throw Error(`RPC ${method} failed`);
  return body.result;
}
const publicOut = (value) => console.log(JSON.stringify(value, null, 2));
let sqlite;
try {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const wallets = {};
  for (const name of ["payer", "sponsor"]) {
    const wallet = new LocalWalletDriver(path.join(dataDir, name));
    if (!wallet.hasKeystore()) {
      if (command !== "--prepare") throw Error("Run --prepare first");
      await wallet.createWithPhrase(); // Never print or write the returned phrase.
    } else if (!(await wallet.unlockOnStartup()).unlocked) throw Error("Demo wallet is locked");
    wallets[name] = wallet;
  }
  const payer = wallets.payer.getSolanaAddress();
  const sponsor = wallets.sponsor.getSolanaAddress();
  if (!payer || !sponsor || payer === sponsor) throw Error("Independent mnemonic wallets required");
  publicOut({ network: SOLANA_DEVNET.caip2, payer, sponsor, mint: SOLANA_DEVNET.usdcAddress });
  if (command !== "--prepare") {
    const balance = await wallets.payer.getSolanaUsdcBalanceOf(payer, "https://api.devnet.solana.com", SOLANA_DEVNET.usdcAddress);
    const gas = (await rpc("getBalance", [sponsor, { commitment: "confirmed" }])).value;
    publicOut({ payerUsdcMicros: String(balance), sponsorLamports: gas });
    if (command === "--pay") {
      if (await rpc("getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw Error("RPC is not Solana Devnet");
      if (balance < 10000n || gas < 3000000) throw Error("Fund payer ATA with Devnet USDC and sponsor with at least 0.003 Devnet SOL first");
      const opened = openDb({ filePath: path.join(dataDir, "demo.sqlite") });
      sqlite = opened.sqlite;
      const db = opened.db;
      const keyFile = path.join(dataDir, "demo-key-id.txt");
      const key = fs.existsSync(keyFile) ? getMoneyKeyById(db, fs.readFileSync(keyFile, "utf8")) : createMoneyKey(db, {
        name: "isolated-solana-demo", totalBudget: 10000n, dailyBudget: 10000n,
        perRequestLimit: 10000n, allowedHosts: ["solana-demo.example:443"], networkMode: "testnet",
      }).row;
      if (!key) throw Error("Demo key missing; inspect saved ledger before restarting");
      fs.writeFileSync(keyFile, key.id, { mode: 0o600 });
      let prior = listHistoryForKey(db, key.id, 20);
      if (prior.length) {
        publicOut({ existingPayment: prior[0].status, txHash: prior[0].txHash, usedMicros: String(usedTotal(db, key.id)) });
        if (prior[0].status === "unknown") {
          const outcome = await readSvmPayment(SOLANA_DEVNET, prior[0]);
          if (outcome.status === "settled") reconcilePaymentToSettled(db, prior[0].id, outcome.txHash, new Date().toISOString());
          publicOut(outcome);
        }
        throw Error("Existing payment preserved. This harness will not automatically pay again");
      }
      const lease = wallets.sponsor.leaseSvmSigner();
      if (!lease) throw Error("Sponsor locked");
      try {
        const signer = lease.signer;
        const block = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
        const ataIx = await token.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, mint: kit.address(SOLANA_DEVNET.usdcAddress), owner: kit.address(sponsor) });
        let message = kit.createTransactionMessage({ version: 0 });
        message = kit.setTransactionMessageFeePayerSigner(signer, message);
        message = kit.setTransactionMessageLifetimeUsingBlockhash({ ...block, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) }, message);
        message = kit.appendTransactionMessageInstruction(ataIx, message);
        const ataTx = await kit.partiallySignTransactionMessageWithSigners(message);
        const ataHash = await rpc("sendTransaction", [kit.getBase64EncodedWireTransaction(ataTx), { encoding: "base64", preflightCommitment: "confirmed" }]);
        publicOut({ recipientAtaTransaction: ataHash });
        const deadline = Date.now() + 60000;
        while (true) {
          const status = (await rpc("getSignatureStatuses", [[ataHash], { searchTransactionHistory: true }])).value[0];
          if (status?.err) throw Error("Recipient ATA creation failed");
          if (["confirmed", "finalized"].includes(status?.confirmationStatus)) break;
          if (Date.now() > deadline) throw Error("Recipient ATA not confirmed; no payment attempted");
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        const url = "https://solana-demo.example/item";
        const requirement = { scheme: "exact", network: SOLANA_DEVNET.caip2, amount: "10000", asset: SOLANA_DEVNET.usdcAddress, payTo: sponsor, maxTimeoutSeconds: 60, extra: { feePayer: sponsor } };
        const required = { x402Version: 2, resource: { url, description: "Local Devnet demo seller", mimeType: "application/json" }, accepts: [requirement] };
        let fullHash;
        globalThis.fetch = async (input, init) => {
          const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (target !== url) return originalFetch(input, init);
          const header = new Headers(init?.headers ?? input.headers).get("payment-signature");
          if (!header) return Response.json(required, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } });
          const payload = decodePaymentSignatureHeader(header);
          const row = listHistoryForKey(db, key.id, 1)[0];
          if (row?.svmEvidence?.transaction !== payload.payload.transaction) throw Error("Signed evidence not persisted");
          const tx = kit.getTransactionDecoder().decode(kit.getBase64Encoder().encode(payload.payload.transaction));
          const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(kit.getBase58Encoder().encode(payer))]), format: "der", type: "spki" });
          if (!verify(null, Uint8Array.from(tx.messageBytes), publicKey, Uint8Array.from(tx.signatures[kit.address(payer)]))) throw Error("Invalid payer signature");
          const [signatures] = await signer.signTransactions([tx]);
          fullHash = await rpc("sendTransaction", [kit.getBase64EncodedWireTransaction({ ...tx, signatures: { ...tx.signatures, ...signatures } }), { encoding: "base64", preflightCommitment: "confirmed" }]);
          // Deliberately lose the receipt: demonstrate recovery through real chain evidence.
          return Response.json({ delivered: true, localDemoSeller: true });
        };
        await performPaidFetch(db, sqlite, key, wallets.payer, { url, host: "solana-demo.example:443", method: "GET" });
        globalThis.fetch = originalFetch;
        const row = listHistoryForKey(db, key.id, 1)[0];
        publicOut({ ledgerStatus: row.status, txHash: fullHash ?? null, usedMicros: String(usedTotal(db, key.id)) });
        const recoveryDeadline = Date.now() + 60000;
        let outcome;
        do {
          outcome = await readSvmPayment(SOLANA_DEVNET, row);
          if (outcome.status !== "pending") break;
          await new Promise(resolve => setTimeout(resolve, 1500));
        } while (Date.now() < recoveryDeadline);
        if (outcome.status !== "settled") throw Error("Settlement unconfirmed. Keep the ledger; do not retry payment");
        reconcilePaymentToSettled(db, row.id, outcome.txHash, new Date().toISOString());
        publicOut({ ...outcome, amountUsdc: "0.01", explorer: `https://explorer.solana.com/tx/${outcome.txHash}?cluster=devnet`, usedMicros: String(usedTotal(db, key.id)) });
      } finally { lease.release(); }
    }
  }
} catch (error) {
  // No raw SDK payload or secrets are logged.
  console.error(error instanceof Error ? error.message : "Demo failed");
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  sqlite?.close();
  await closeOutboundProxy();
}
