import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver } from "../src/index.js";
import { Wallet as EthersWallet } from "ethers";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("LocalWalletDriver", () => {
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
