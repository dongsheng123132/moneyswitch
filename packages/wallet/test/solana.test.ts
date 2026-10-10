import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { address, compileTransaction, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, getBase58Encoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { LocalWalletDriver } from "../src/index.js";

describe("Solana wallet boundary", () => {
  it("derives a separate stable address; a lease blocks replacement and refuses signing after release", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-svm-"));
    try {
      const wallet = new LocalWalletDriver(dir, { protect: false, scrypt: { N: 32 }, drainTimeoutMs: 5 });
      await wallet.createWithPhrase();
      const owner = wallet.getSolanaAddress()!;
      expect(owner).not.toBe(wallet.getAddress());
      expect(owner).not.toMatch(/^0x/);
      const lease = wallet.leaseSvmSigner()!;
      expect(lease.signer.address).toBe(owner);
      let message = setTransactionMessageFeePayer(address(owner), createTransactionMessage({ version: 0 }));
      const tx = compileTransaction(setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 100n }, message));
      const [signatures] = await lease.signer.signTransactions([tx as never]);
      const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(getBase58Encoder().encode(owner))]), format: "der", type: "spki" });
      expect(verify(null, Uint8Array.from(tx.messageBytes), publicKey, Uint8Array.from(signatures[address(owner)]!))).toBe(true);
      await expect(wallet.replaceWallet()).rejects.toMatchObject({ code: "WALLET_BUSY" });
      lease.release(); lease.release();
      expect(wallet.inFlight).toBe(0);
      await expect(lease.signer.signTransactions([tx as never])).rejects.toMatchObject({ code: "WALLET_CHANGED" });
      const restarted = new LocalWalletDriver(dir, { protect: false, scrypt: { N: 32 } });
      expect(restarted.getSolanaAddress()).toBeNull();
      await restarted.unlockOnStartup();
      expect(restarted.getSolanaAddress()).toBe(owner);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads only the spendable associated token account, ignoring balances in other token accounts", async () => {
    const owner = address("11111111111111111111111111111111");
    const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const program = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const [ata] = await getProgramDerivedAddress({ programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(program), getAddressEncoder().encode(mint)] });
    const account = (pubkey: string, amount: string) => ({ pubkey, account: { owner: program, data: { parsed: { info: { owner, mint, tokenAmount: { decimals: 6, amount } } } } } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { value: [account("other", "999999"), account(ata, "12345")] } })));
    try {
      const wallet = new LocalWalletDriver();
      expect(await wallet.getSolanaUsdcBalanceOf(owner, "https://rpc.example/", mint)).toBe(12345n);
    } finally { vi.unstubAllGlobals(); }
  });
});
