// The recovery path for an auto-unlock wallet that was retired by "Replace wallet" (docs/wallet-setup.md): its keystore is a standard
// Web3 Secret Storage v3 file, and the content of the matching unlock-secret file is the keystore PASSWORD, so a wallet app can open
// it ("Import account" -> "JSON File" in MetaMask). MetaMask reads such a file with ethereumjs-wallet's fromV3(input, password,
// nonStrict = true): the JSON text is lower-cased first, then scrypt (or pbkdf2) -> aes-128-ctr -> a keccak MAC. This test
// re-implements exactly that reader from the specification with node:crypto (ethers only supplies keccak256) and checks that it
// recovers the private key of the retired wallet. It does not start MetaMask itself.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDecipheriv, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HDNodeWallet, computeAddress, keccak256 } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "../src/index.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-v3-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Production scrypt cost (the driver's own default), no OS-level ACL work. */
const drv = () => new LocalWalletDriver(tmpDir, { protect: false });

/** A standards-compliant V3 reader, as MetaMask's ethereumjs-wallet uses it (nonStrict: the whole text is lower-cased before parsing). */
function privateKeyFromV3(fileText: string, password: string): string {
  const json = JSON.parse(fileText.toLowerCase());
  expect(json.version).toBe(3);
  const crypto = json.crypto ?? json.Crypto;
  expect(crypto.cipher).toBe("aes-128-ctr");
  expect(crypto.kdf).toBe("scrypt");
  const { dklen, n, p, r, salt } = crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password, "utf8"), Buffer.from(salt, "hex"), dklen, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  const ciphertext = Buffer.from(crypto.ciphertext, "hex");
  if (keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2) !== crypto.mac) throw new Error("Key derivation failed - possibly wrong passphrase");
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(crypto.cipherparams.iv, "hex"));
  return "0x" + Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("hex");
}

describe("an auto-unlock keystore is a standard V3 file whose password is the content of its secret file", () => {
  it("the live wallet.json opens with the content of wallet-unlock-<address>.secret, exactly as the file holds it (64 hex characters, nothing else)", async () => {
    const created = await drv().createWithPhrase();
    const secretText = fs.readFileSync(unlockSecretPath(tmpDir, created.address), "utf-8");
    expect(secretText, "nothing but the 64 hex characters: no newline, no spaces to trip over when pasting").toMatch(/^[0-9a-f]{64}$/);
    const key = privateKeyFromV3(fs.readFileSync(walletFilePath(tmpDir), "utf-8"), secretText);
    expect(key).toBe(HDNodeWallet.fromPhrase(created.mnemonic).privateKey);
    expect(computeAddress(key)).toBe(created.address);
  });

  it("after Replace wallet the RETIRED pair recovers the old wallet's key the same way; the new wallet's secret does not open it", async () => {
    const driver = drv();
    const old = await driver.createWithPhrase();
    const replaced = await driver.replaceWallet();
    const retiredKeystore = fs.readFileSync(path.join(tmpDir, "retired", replaced.retired.keystoreFile), "utf-8");
    const retiredSecret = fs.readFileSync(path.join(tmpDir, "retired", replaced.retired.secretFile!), "utf-8");
    expect(retiredSecret).toMatch(/^[0-9a-f]{64}$/);

    const key = privateKeyFromV3(retiredKeystore, retiredSecret);
    expect(key).toBe(HDNodeWallet.fromPhrase(old.mnemonic).privateKey);
    expect(computeAddress(key)).toBe(old.address);

    const newSecret = fs.readFileSync(unlockSecretPath(tmpDir, replaced.address), "utf-8");
    expect(() => privateKeyFromV3(retiredKeystore, newSecret)).toThrow(/wrong passphrase/);
    // and the other way round: the retired secret says nothing about the new wallet
    expect(() => privateKeyFromV3(fs.readFileSync(walletFilePath(tmpDir), "utf-8"), retiredSecret)).toThrow(/wrong passphrase/);
  });
});
