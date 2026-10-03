import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver } from "../src/index.js";
import { Wallet as EthersWallet } from "ethers";

// These tests use the production scrypt cost (N=2^17) on purpose; under a loaded CI machine a few of them take seconds.
vi.setConfig({ testTimeout: 60_000 });

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LocalWalletDriver", () => {
  it("reads balances through the shared fetch transport and rejects RPC errors as unknown", async () => {
    const driver = new LocalWalletDriver(tmpDir);
    const { address } = await driver.createWallet("balance-test-password");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (520000n).toString(16).padStart(64, "0") })));
    vi.stubGlobal("fetch", request);
    expect(await driver.getUsdcBalance("https://rpc.example.test", address)).toBe(520000n);
    const sent = JSON.parse(request.mock.calls[0][1].body);
    expect(sent.method).toBe("eth_call");
    expect(sent.params[0].data.toLowerCase()).toBe("0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0"));
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -1 } })));
    await expect(driver.getUsdcBalance("https://rpc.example.test", address)).rejects.toThrow("Invalid USDC balance");
  });
  it("imports a private key, backs it up, and restores the same address with a new password", async () => {
    const original = EthersWallet.createRandom();
    const driver = new LocalWalletDriver(tmpDir);
    await driver.importWallet({ kind: "private_key", private_key: original.privateKey }, "first-password");
    const backup = driver.exportKeystore();
    expect(backup).not.toContain(original.privateKey.slice(2));
    driver.lock();
    expect(driver.exportKeystore()).toBe(backup);
    const restored = new LocalWalletDriver(path.join(tmpDir, "restored"));
    await restored.importWallet({ kind: "keystore", keystore: backup, source_password: "first-password" }, "new-password");
    expect(restored.getAddress()).toBe(original.address);
    restored.lock();
    await expect(restored.unlock("first-password")).rejects.toThrow();
    await expect(restored.unlock("new-password")).resolves.toEqual({ address: original.address });
  });

  it("failed imports create no wallet and cannot overwrite an existing wallet", async () => {
    const driver = new LocalWalletDriver(tmpDir);
    const badKey = "SECRET-invalid-private-key";
    await expect(driver.importWallet({ kind: "private_key", private_key: badKey }, "new-password")).rejects.toThrow("Invalid wallet import");
    expect(driver.hasKeystore()).toBe(false);
    const { address } = await driver.createWallet("original-password");
    const backup = driver.exportKeystore();
    const restored = new LocalWalletDriver(path.join(tmpDir, "bad-restore"));
    await expect(restored.importWallet({ kind: "keystore", keystore: backup, source_password: "wrong-password" }, "new-password")).rejects.toThrow("Invalid wallet import");
    expect(restored.hasKeystore()).toBe(false);
    await expect(driver.importWallet({ kind: "private_key", private_key: EthersWallet.createRandom().privateKey }, "new-password")).rejects.toThrow("already exists");
    expect(driver.getAddress()).toBe(address);
    expect(driver.exportKeystore()).toBe(backup);
  });

  it("concurrent creates publish only one complete wallet", async () => {
    const a = new LocalWalletDriver(tmpDir);
    const b = new LocalWalletDriver(tmpDir);
    const results = await Promise.allSettled([a.createWallet("race-password"), b.createWallet("race-password")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{ address: string }>;
    const restored = new LocalWalletDriver(tmpDir);
    expect(await restored.unlock("race-password")).toEqual(winner.value);
    expect(fs.readdirSync(tmpDir)).toEqual(["wallet.json"]);
  });

  it("rejects backups with unbounded KDF work before decryption", async () => {
    const driver = new LocalWalletDriver(tmpDir);
    const backup = JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", kdf: "scrypt", kdfparams: { n: 2 ** 30, p: 1, r: 8 } } });
    await expect(driver.importWallet({ kind: "keystore", keystore: backup, source_password: "password" }, "new-password")).rejects.toThrow("Invalid wallet import");
    expect(driver.hasKeystore()).toBe(false);
  });

  it("creates a keystore, locks by default state, unlocks with correct password", async () => {
    const driver = new LocalWalletDriver(tmpDir);
    expect(driver.hasKeystore()).toBe(false);
    const { address } = await driver.createWallet("correct horse battery staple");
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fs.existsSync(driver.keystorePath)).toBe(true);

    // Fresh driver instance simulating process restart: locked until unlocked.
    const driver2 = new LocalWalletDriver(tmpDir);
    expect(driver2.isUnlocked()).toBe(false);
    expect(driver2.getSigner()).toBeNull();
    const unlocked = await driver2.unlock("correct horse battery staple");
    expect(unlocked.address).toBe(address);
    expect(driver2.isUnlocked()).toBe(true);
    expect(driver2.getSigner()?.address).toBe(address);
  });

  it("rejects unlocking with the wrong password", async () => {
    const driver = new LocalWalletDriver(tmpDir);
    await driver.createWallet("right-password");
    const driver2 = new LocalWalletDriver(tmpDir);
    await expect(driver2.unlock("wrong-password")).rejects.toThrow();
  });

  it("signTypedData produces a valid signature recoverable to the wallet address", async () => {
    const { verifyTypedData } = await import("ethers");
    const driver = new LocalWalletDriver(tmpDir);
    const { address } = await driver.createWallet("pw");
    const signer = driver.getSigner()!;
    const domain = { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const message = {
      from: address,
      to: EthersWallet.createRandom().address,
      value: 10000n,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce: "0x" + "11".repeat(32),
    };
    const sig = await signer.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });
    const recovered = verifyTypedData(domain, types, message, sig);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });
});
