import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet as EthersWallet, HDNodeWallet } from "ethers";
import { LocalWalletDriver, WalletError, unlockSecretPath, walletFilePath, type WalletErrorCode } from "../src/index.js";
import { addressFromPhrase } from "./bip44.js";
import { writeLegacyPasswordWallet } from "./legacy.js";

// Test-only: a cheap scrypt keeps the suite fast, and no OS-level ACL work (that is exercised for real in
// protect.win32.test.ts / protect.posix.test.ts). Production costs are exercised in the dedicated test below.
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false } as const;
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ABANDON_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ABANDON_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

let tmpDir: string;
const drv = (dir = tmpDir) => new LocalWalletDriver(dir, FAST);
const files = (dir = tmpDir) => fs.readdirSync(dir).sort();
const read = (p: string) => fs.readFileSync(p, "utf-8");
/** The auto-unlock secret file of the wallet with this address (the name carries the address, lower case). */
const secretFile = (address: string, dir = tmpDir) => unlockSecretPath(dir, address);
const secretName = (address: string) => path.basename(unlockSecretPath("", address));
/** What a pristine unlockStatus looks like: nothing tried. */
const UNTRIED = { source: null, ok: null, attempts: [] };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-life-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject");
}
async function expectCode(promise: Promise<unknown>, code: WalletErrorCode) {
  const e = await rejection(promise);
  expect(e).toBeInstanceOf(WalletError);
  expect((e as WalletError).code).toBe(code);
}

/** Makes the n-th call (optionally only those matching `when`) of an fs function throw, calling through otherwise. */
function failNthCall(method: "renameSync" | "unlinkSync" | "copyFileSync" | "linkSync", n: number, when: (args: unknown[]) => boolean = () => true) {
  const real = fs[method] as (...args: unknown[]) => unknown;
  let calls = 0;
  return vi.spyOn(fs, method as "renameSync").mockImplementation(((...args: unknown[]) => {
    if (when(args) && ++calls === n) throw Object.assign(new Error("simulated I/O failure"), { code: "EIO" });
    return real(...args);
  }) as never);
}

describe("recovery phrase and standard derivation path", () => {
  it("the independent BIP-39/32/44 implementation reproduces the published test vectors", () => {
    expect(addressFromPhrase(HARDHAT_PHRASE)).toBe(HARDHAT_ADDRESS);
    expect(addressFromPhrase(ABANDON_PHRASE)).toBe(ABANDON_ADDRESS);
  });

  it("a created wallet has a 12-word phrase whose address MetaMask/OKX would show (independent derivation)", async () => {
    const created = await drv().createWithPhrase();
    const words = created.mnemonic.split(" ");
    expect(words).toHaveLength(12);
    expect(created.mnemonic).toBe(created.mnemonic.toLowerCase());
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(addressFromPhrase(created.mnemonic)).toBe(created.address);
  });

  it("two created wallets get different phrases", async () => {
    const a = await drv(path.join(tmpDir, "a")).createWithPhrase();
    const b = await drv(path.join(tmpDir, "b")).createWithPhrase();
    expect(a.mnemonic).not.toBe(b.mnemonic);
    expect(a.address).not.toBe(b.address);
  });

  it("the plaintext phrase and private key are not on disk anywhere, only inside the encrypted keystore", async () => {
    const driver = drv();
    const created = await driver.createWithPhrase();
    const privateKey = HDNodeWallet.fromPhrase(created.mnemonic).privateKey;
    const firstThree = created.mnemonic.split(" ").slice(0, 3).join(" ");
    for (const name of files()) {
      const content = read(path.join(tmpDir, name));
      for (const secret of [created.mnemonic, firstThree, privateKey, privateKey.slice(2)]) {
        expect(content, name).not.toContain(secret);
      }
    }
    expect(driver.keystoreHasRecoveryPhrase()).toBe(true);
  });

  it("the phrase is only returned once: after a restart the driver knows the wallet has one, and has no way to show it again", async () => {
    const created = await drv().createWithPhrase();
    const restarted = drv();
    await restarted.unlockOnStartup({});
    expect(restarted.keystoreHasRecoveryPhrase()).toBe(true);
    for (const gone of ["reveal", "checkRecoveryWords", "exportKeystore", "exportKeystoreWithPassword", "importFrom", "unlock", "lock", "enableAutoUnlock", "disableAutoUnlock"]) {
      expect(gone in LocalWalletDriver.prototype, gone).toBe(false);
    }
    expect(JSON.stringify(restarted.unlockStatus)).not.toContain(created.mnemonic);
  });
});

describe("auto-unlock secret", () => {
  it("is written next to the keystore under the wallet's own name (0600 where supported), never inside it, and unlocks a fresh process without any password", async () => {
    const created = await drv().createWithPhrase();
    expect(files()).toEqual([`wallet-unlock-${created.address.toLowerCase()}.secret`, "wallet.json"]);
    const secret = read(secretFile(created.address));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(read(walletFilePath(tmpDir))).not.toContain(secret);
    if (process.platform !== "win32") expect(fs.statSync(secretFile(created.address)).mode & 0o777).toBe(0o600);

    const restarted = drv();
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.unlockStatus).toEqual(UNTRIED);
    const report = await restarted.unlockOnStartup({ password: null });
    expect(report).toEqual({ unlocked: true, attempts: [{ source: "auto", ok: true }] });
    expect(restarted.isUnlocked()).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: true, attempts: [{ source: "auto", ok: true }] });
    // and it can really sign
    const lease = restarted.leaseSigner()!;
    const sig = await lease.signer.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping",
      message: { n: 1n },
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("every wallet gets its own random secret", async () => {
    const a = await drv(path.join(tmpDir, "a")).createWithPhrase();
    const b = await drv(path.join(tmpDir, "b")).createWithPhrase();
    expect(read(secretFile(a.address, path.join(tmpDir, "a")))).not.toBe(read(secretFile(b.address, path.join(tmpDir, "b"))));
  });

  it("an empty or whitespace-only configured password counts as unset: the secret file is used (the empty password file mounted by an old deployment)", async () => {
    const created = await drv().createWithPhrase();
    for (const configured of ["", "   ", "\n", undefined, null]) {
      const restarted = drv();
      const report = await restarted.unlockOnStartup({ password: configured as string | null | undefined });
      expect(report, JSON.stringify(configured)).toEqual({ unlocked: true, attempts: [{ source: "auto", ok: true }] });
      expect(restarted.getAddress()).toBe(created.address);
    }
  });

  it("a legacy password wallet with an empty configured password just stays locked and reports no attempt", async () => {
    await writeLegacyPasswordWallet(tmpDir, "manual-pass-1");
    const restarted = drv();
    expect(await restarted.unlockOnStartup({ password: "" })).toEqual({ unlocked: false, attempts: [] });
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.unlockStatus).toEqual(UNTRIED);
  });

  it("the configured password opens a legacy password wallet, and is reported as the source", async () => {
    await writeLegacyPasswordWallet(tmpDir, "manual-pass-1");
    const restarted = drv();
    const report = await restarted.unlockOnStartup({ password: "manual-pass-1" });
    expect(report).toEqual({ unlocked: true, attempts: [{ source: "env_or_file", ok: true }] });
    expect(restarted.unlockStatus).toEqual({ source: "env_or_file", ok: true, attempts: [{ source: "env_or_file", ok: true }] });
  });

  it("a stale configured password does not lock out a wallet whose secret works (it is reported as env_wrong, then the secret is tried)", async () => {
    await drv().createWithPhrase();
    const restarted = drv();
    const report = await restarted.unlockOnStartup({ password: "an-old-password" });
    expect(report.unlocked).toBe(true);
    const attempts = [
      { source: "env_or_file", ok: false, reason: "env_wrong" },
      { source: "auto", ok: true },
    ];
    expect(report.attempts).toEqual(attempts);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: true, attempts });
  });

  it("a wrong secret leaves the wallet locked and says so as secret_wrong (not as a wrong env password), without echoing any credential", async () => {
    const created = await drv().createWithPhrase();
    fs.writeFileSync(secretFile(created.address), "ab".repeat(32));
    const restarted = drv();
    const report = await restarted.unlockOnStartup({});
    const attempts = [{ source: "auto", ok: false, reason: "secret_wrong" }];
    expect(report).toEqual({ unlocked: false, attempts });
    expect(JSON.stringify(report)).not.toContain("abab");
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.leaseSigner()).toBeNull();
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: false, attempts });
  });

  it("a missing, empty or unreadable secret file is a failure with its own reason, never a silent manual mode", async () => {
    const created = await drv().createWithPhrase();
    const file = secretFile(created.address);
    const original = read(file);

    fs.rmSync(file);
    let restarted = drv();
    expect((await restarted.unlockOnStartup({})).attempts).toEqual([{ source: "auto", ok: false, reason: "secret_missing" }]);
    expect(restarted.protection()).toBe("auto"); // still an auto wallet, whose secret went missing

    fs.writeFileSync(file, "");
    restarted = drv();
    expect((await restarted.unlockOnStartup({})).attempts).toEqual([{ source: "auto", ok: false, reason: "secret_empty" }]);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: false, attempts: [{ source: "auto", ok: false, reason: "secret_empty" }] });

    fs.rmSync(file);
    fs.mkdirSync(file); // a directory where the file should be
    restarted = drv();
    expect((await restarted.unlockOnStartup({})).attempts).toEqual([{ source: "auto", ok: false, reason: "secret_unreadable" }]);

    fs.rmdirSync(file);
    fs.writeFileSync(file, original);
    restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
  });

  it("no keystore: nothing to unlock", async () => {
    expect(await drv().unlockOnStartup({ password: "whatever" })).toEqual({ unlocked: false, attempts: [] });
  });

  it("uses a light scrypt for the random secret (production parameters, real protection of the folder)", { timeout: 60_000 }, async () => {
    const auto = new LocalWalletDriver(path.join(tmpDir, "auto"));
    await auto.createWithPhrase();
    expect(JSON.parse(read(walletFilePath(path.join(tmpDir, "auto")))).Crypto.kdfparams.n).toBe(2 ** 14);
  });
});

describe("replace wallet", () => {
  it("auto wallet: old keystore AND secret are kept (never deleted) in retired/ under names with the old address and a timestamp; the new wallet is live", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const oldKeystore = read(walletFilePath(tmpDir));
    const oldSecret = read(secretFile(first.address));
    let hookSaw: { keystoreExists: boolean; walletJsonIsNew: boolean } | null = null;
    const guard = vi.fn();

    const result = await driver.replaceWallet({
      guard,
      onSwapped: (info) => {
        hookSaw = {
          keystoreExists: fs.existsSync(path.join(tmpDir, "retired", info.keystoreFile)),
          walletJsonIsNew: read(walletFilePath(tmpDir)) !== oldKeystore,
        };
      },
    });

    expect(guard).toHaveBeenCalledWith({ oldAddress: first.address, newAddress: result.address });
    expect(hookSaw).toEqual({ keystoreExists: true, walletJsonIsNew: true });
    expect(result.address).not.toBe(first.address);
    expect(result.mnemonic.split(" ")).toHaveLength(12);
    expect(addressFromPhrase(result.mnemonic)).toBe(result.address);
    expect(result.retired.address).toBe(first.address);

    const retired = fs.readdirSync(path.join(tmpDir, "retired")).sort();
    expect(retired).toEqual([result.retired.secretFile, result.retired.keystoreFile].sort());
    expect(result.retired.keystoreFile).toMatch(new RegExp(`^wallet-${first.address.toLowerCase()}-\\d{8}T\\d{9}Z\\.json$`));
    expect(result.retired.secretFile).toMatch(new RegExp(`^wallet-unlock-${first.address.toLowerCase()}-\\d{8}T\\d{9}Z\\.secret$`));
    expect(read(path.join(tmpDir, "retired", result.retired.keystoreFile))).toBe(oldKeystore);
    expect(read(path.join(tmpDir, "retired", result.retired.secretFile!))).toBe(oldSecret);
    // the retired pair still opens the OLD wallet
    const old = await EthersWallet.fromEncryptedJson(oldKeystore, oldSecret);
    expect(old.address).toBe(first.address);

    // the new wallet is live, auto, and survives a restart
    expect(driver.getAddress()).toBe(result.address);
    expect(driver.unlockStatus).toEqual({ source: "auto", ok: true, attempts: [{ source: "auto", ok: true }] });
    expect(read(secretFile(result.address))).not.toBe(oldSecret);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(result.address);
    // the live directory holds only the NEW pair; the old secret lives on in retired/ only
    expect(files()).toEqual(["retired", secretName(result.address), "wallet.json"]);
  });

  it("works while the old wallet is LOCKED and its password is lost (the whole point)", async () => {
    await writeLegacyPasswordWallet(tmpDir, "the lost password");
    const locked = drv();
    expect(locked.isUnlocked()).toBe(false);
    const oldAddress = locked.getAddress()!;
    const result = await locked.replaceWallet();
    expect(result.retired.address).toBe(oldAddress);
    expect(result.retired.secretFile).toBeNull();
    expect(fs.readdirSync(path.join(tmpDir, "retired"))).toEqual([result.retired.keystoreFile]);
    // the old keystore still opens with the old password if it is ever found again
    const old = await EthersWallet.fromEncryptedJson(read(path.join(tmpDir, "retired", result.retired.keystoreFile)), "the lost password");
    expect(old.address).toBe(oldAddress);
    expect(locked.isUnlocked()).toBe(true);
    expect(locked.getAddress()).toBe(result.address);
    expect(locked.protection()).toBe("auto");
  });

  it("with nothing to replace it says so", async () => {
    await expectCode(drv().replaceWallet(), "NO_WALLET");
  });

  it("guard() can veto (a payment is in flight): no file is touched and no retired/ directory appears", async () => {
    const driver = drv();
    await driver.createWithPhrase();
    const before = files();
    const keystore = read(walletFilePath(tmpDir));
    class Busy extends Error {}
    const e = await rejection(driver.replaceWallet({ guard: () => { throw new Busy("busy"); } }));
    expect(e).toBeInstanceOf(Busy);
    expect(files()).toEqual(before);
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(driver.isUnlocked()).toBe(true);
  });

  it("if onSwapped() throws (the database refused), the swap is rolled back and the error is passed through unchanged", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const keystore = read(walletFilePath(tmpDir));
    const secret = read(secretFile(first.address));
    const boom = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const e = await rejection(driver.replaceWallet({ onSwapped: () => { throw boom; } }));
    expect(e).toBe(boom);
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(read(secretFile(first.address))).toBe(secret);
    expect(files()).toEqual([secretName(first.address), "wallet.json"]); // no retired/, no temp files, no stray new secret
    expect(driver.getAddress()).toBe(first.address);
    expect(driver.unlockStatus).toEqual({ source: "auto", ok: true, attempts: [{ source: "auto", ok: true }] });
  });

  it.each([
    // the old files are COPIED into retired/ (copyFileSync, no rename), so the renames are: 1 new secret in, 2 new keystore over wallet.json
    ["installing the new secret", 1],
    ["swapping in the new keystore", 2],
  ])("a file-system failure half-way (%s) leaves the old pair live and the retired/ copies removed", async (_where, nthRename) => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const keystore = read(walletFilePath(tmpDir));
    const secret = read(secretFile(first.address));
    failNthCall("renameSync", nthRename);
    await expectCode(driver.replaceWallet(), "STORAGE_FAILED");
    vi.restoreAllMocks();
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(read(secretFile(first.address))).toBe(secret);
    expect(files()).toEqual([secretName(first.address), "wallet.json"]);
    expect(driver.getAddress()).toBe(first.address);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(first.address);
  });
});

describe("a wallet.json written by an earlier release", () => {
  it("(created with a password, no marker) is a password wallet that carries its recovery phrase: it opens with the startup password only", async () => {
    const old = await writeLegacyPasswordWallet(tmpDir, "legacy password 1", { marker: false });
    const driver = drv();
    expect(driver.protection()).toBe("password");
    expect(driver.keystoreHasRecoveryPhrase()).toBe(true);
    expect(driver.hasUnlockSecret()).toBe(false);
    expect(await driver.unlockOnStartup({})).toEqual({ unlocked: false, attempts: [] });
    expect(driver.getAddress()).toBe(old.address); // the address is readable while it is locked
    const restarted = drv();
    expect((await restarted.unlockOnStartup({ password: "legacy password 1" })).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(old.address);
  });

  it("(imported from a bare private key) has no phrase to back up", async () => {
    const key = EthersWallet.createRandom();
    await writeLegacyPasswordWallet(tmpDir, "legacy password 2", { wallet: new EthersWallet(key.privateKey) });
    expect(drv().keystoreHasRecoveryPhrase()).toBe(false);
  });
});

describe("creation stays exclusive and complete", () => {
  it("auto creation publishes the secret and the keystore exactly once, even when two creates race", async () => {
    const a = drv();
    const b = drv();
    const results = await Promise.allSettled([a.createWithPhrase(), b.createWithPhrase()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ address: string }>).value;
    expect(files()).toEqual([secretName(winner.address), "wallet.json"]);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(winner.address);
  });

  it("a stray secret left behind without a keystore is never trusted and never destroyed: the new wallet gets its own secret under its own name, and startup moves the stray one to retired/", async () => {
    const stray = EthersWallet.createRandom().address;
    fs.writeFileSync(secretFile(stray), "12".repeat(32));
    const created = await drv().createWithPhrase();
    expect(read(secretFile(stray))).toBe("12".repeat(32));
    expect(read(secretFile(created.address))).not.toBe("12".repeat(32));
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
    expect(files()).toEqual(["retired", secretName(created.address), "wallet.json"]);
    const retired = fs.readdirSync(path.join(tmpDir, "retired"));
    expect(retired).toHaveLength(1);
    expect(read(path.join(tmpDir, "retired", retired[0]))).toBe("12".repeat(32));
  });

  it("create refuses to overwrite an existing wallet and leaves its files untouched", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const before = files().map((f) => [f, read(path.join(tmpDir, f))]);
    await expectCode(driver.createWithPhrase(), "WALLET_EXISTS");
    expect(files().map((f) => [f, read(path.join(tmpDir, f))])).toEqual(before);
    expect(driver.getAddress()).toBe(first.address);
  });
});
