import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet as EthersWallet, HDNodeWallet } from "ethers";
import {
  LocalWalletDriver,
  WalletError,
  unlockSecretPath,
  walletFilePath,
  type WalletErrorCode,
  type WalletImport,
} from "../src/index.js";
import { addressFromPhrase } from "./bip44.js";

// Test-only: a cheap scrypt keeps the suite fast. Production costs are exercised in the dedicated test below.
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 } };
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ABANDON_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ABANDON_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const ZOO_24 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";

let tmpDir: string;
const drv = (dir = tmpDir) => new LocalWalletDriver(dir, FAST);
const files = (dir = tmpDir) => fs.readdirSync(dir).sort();
const read = (p: string) => fs.readFileSync(p, "utf-8");

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
    expect(created.mode).toBe("auto");
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

  it("reveal() gives the same phrase again after a restart: it lives in the encrypted keystore", async () => {
    const created = await drv().createWithPhrase();
    const restarted = drv();
    expect(restarted.isUnlocked()).toBe(false);
    await expectCode(Promise.resolve().then(() => restarted.reveal()), "WALLET_LOCKED");
    await restarted.unlockOnStartup({});
    expect(restarted.reveal()).toEqual({ kind: "mnemonic", phrase: created.mnemonic });
  });

  it("a wallet imported from a bare private key reveals the key, has no recovery phrase and cannot confirm words", async () => {
    const original = EthersWallet.createRandom();
    const driver = drv();
    const imported = await driver.importFrom({ kind: "private_key", private_key: original.privateKey });
    expect(imported).toEqual({ address: original.address, mode: "auto", hasRecoveryPhrase: false });
    expect(driver.keystoreHasRecoveryPhrase()).toBe(false);
    expect(driver.reveal()).toEqual({ kind: "private_key", privateKey: original.privateKey });
    expect(() => driver.checkRecoveryWords([1], ["test"])).toThrow(/no recovery phrase/);
  });

  it("checkRecoveryWords compares 1-based positions, ignores case and spaces, and rejects anything else", async () => {
    const driver = drv();
    const { mnemonic } = await driver.createWithPhrase();
    const w = mnemonic.split(" ");
    expect(driver.checkRecoveryWords([3, 9], [w[2], w[8]])).toBe(true);
    expect(driver.checkRecoveryWords([1, 12], [` ${w[0].toUpperCase()} `, w[11]])).toBe(true);
    expect(driver.checkRecoveryWords([3, 9], [w[8], w[2]])).toBe(w[2] === w[8]);
    expect(driver.checkRecoveryWords([3, 9], [w[2], "notaword"])).toBe(false);
    expect(driver.checkRecoveryWords([0, 9], [w[0], w[8]])).toBe(false);
    expect(driver.checkRecoveryWords([13, 9], [w[0], w[8]])).toBe(false);
    expect(driver.checkRecoveryWords([1.5, 9], [w[0], w[8]])).toBe(false);
    expect(driver.checkRecoveryWords([1, 2], [w[0]])).toBe(false);
    expect(driver.checkRecoveryWords([], [])).toBe(false);
    driver.lock();
    expect(() => driver.checkRecoveryWords([1], [w[0]])).toThrow(/locked/);
  });
});

describe("import a recovery phrase", () => {
  it("12 words: same address as the independent derivation, auto-unlock by default, phrase kept in the keystore", async () => {
    const driver = drv();
    const imported = await driver.importFrom({ kind: "mnemonic", mnemonic: HARDHAT_PHRASE });
    expect(imported).toEqual({ address: HARDHAT_ADDRESS, mode: "auto", hasRecoveryPhrase: true });
    expect(addressFromPhrase(HARDHAT_PHRASE)).toBe(HARDHAT_ADDRESS);
    expect(driver.reveal()).toEqual({ kind: "mnemonic", phrase: HARDHAT_PHRASE });
    expect(files()).toEqual(["wallet-unlock.secret", "wallet.json"]);
  });

  it("24 words work too, with extra whitespace and capitals tolerated", async () => {
    const imported = await drv().importFrom({ kind: "mnemonic", mnemonic: `  ${ZOO_24.toUpperCase().replace(/ /g, "  ")}\n` });
    expect(imported.address).toBe(addressFromPhrase(ZOO_24));
    expect(imported.hasRecoveryPhrase).toBe(true);
    const restarted = drv();
    await restarted.unlockOnStartup({});
    expect(restarted.reveal()).toEqual({ kind: "mnemonic", phrase: ZOO_24 });
  });

  it("manual mode: the supplied password protects it and no secret file is written", async () => {
    const driver = drv();
    await driver.importFrom({ kind: "mnemonic", mnemonic: ABANDON_PHRASE }, { password: "manual-pass-1" });
    expect(files()).toEqual(["wallet.json"]);
    const restarted = drv();
    await expect(restarted.unlock("wrong-pass-12")).rejects.toThrow();
    await expect(restarted.unlock("manual-pass-1")).resolves.toEqual({ address: ABANDON_ADDRESS });
  });

  it.each([
    ["a bad checksum", "test test test test test test test test test test test test"],
    ["13 words", `${HARDHAT_PHRASE} test`],
    ["11 words", "test test test test test test test test test test junk"],
    ["a word that is not on the list", "test test test test test test test test test test test zzzzzz"],
    ["nothing", "   "],
  ])("rejects %s without leaking it and without creating a wallet", async (_label, phrase) => {
    const driver = drv();
    const e = (await rejection(driver.importFrom({ kind: "mnemonic", mnemonic: phrase }))) as WalletError;
    expect(e.code).toBe("INVALID_IMPORT");
    expect(e.message).not.toContain("test test");
    expect(e.message).not.toContain("zzzzzz");
    expect(driver.hasKeystore()).toBe(false);
    expect(files()).toEqual([]);
  });

  it("rejects a non-string phrase", async () => {
    await expectCode(drv().importFrom({ kind: "mnemonic", mnemonic: 12 as unknown as string } as WalletImport), "INVALID_IMPORT");
  });
});

describe("auto-unlock secret", () => {
  it("is written next to the keystore (0600 where supported), never inside it, and unlocks a fresh process without any password", async () => {
    const created = await drv().createWithPhrase();
    expect(files()).toEqual(["wallet-unlock.secret", "wallet.json"]);
    const secret = read(unlockSecretPath(tmpDir));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(read(walletFilePath(tmpDir))).not.toContain(secret);
    if (process.platform !== "win32") expect(fs.statSync(unlockSecretPath(tmpDir)).mode & 0o777).toBe(0o600);

    const restarted = drv();
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.unlockStatus).toEqual({ source: null, ok: null });
    const report = await restarted.unlockOnStartup({ password: null });
    expect(report).toEqual({ unlocked: true, attempts: [{ source: "auto", ok: true }] });
    expect(restarted.isUnlocked()).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: true });
    // and it can really sign
    const sig = await restarted.getSigner()!.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping",
      message: { n: 1n },
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("every wallet gets its own random secret", async () => {
    await drv(path.join(tmpDir, "a")).createWithPhrase();
    await drv(path.join(tmpDir, "b")).createWithPhrase();
    expect(read(unlockSecretPath(path.join(tmpDir, "a")))).not.toBe(read(unlockSecretPath(path.join(tmpDir, "b"))));
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

  it("a manual wallet with an empty configured password just stays locked and reports no attempt", async () => {
    await drv().createWithPhrase({ password: "manual-pass-1" });
    const restarted = drv();
    expect(await restarted.unlockOnStartup({ password: "" })).toEqual({ unlocked: false, attempts: [] });
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.unlockStatus).toEqual({ source: null, ok: null });
  });

  it("the configured password has priority, and is reported as the source", async () => {
    const driver = drv();
    await driver.createWithPhrase({ password: "manual-pass-1" });
    const restarted = drv();
    const report = await restarted.unlockOnStartup({ password: "manual-pass-1" });
    expect(report).toEqual({ unlocked: true, attempts: [{ source: "env_or_file", ok: true }] });
    expect(restarted.unlockStatus).toEqual({ source: "env_or_file", ok: true });
  });

  it("a stale configured password does not lock out a wallet whose secret works (it is reported, then the secret is tried)", async () => {
    await drv().createWithPhrase();
    const restarted = drv();
    const report = await restarted.unlockOnStartup({ password: "an-old-password" });
    expect(report.unlocked).toBe(true);
    expect(report.attempts).toEqual([
      { source: "env_or_file", ok: false, reason: "wrong_credential" },
      { source: "auto", ok: true },
    ]);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: true });
  });

  it("a wrong secret leaves the wallet locked and says so (status ok=false), without echoing any credential", async () => {
    await drv().createWithPhrase();
    fs.writeFileSync(unlockSecretPath(tmpDir), "ab".repeat(32));
    const restarted = drv();
    const report = await restarted.unlockOnStartup({});
    expect(report).toEqual({ unlocked: false, attempts: [{ source: "auto", ok: false, reason: "wrong_credential" }] });
    expect(JSON.stringify(report)).not.toContain("abab");
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.getSigner()).toBeNull();
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: false });
  });

  it("an empty or unreadable secret file is a failure with its own reason, not a silent manual mode", async () => {
    await drv().createWithPhrase();
    fs.writeFileSync(unlockSecretPath(tmpDir), "");
    let restarted = drv();
    expect((await restarted.unlockOnStartup({})).attempts).toEqual([{ source: "auto", ok: false, reason: "secret_empty" }]);
    expect(restarted.unlockStatus).toEqual({ source: "auto", ok: false });

    fs.rmSync(unlockSecretPath(tmpDir));
    fs.mkdirSync(unlockSecretPath(tmpDir)); // a directory where the file should be
    restarted = drv();
    expect((await restarted.unlockOnStartup({})).attempts).toEqual([{ source: "auto", ok: false, reason: "secret_unreadable" }]);
  });

  it("no keystore: nothing to unlock", async () => {
    expect(await drv().unlockOnStartup({ password: "whatever" })).toEqual({ unlocked: false, attempts: [] });
  });

  it("uses a light scrypt for the random secret and ethers' default for human passwords (production parameters)", { timeout: 60_000 }, async () => {
    const auto = new LocalWalletDriver(path.join(tmpDir, "auto"));
    await auto.createWithPhrase();
    expect(JSON.parse(read(walletFilePath(path.join(tmpDir, "auto")))).Crypto.kdfparams.n).toBe(2 ** 14);
    const manual = new LocalWalletDriver(path.join(tmpDir, "manual"));
    await manual.createWithPhrase({ password: "a human password" });
    expect(JSON.parse(read(walletFilePath(path.join(tmpDir, "manual")))).Crypto.kdfparams.n).toBe(2 ** 17);
  });
});

describe("turning auto-unlock on and off", () => {
  async function manualWallet(password = "manual-pass-1") {
    const created = await drv().createWithPhrase({ password });
    const driver = drv();
    await driver.unlock(password);
    return { created, driver, password };
  }

  it("ON re-encrypts with a fresh secret, keeps the address, keeps the old keystore as wallet.json.bak-*, and survives a restart", async () => {
    const { created, driver, password } = await manualWallet();
    const before = read(walletFilePath(tmpDir));
    expect(await driver.enableAutoUnlock()).toEqual({ address: created.address });

    expect(driver.hasUnlockSecret()).toBe(true);
    expect(driver.unlockStatus).toEqual({ source: "auto", ok: true });
    const after = read(walletFilePath(tmpDir));
    expect(after).not.toBe(before);
    const backups = files().filter((f) => f.startsWith("wallet.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(read(path.join(tmpDir, backups[0]))).toBe(before);
    expect(files().filter((f) => f.endsWith(".tmp") || f.startsWith("."))).toEqual([]);

    // the previous keystore still opens with the previous password; the live one no longer does
    expect((await EthersWallet.fromEncryptedJson(read(path.join(tmpDir, backups[0])), password)).address).toBe(created.address);
    await expect(drv().unlock(password)).rejects.toThrow();

    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
    // the recovery phrase travelled with the key
    expect(restarted.reveal()).toEqual({ kind: "mnemonic", phrase: created.mnemonic });
  });

  it("ON twice is refused; it needs an unlocked wallet", async () => {
    const { driver } = await manualWallet();
    await driver.enableAutoUnlock();
    await expectCode(driver.enableAutoUnlock(), "ALREADY_AUTO");
    await expectCode(drv().enableAutoUnlock(), "WALLET_LOCKED");
    await expectCode(drv(path.join(tmpDir, "empty")).enableAutoUnlock(), "NO_WALLET");
  });

  it("ON repairs a stale secret (the wallet is unlocked with its password, the secret no longer fits)", async () => {
    const { created, driver } = await manualWallet();
    fs.writeFileSync(unlockSecretPath(tmpDir), "cd".repeat(32)); // left over from some earlier attempt
    await driver.enableAutoUnlock();
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
  });

  it("OFF needs a password, re-encrypts with it, removes the secret, keeps the address; the old keystore stays as a backup", async () => {
    const created = await drv().createWithPhrase();
    const driver = drv();
    await driver.unlockOnStartup({});
    const secretBefore = read(unlockSecretPath(tmpDir));
    const before = read(walletFilePath(tmpDir));

    expect(await driver.disableAutoUnlock("a new password 42")).toEqual({ address: created.address });
    expect(driver.hasUnlockSecret()).toBe(false);
    expect(files().filter((f) => f === "wallet-unlock.secret")).toEqual([]);
    expect(driver.unlockStatus).toEqual({ source: null, ok: null });
    expect(driver.isUnlocked()).toBe(true);

    const restarted = drv();
    expect(await restarted.unlockOnStartup({})).toEqual({ unlocked: false, attempts: [] });
    await expect(restarted.unlock(secretBefore)).rejects.toThrow(); // the old secret is useless now
    await expect(restarted.unlock("a new password 42")).resolves.toEqual({ address: created.address });
    expect(restarted.reveal()).toEqual({ kind: "mnemonic", phrase: created.mnemonic });

    const backups = files().filter((f) => f.startsWith("wallet.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(read(path.join(tmpDir, backups[0]))).toBe(before);
    expect(files().filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("OFF is refused when auto-unlock is not on, or the wallet is locked", async () => {
    const { driver } = await manualWallet();
    await expectCode(driver.disableAutoUnlock("another password"), "NOT_AUTO");
    const auto = drv(path.join(tmpDir, "auto"));
    await auto.createWithPhrase();
    await expectCode(drv(path.join(tmpDir, "auto")).disableAutoUnlock("another password"), "WALLET_LOCKED");
  });

  it("ON then OFF then ON again keeps one address and always leaves a keystore that opens", async () => {
    const { created, driver, password } = await manualWallet();
    await driver.enableAutoUnlock();
    await driver.disableAutoUnlock("second password 2");
    await driver.enableAutoUnlock();
    await driver.disableAutoUnlock(password);
    const restarted = drv();
    await expect(restarted.unlock(password)).resolves.toEqual({ address: created.address });
    expect(files().filter((f) => f.startsWith("wallet.json.bak-"))).toHaveLength(4);
  });

  describe("simulated failures never lose the old keystore", () => {
    it("ON: a failure while swapping the keystore puts everything back (no secret, no temp files, same bytes, old password works)", async () => {
      const { created, driver, password } = await manualWallet();
      const before = read(walletFilePath(tmpDir));
      const filesBefore = files();
      const spy = failNthCall("renameSync", 2); // 1st rename installs the secret, 2nd swaps wallet.json
      await expectCode(driver.enableAutoUnlock(), "STORAGE_FAILED");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();

      expect(read(walletFilePath(tmpDir))).toBe(before);
      expect(driver.hasUnlockSecret()).toBe(false);
      expect(files()).toEqual(filesBefore);
      expect(driver.unlockStatus).toEqual({ source: null, ok: null });
      await expect(drv().unlock(password)).resolves.toEqual({ address: created.address });
      // and the operation can simply be retried
      await driver.enableAutoUnlock();
      expect((await drv().unlockOnStartup({})).unlocked).toBe(true);
    });

    it("ON: a failure installing the secret leaves the files exactly as they were", async () => {
      const { driver, password } = await manualWallet();
      const before = read(walletFilePath(tmpDir));
      const filesBefore = files();
      failNthCall("renameSync", 1);
      await expectCode(driver.enableAutoUnlock(), "STORAGE_FAILED");
      vi.restoreAllMocks();
      expect(read(walletFilePath(tmpDir))).toBe(before);
      expect(files()).toEqual(filesBefore);
      await expect(drv().unlock(password)).resolves.toBeTruthy();
    });

    it("ON: a stale secret that was replaced is restored byte for byte when the keystore swap fails", async () => {
      const { driver, password } = await manualWallet();
      fs.writeFileSync(unlockSecretPath(tmpDir), "ef".repeat(32));
      failNthCall("renameSync", 2);
      await expectCode(driver.enableAutoUnlock(), "STORAGE_FAILED");
      vi.restoreAllMocks();
      expect(read(unlockSecretPath(tmpDir))).toBe("ef".repeat(32));
      await expect(drv().unlock(password)).resolves.toBeTruthy();
    });

    it("OFF: if even the restore cannot run, the safety copy of the previous keystore is kept and still opens with the old secret", async () => {
      const created = await drv().createWithPhrase();
      const driver = drv();
      await driver.unlockOnStartup({});
      const before = read(walletFilePath(tmpDir));
      const secret = read(unlockSecretPath(tmpDir));
      const eio = () => Object.assign(new Error("disk went away"), { code: "EIO" });
      // removing the secret fails AND nothing can be written back to wallet.json any more
      failNthCall("unlinkSync", 1, (args) => String(args[0]).endsWith("wallet-unlock.secret"));
      const realRename = fs.renameSync;
      let renames = 0;
      vi.spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof realRename>) => {
        if (++renames >= 2) throw eio();
        return realRename(...args);
      }) as never);
      const realWrite = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof realWrite>) => {
        if (String(args[0]) === walletFilePath(tmpDir)) throw eio();
        return realWrite(...args);
      }) as never);
      await expectCode(driver.disableAutoUnlock("new password 123"), "STORAGE_FAILED");
      vi.restoreAllMocks();

      const copies = files().filter((f) => f.startsWith("wallet.json.bak-")).map((f) => read(path.join(tmpDir, f)));
      expect(copies).toEqual([before]); // the previous keystore was NOT cleaned up
      expect((await EthersWallet.fromEncryptedJson(before, secret)).address).toBe(created.address);
      expect(driver.hasUnlockSecret()).toBe(true);
      // the live keystore is the new one, which the operator can open with the password they just chose
      await expect(drv().unlock("new password 123")).resolves.toEqual({ address: created.address });
    });

    it("OFF: a failure removing the secret restores the secret-encrypted keystore, so the wallet is still auto", async () => {
      const created = await drv().createWithPhrase();
      const driver = drv();
      await driver.unlockOnStartup({});
      const before = read(walletFilePath(tmpDir));
      const secret = read(unlockSecretPath(tmpDir));
      failNthCall("unlinkSync", 1, (args) => String(args[0]).endsWith("wallet-unlock.secret"));
      await expectCode(driver.disableAutoUnlock("new password 123"), "STORAGE_FAILED");
      vi.restoreAllMocks();

      expect(read(walletFilePath(tmpDir))).toBe(before);
      expect(read(unlockSecretPath(tmpDir))).toBe(secret);
      expect(files().filter((f) => f.endsWith(".tmp"))).toEqual([]);
      const restarted = drv();
      expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
      expect(restarted.getAddress()).toBe(created.address);
    });

    it("OFF: a failure swapping the keystore changes nothing", async () => {
      const created = await drv().createWithPhrase();
      const driver = drv();
      await driver.unlockOnStartup({});
      const before = read(walletFilePath(tmpDir));
      const secret = read(unlockSecretPath(tmpDir));
      failNthCall("renameSync", 1);
      await expectCode(driver.disableAutoUnlock("new password 123"), "STORAGE_FAILED");
      vi.restoreAllMocks();
      expect(read(walletFilePath(tmpDir))).toBe(before);
      expect(read(unlockSecretPath(tmpDir))).toBe(secret);
      expect((await drv().unlockOnStartup({})).unlocked).toBe(true);
      expect(driver.getAddress()).toBe(created.address);
    });

    it("a failure copying the safety backup stops before anything is changed", async () => {
      const { driver, password } = await manualWallet();
      const before = read(walletFilePath(tmpDir));
      const filesBefore = files();
      failNthCall("copyFileSync", 1);
      await expectCode(driver.enableAutoUnlock(), "STORAGE_FAILED");
      vi.restoreAllMocks();
      expect(read(walletFilePath(tmpDir))).toBe(before);
      expect(files()).toEqual(filesBefore);
      await expect(drv().unlock(password)).resolves.toBeTruthy();
    });
  });
});

describe("a password-protected copy for download", () => {
  it("exportKeystoreWithPassword gives a standard keystore the operator can open elsewhere, and changes nothing on disk", async () => {
    const driver = drv();
    const created = await driver.createWithPhrase(); // auto: wallet.json is encrypted with a secret nobody sees
    const filesBefore = files();
    const wallet = read(walletFilePath(tmpDir));
    const exported = await driver.exportKeystoreWithPassword("portable pass 9");
    const opened = await EthersWallet.fromEncryptedJson(exported, "portable pass 9");
    expect(opened.address).toBe(created.address);
    expect((opened as HDNodeWallet).mnemonic?.phrase).toBe(created.mnemonic);
    await expect(EthersWallet.fromEncryptedJson(exported, read(unlockSecretPath(tmpDir)))).rejects.toThrow();
    expect(files()).toEqual(filesBefore);
    expect(read(walletFilePath(tmpDir))).toBe(wallet);
    expect(exported).not.toContain(created.mnemonic);
  });

  it("needs an unlocked wallet", async () => {
    await drv().createWithPhrase();
    await expectCode(drv().exportKeystoreWithPassword("portable pass 9"), "WALLET_LOCKED");
  });
});

describe("replace wallet", () => {
  it("auto wallet: old keystore AND secret are moved (not deleted) into retired/ under names with the old address and a timestamp; the new wallet is live", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const oldKeystore = read(walletFilePath(tmpDir));
    const oldSecret = read(unlockSecretPath(tmpDir));
    let hookSaw: { keystoreExists: boolean; walletJsonIsNew: boolean } | null = null;
    const guard = vi.fn();

    const result = await driver.replaceWallet({ kind: "create" }, {}, {
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
    expect(result.mode).toBe("auto");
    expect(result.mnemonic!.split(" ")).toHaveLength(12);
    expect(addressFromPhrase(result.mnemonic!)).toBe(result.address);
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
    expect(driver.unlockStatus).toEqual({ source: "auto", ok: true });
    expect(read(unlockSecretPath(tmpDir))).not.toBe(oldSecret);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(result.address);
    expect(files()).toEqual(["retired", "wallet-unlock.secret", "wallet.json"]);
  });

  it("works while the old wallet is LOCKED and its password is lost (the whole point)", async () => {
    await drv().createWithPhrase({ password: "the lost password" });
    const locked = drv();
    expect(locked.isUnlocked()).toBe(false);
    const oldAddress = locked.getAddress()!;
    const result = await locked.replaceWallet({ kind: "create" });
    expect(result.retired.address).toBe(oldAddress);
    expect(result.retired.secretFile).toBeNull();
    expect(fs.readdirSync(path.join(tmpDir, "retired"))).toEqual([result.retired.keystoreFile]);
    // the old keystore still opens with the old password if it is ever found again
    const old = await EthersWallet.fromEncryptedJson(read(path.join(tmpDir, "retired", result.retired.keystoreFile)), "the lost password");
    expect(old.address).toBe(oldAddress);
    expect(locked.isUnlocked()).toBe(true);
    expect(locked.getAddress()).toBe(result.address);
  });

  it("a replacement in manual mode writes no secret", async () => {
    const driver = drv();
    await driver.createWithPhrase();
    const result = await driver.replaceWallet({ kind: "create" }, { password: "new manual pass" });
    expect(result.mode).toBe("manual");
    expect(driver.hasUnlockSecret()).toBe(false);
    expect(driver.unlockStatus).toEqual({ source: null, ok: null });
    await expect(drv().unlock("new manual pass")).resolves.toEqual({ address: result.address });
    // the old auto secret moved away with the old keystore
    expect(result.retired.secretFile).not.toBeNull();
  });

  it("can replace with an imported recovery phrase or private key", async () => {
    const driver = drv();
    await driver.createWithPhrase();
    const viaPhrase = await driver.replaceWallet({ kind: "import", source: { kind: "mnemonic", mnemonic: HARDHAT_PHRASE } });
    expect(viaPhrase.address).toBe(HARDHAT_ADDRESS);
    expect(viaPhrase.mnemonic).toBeUndefined();
    expect(viaPhrase.hasRecoveryPhrase).toBe(true);

    const key = EthersWallet.createRandom();
    const viaKey = await driver.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: key.privateKey } });
    expect(viaKey.address).toBe(key.address);
    expect(viaKey.hasRecoveryPhrase).toBe(false);
    expect(viaKey.retired.address).toBe(HARDHAT_ADDRESS);
    // nothing is ever deleted: both earlier generations are in retired/
    expect(fs.readdirSync(path.join(tmpDir, "retired"))).toHaveLength(4);
  });

  it("replacing with the very same key re-keys the files and archives the old ones", async () => {
    const driver = drv();
    await driver.importFrom({ kind: "mnemonic", mnemonic: HARDHAT_PHRASE }, { password: "old manual pass" });
    const result = await driver.replaceWallet({ kind: "import", source: { kind: "mnemonic", mnemonic: HARDHAT_PHRASE } });
    expect(result.address).toBe(HARDHAT_ADDRESS);
    expect(result.retired.address).toBe(HARDHAT_ADDRESS);
    await expect(drv().unlock("old manual pass")).rejects.toThrow();
    expect((await drv().unlockOnStartup({})).unlocked).toBe(true);
  });

  it("an invalid import is rejected before anything is touched", async () => {
    const driver = drv();
    await driver.createWithPhrase();
    const before = files();
    const keystore = read(walletFilePath(tmpDir));
    await expectCode(driver.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: "nope" } }), "INVALID_IMPORT");
    expect(files()).toEqual(before);
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
  });

  it("with nothing to replace it says so", async () => {
    await expectCode(drv().replaceWallet({ kind: "create" }), "NO_WALLET");
  });

  it("guard() can veto (a payment is in flight): no file is touched and no retired/ directory appears", async () => {
    const driver = drv();
    await driver.createWithPhrase();
    const before = files();
    const keystore = read(walletFilePath(tmpDir));
    class Busy extends Error {}
    const e = await rejection(driver.replaceWallet({ kind: "create" }, {}, { guard: () => { throw new Busy("busy"); } }));
    expect(e).toBeInstanceOf(Busy);
    expect(files()).toEqual(before);
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(driver.isUnlocked()).toBe(true);
  });

  it("if onSwapped() throws (the database refused), the swap is rolled back and the error is passed through unchanged", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const keystore = read(walletFilePath(tmpDir));
    const secret = read(unlockSecretPath(tmpDir));
    const boom = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const e = await rejection(driver.replaceWallet({ kind: "create" }, {}, { onSwapped: () => { throw boom; } }));
    expect(e).toBe(boom);
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(read(unlockSecretPath(tmpDir))).toBe(secret);
    expect(files()).toEqual(["wallet-unlock.secret", "wallet.json"]); // no retired/, no temp files
    expect(driver.getAddress()).toBe(first.address);
    expect(driver.unlockStatus).toEqual({ source: "auto", ok: true });
  });

  it("a file-system failure half-way moves the old files back", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const keystore = read(walletFilePath(tmpDir));
    const secret = read(unlockSecretPath(tmpDir));
    // renames: 1 old keystore -> retired, 2 old secret -> retired, 3 new secret in, 4 new keystore in
    failNthCall("renameSync", 4);
    await expectCode(driver.replaceWallet({ kind: "create" }), "STORAGE_FAILED");
    vi.restoreAllMocks();
    expect(read(walletFilePath(tmpDir))).toBe(keystore);
    expect(read(unlockSecretPath(tmpDir))).toBe(secret);
    expect(files()).toEqual(["wallet-unlock.secret", "wallet.json"]);
    expect(driver.getAddress()).toBe(first.address);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(first.address);
  });

  it("operations on one data directory are serialized: a toggle and a replace never interleave", async () => {
    const created = await drv().createWithPhrase({ password: "manual-pass-1" });
    const driver = drv();
    await driver.unlock("manual-pass-1");
    const [enabled, replaced] = await Promise.all([driver.enableAutoUnlock(), driver.replaceWallet({ kind: "create" })]);
    expect(enabled.address).toBe(created.address);
    expect(replaced.retired.address).toBe(created.address);
    // the retired generation is the one that went through the toggle: its keystore + secret open together
    const retiredKeystore = read(path.join(tmpDir, "retired", replaced.retired.keystoreFile));
    const retiredSecret = read(path.join(tmpDir, "retired", replaced.retired.secretFile!));
    expect((await EthersWallet.fromEncryptedJson(retiredKeystore, retiredSecret)).address).toBe(created.address);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(replaced.address);
  });
});

describe("creation stays exclusive and complete", () => {
  it("auto creation publishes the secret and the keystore exactly once, even when two creates race", async () => {
    const a = drv();
    const b = drv();
    const results = await Promise.allSettled([a.createWithPhrase(), b.createWithPhrase()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ address: string }>).value;
    expect(files()).toEqual(["wallet-unlock.secret", "wallet.json"]);
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(winner.address);
  });

  it("a stale secret left behind without a keystore is replaced, never trusted", async () => {
    fs.writeFileSync(unlockSecretPath(tmpDir), "12".repeat(32));
    const created = await drv().createWithPhrase();
    expect(read(unlockSecretPath(tmpDir))).not.toBe("12".repeat(32));
    const restarted = drv();
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
  });

  it("create and import refuse to overwrite an existing wallet and leave its files untouched", async () => {
    const driver = drv();
    const first = await driver.createWithPhrase();
    const before = files().map((f) => [f, read(path.join(tmpDir, f))]);
    await expectCode(driver.createWithPhrase(), "WALLET_EXISTS");
    await expectCode(driver.importFrom({ kind: "mnemonic", mnemonic: HARDHAT_PHRASE }), "WALLET_EXISTS");
    expect(files().map((f) => [f, read(path.join(tmpDir, f))])).toEqual(before);
    expect(driver.getAddress()).toBe(first.address);
  });

  it("legacy createWallet()/importWallet() are still manual-mode, address-only", async () => {
    const driver = drv();
    const created = await driver.createWallet("legacy-password");
    expect(Object.keys(created)).toEqual(["address"]);
    expect(files()).toEqual(["wallet.json"]);
    expect(driver.unlockStatus).toEqual({ source: null, ok: null });
  });
});
