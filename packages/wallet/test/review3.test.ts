// Third review round of the wallet lifecycle (minor findings, each reproduced by fault injection):
//   #1 auto-unlock OFF / adopting a password key must not leave retired/ copies that still open the live key
//   #6 a replace (or ON) that fails twice must not remove the new secret while wallet.json is still the new keystore
//   #8 an unlock secret moved aside while wallet.json belonged to another key is restored when the right wallet.json is back
// Written against the defects first: they fail on the implementation the findings were made against.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet as EthersWallet } from "ethers";
import { LocalWalletDriver } from "../src/index.js";

// Cheap scrypt, no OS-level ACL work (that is exercised in protect.*.test.ts), and a short drain so a refused replace answers at once.
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const;
const PASSWORD = "original password 1";
const NEW_PASSWORD = "brand new password 2";

let tmpDir: string;
const drv = (dir = tmpDir) => new LocalWalletDriver(dir, FAST as never);
const read = (p: string) => fs.readFileSync(p, "utf-8");
const mkdir = (name: string) => {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-r3-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every file below `dir` (recursive), as paths relative to it with forward slashes. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}
const secretFilesOf = (dir: string) => fs.readdirSync(dir).filter((f) => /^wallet-unlock-0x[0-9a-f]{40}\.secret$/.test(f));

async function opens(json: string, credential: string): Promise<string | null> {
  try {
    return (await EthersWallet.fromEncryptedJson(json, credential)).address;
  } catch {
    return null;
  }
}

// ==============================================================================================================
// #6: the new secret must stay while wallet.json is still the new keystore
// ==============================================================================================================

describe("#6: a double failure never leaves wallet.json = the new key with its secret removed", () => {
  const eio = () => Object.assign(new Error("disk went away"), { code: "EIO" });

  /**
   * After the first rename onto wallet.json (the forward swap), every attempt to write wallet.json fails (so a rollback cannot
   * restore it) while everything else keeps working: the secret CAN still be removed, which is exactly the trap.
   */
  function breakRestoringWalletJson(dir: string, opts: { failFirstReadAfterSwap?: boolean } = {}) {
    const walletJson = path.join(dir, "wallet.json");
    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    const realRead = fs.readFileSync;
    const state = { swapped: false, reads: 0 };
    vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === walletJson) {
        if (state.swapped) throw eio();
        state.swapped = true;
      }
      return realRename(from, to);
    }) as never);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (state.swapped && String(file) === walletJson) throw eio();
      return (realWrite as (...a: unknown[]) => unknown)(file, ...rest);
    }) as never);
    if (opts.failFirstReadAfterSwap) {
      // the verification read-back right after the swap sees something else (that is what triggers the rollback)
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (state.swapped && String(file) === walletJson && state.reads++ === 0) return "{}";
        return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
      }) as never);
    }
    return state;
  }

  it("replace: the database hook throws AND wallet.json cannot be restored -> the new secret stays, a restart opens the new wallet, the old pair is safe in retired/", async () => {
    const dir = mkdir("double-replace");
    const driver = drv(dir);
    const created = await driver.createWithPhrase();
    const oldKeystore = read(path.join(dir, "wallet.json"));
    const oldSecret = read(path.join(dir, secretFilesOf(dir)[0]));
    breakRestoringWalletJson(dir);
    const boom = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const error = await driver.replaceWallet({ kind: "create" }, {}, { onSwapped: () => { throw boom; } }).then(() => null, (e) => e);
    vi.restoreAllMocks();
    expect(error).toBe(boom);

    // wallet.json is the NEW keystore (the restore failed). It must still have its secret, or nothing can ever open it.
    const restarted = drv(dir);
    const report = await restarted.unlockOnStartup({});
    expect(report.unlocked, JSON.stringify(report)).toBe(true);
    expect(restarted.getAddress()).not.toBe(created.address);
    // and nothing of the OLD wallet is lost: its keystore and its secret exist somewhere, byte for byte
    const everything = walk(dir).map((f) => ({ f, text: read(path.join(dir, f)) }));
    expect(everything.some((x) => x.text === oldKeystore), "old keystore").toBe(true);
    expect(everything.some((x) => x.text.trim() === oldSecret.trim()), "old secret").toBe(true);
  });

  it("replace with the SAME key: the same double failure keeps the new secret (the address alone cannot tell the keystores apart)", async () => {
    const dir = mkdir("double-replace-same");
    const driver = drv(dir);
    const key = EthersWallet.createRandom().privateKey;
    const imported = await driver.importFrom({ kind: "private_key", private_key: key });
    breakRestoringWalletJson(dir);
    const boom = new Error("database is locked");
    const error = await driver
      .replaceWallet({ kind: "import", source: { kind: "private_key", private_key: key } }, {}, { onSwapped: () => { throw boom; } })
      .then(() => null, (e) => e);
    vi.restoreAllMocks();
    expect(error).toBe(boom);
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(imported.address);
  });

  it("turning auto-unlock ON: the same double failure keeps the new secret too (wallet.json is then the new auto keystore)", async () => {
    const dir = mkdir("double-on");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    breakRestoringWalletJson(dir, { failFirstReadAfterSwap: true });
    const error = await driver.enableAutoUnlock().then(() => null, (e) => e);
    vi.restoreAllMocks();
    expect(error).toMatchObject({ code: "STORAGE_FAILED" });

    const live = JSON.parse(read(path.join(dir, "wallet.json")));
    expect(live["x-moneyswitch"]?.protection, "the restore failed, so wallet.json is the new auto keystore").toBe("auto");
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked, "an auto keystore without its secret can never be opened").toBe(true);
  });

  it("a rollback that DOES work still removes the new secret (the ordinary failure path is unchanged)", async () => {
    const dir = mkdir("single-failure");
    const driver = drv(dir);
    const created = await driver.createWithPhrase();
    const before = read(path.join(dir, "wallet.json"));
    const boom = new Error("database is locked");
    await expect(driver.replaceWallet({ kind: "create" }, {}, { onSwapped: () => { throw boom; } })).rejects.toBe(boom);
    expect(read(path.join(dir, "wallet.json"))).toBe(before);
    expect(secretFilesOf(dir)).toEqual([`wallet-unlock-${created.address.toLowerCase()}.secret`]);
    expect(fs.existsSync(path.join(dir, "retired"))).toBe(false);
  });
});

// ==============================================================================================================
// #8: a secret moved aside while wallet.json belonged to another key comes back with the right wallet.json
// ==============================================================================================================

describe("#8: an orphaned unlock secret in retired/ is restored when it opens the live keystore", () => {
  /** Wallet A (auto) in a data dir, plus the keystore of an unrelated auto wallet B to put in its place for a while. */
  async function setUp(name: string) {
    const dir = mkdir(name);
    const a = await drv(dir).createWithPhrase();
    const aKeystore = read(path.join(dir, "wallet.json"));
    const aSecretName = secretFilesOf(dir)[0];
    const aSecret = read(path.join(dir, aSecretName));
    const otherDir = mkdir(`${name}-other`);
    await drv(otherDir).createWithPhrase();
    const bKeystore = read(path.join(otherDir, "wallet.json"));
    return { dir, a, aKeystore, aSecretName, aSecret, bKeystore };
  }
  const retiredNames = (dir: string) => (fs.existsSync(path.join(dir, "retired")) ? fs.readdirSync(path.join(dir, "retired")).sort() : []);

  it("wallet.json is another key's for one start, then the right one is back: the secret is moved back and the wallet unlocks", async () => {
    const s = await setUp("restore");
    fs.writeFileSync(path.join(s.dir, "wallet.json"), s.bKeystore); // a wrong backup restored, a mis-mounted folder, ...
    const during = await drv(s.dir).unlockOnStartup({});
    expect(during.unlocked).toBe(false);
    // nothing was deleted: A's secret waits in retired/ under an orphan name
    expect(secretFilesOf(s.dir)).toEqual([]);
    const waiting = retiredNames(s.dir);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatch(new RegExp(`^orphan-wallet-unlock-${s.a.address.toLowerCase()}-.*\.secret$`));
    expect(read(path.join(s.dir, "retired", waiting[0]))).toBe(s.aSecret);

    fs.writeFileSync(path.join(s.dir, "wallet.json"), s.aKeystore); // the right wallet.json returns
    const restarted = drv(s.dir);
    const report = await restarted.unlockOnStartup({});
    expect(report.unlocked, JSON.stringify(report)).toBe(true);
    expect(report.attempts).toEqual([{ source: "auto", ok: true }]);
    expect(report.restoredSecret).toBe(waiting[0]);
    expect(restarted.getAddress()).toBe(s.a.address);
    // moved back, byte for byte, under its own name; retired/ no longer holds it
    expect(read(path.join(s.dir, s.aSecretName))).toBe(s.aSecret);
    expect(retiredNames(s.dir)).toEqual([]);
    // and the next start needs no restoring at all
    const again = await drv(s.dir).unlockOnStartup({});
    expect(again.unlocked).toBe(true);
    expect(again.restoredSecret).toBeUndefined();
  });

  it("the newest of several orphaned copies that actually opens the keystore wins; copies that do not open it stay where they are", async () => {
    const s = await setUp("restore-several");
    fs.mkdirSync(path.join(s.dir, "retired"), { recursive: true });
    const prefix = `orphan-wallet-unlock-${s.a.address.toLowerCase()}`;
    fs.writeFileSync(path.join(s.dir, "retired", `${prefix}-20260101T000000000Z.secret`), s.aSecret); // opens
    fs.writeFileSync(path.join(s.dir, "retired", `${prefix}-20260201T000000000Z.secret`), "ab".repeat(32)); // newer, but not this keystore's
    fs.rmSync(path.join(s.dir, s.aSecretName));
    const report = await drv(s.dir).unlockOnStartup({});
    expect(report.unlocked).toBe(true);
    expect(report.restoredSecret).toBe(`${prefix}-20260101T000000000Z.secret`);
    expect(retiredNames(s.dir)).toEqual([`${prefix}-20260201T000000000Z.secret`]);
  });

  it("when no orphaned copy opens the wallet it stays locked, nothing is moved, and the exact retired file is NAMED", async () => {
    const s = await setUp("name-it");
    fs.writeFileSync(path.join(s.dir, "wallet.json"), s.bKeystore);
    await drv(s.dir).unlockOnStartup({});
    const waiting = retiredNames(s.dir);
    expect(waiting).toHaveLength(1);
    fs.writeFileSync(path.join(s.dir, "retired", waiting[0]), "cd".repeat(32)); // damaged: no longer the secret
    fs.writeFileSync(path.join(s.dir, "wallet.json"), s.aKeystore);

    const report = await drv(s.dir).unlockOnStartup({});
    expect(report.unlocked).toBe(false);
    expect(report.attempts).toEqual([{ source: "auto", ok: false, reason: "secret_missing" }]);
    expect(report.restoredSecret).toBeUndefined();
    expect(report.retiredSecretFiles).toEqual(waiting);
    expect(retiredNames(s.dir)).toEqual(waiting); // untouched
  });

  it("a wallet whose secret is simply gone, with nothing in retired/ for it, reports no candidates", async () => {
    const s = await setUp("nothing");
    fs.rmSync(path.join(s.dir, s.aSecretName));
    const report = await drv(s.dir).unlockOnStartup({});
    expect(report.unlocked).toBe(false);
    expect(report.attempts).toEqual([{ source: "auto", ok: false, reason: "secret_missing" }]);
    expect(report.restoredSecret).toBeUndefined();
    expect(report.retiredSecretFiles).toBeUndefined();
  });

  it("another wallet's orphaned secret in retired/ is never used for this one", async () => {
    const s = await setUp("not-mine");
    const other = mkdir("not-mine-b");
    const b = await drv(other).createWithPhrase();
    fs.mkdirSync(path.join(s.dir, "retired"), { recursive: true });
    fs.copyFileSync(path.join(other, secretFilesOf(other)[0]), path.join(s.dir, "retired", `orphan-wallet-unlock-${b.address.toLowerCase()}-20260101T000000000Z.secret`));
    fs.rmSync(path.join(s.dir, s.aSecretName));
    const report = await drv(s.dir).unlockOnStartup({});
    expect(report.unlocked).toBe(false);
    expect(report.restoredSecret).toBeUndefined();
    expect(retiredNames(s.dir)).toHaveLength(1);
  });
});

// ==============================================================================================================
// #1: nothing in retired/ may open the live key without the password
// ==============================================================================================================

/**
 * Everything on disk (live folder AND retired/) that opens the live key WITHOUT knowing the human password: every
 * keystore of that address (wallet.json and retired copies) tried with every secret file found anywhere in the folder.
 */
async function openersOfLiveKey(dir: string): Promise<string[]> {
  const live = JSON.parse(read(path.join(dir, "wallet.json"))).address.toLowerCase().replace(/^0x/, "");
  const keystores: Array<{ file: string; json: string }> = [];
  const secrets: Array<{ file: string; text: string }> = [];
  for (const file of walk(dir)) {
    if (/\.json$/.test(file)) {
      try {
        const json = read(path.join(dir, file));
        if (String(JSON.parse(json).address ?? "").toLowerCase().replace(/^0x/, "") === live) keystores.push({ file, json });
      } catch {
        /* not a keystore */
      }
    } else if (/\.secret$/.test(file)) {
      secrets.push({ file, text: read(path.join(dir, file)).trim() });
    }
  }
  const found: string[] = [];
  for (const ks of keystores) for (const s of secrets) if (s.text && (await opens(ks.json, s.text))) found.push(`${s.file} opens ${ks.file}`);
  return found;
}
const retiredFiles = (dir: string, ext: string) => walk(dir).filter((f) => f.startsWith("retired/") && f.endsWith(ext));

describe("#1: turning auto-unlock OFF leaves nothing in retired/ that opens the key without the password", () => {
  const A = EthersWallet.createRandom().privateKey;
  const importA = { kind: "import", source: { kind: "private_key", private_key: A } } as const;

  it("a same-key replace, then OFF: the retired auto pair of that very key is no longer a way in", async () => {
    const dir = mkdir("same-key-off");
    const driver = drv(dir);
    const first = await driver.importFrom({ kind: "private_key", private_key: A });
    const replaced = await driver.replaceWallet(importA);
    expect(replaced.address).toBe(first.address);
    expect(replaced.retired.secretFile).toBeTruthy();
    expect(await openersOfLiveKey(dir), "setup: the retired pair really opens the (auto) live key").not.toEqual([]);

    // (a same-key replace leaves two copies of the old secret in retired/: the verified copy, and the original that the new secret displaced)
    const secretsBefore = retiredFiles(dir, ".secret").map((f) => f.replace("retired/", "")).sort();
    expect(secretsBefore).toContain(replaced.retired.secretFile);
    const off = await driver.disableAutoUnlock(NEW_PASSWORD);
    expect([...(off.retiredSecretsRemoved ?? [])].sort()).toEqual(secretsBefore);
    expect(off.retiredSecretsStillOpen ?? []).toEqual([]);
    expect(await openersOfLiveKey(dir), "nothing on disk opens the live key without the password").toEqual([]);
    // the retired KEYSTORE stays as the record (without its secret it opens nothing); the password still works
    expect(retiredFiles(dir, ".json")).toHaveLength(1);
    expect(retiredFiles(dir, ".secret")).toEqual([]);
    await expect(drv(dir).unlock(NEW_PASSWORD)).resolves.toEqual({ address: first.address });
    expect(driver.retiredSecretsOpeningLiveKey).toEqual([]);
  });

  it("A -> B -> A, then OFF: the old pair of A is gone, B's retired pair is untouched", async () => {
    const dir = mkdir("aba-off");
    const driver = drv(dir);
    const first = await driver.importFrom({ kind: "private_key", private_key: A });
    const toB = await driver.replaceWallet({ kind: "create" });
    const backToA = await driver.replaceWallet(importA);
    expect(backToA.address).toBe(first.address);
    const bKeystoreFile = retiredFiles(dir, ".json").find((f) => f.includes(toB.address.toLowerCase()))!;
    const bSecretFile = retiredFiles(dir, ".secret").find((f) => f.includes(toB.address.toLowerCase()))!;
    expect(bKeystoreFile && bSecretFile).toBeTruthy();

    await driver.disableAutoUnlock(NEW_PASSWORD);
    expect(await openersOfLiveKey(dir)).toEqual([]);
    // B is another key: its retired pair still opens it (deleting it would destroy the only way to recover B)
    expect(await opens(read(path.join(dir, bKeystoreFile)), read(path.join(dir, bSecretFile)).trim())).toBe(toB.address);
  });

  it("the live folder is never touched by the clean-up (only retired/)", async () => {
    const dir = mkdir("only-retired");
    const driver = drv(dir);
    await driver.importFrom({ kind: "private_key", private_key: A });
    await driver.replaceWallet(importA);
    await driver.disableAutoUnlock(NEW_PASSWORD);
    expect(fs.readdirSync(dir).filter((f) => f !== "retired")).toEqual(["wallet.json"]);
  });
});

describe("#1: adopting a key in password mode removes the retired copies that still open it", () => {
  const A = EthersWallet.createRandom().privateKey;

  it("replace: back to A (A -> B -> A) in password mode", async () => {
    const dir = mkdir("adopt-replace");
    const driver = drv(dir);
    const first = await driver.importFrom({ kind: "private_key", private_key: A });
    await driver.replaceWallet({ kind: "create" });
    const back = await driver.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } }, { password: NEW_PASSWORD });
    expect(back.address).toBe(first.address);
    expect(back.mode).toBe("manual");
    expect(back.retiredSecretsRemoved).toHaveLength(1);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("replace with the SAME key in password mode: the pair retired by this very call is not left behind", async () => {
    const dir = mkdir("adopt-same");
    const driver = drv(dir);
    await driver.importFrom({ kind: "private_key", private_key: A });
    const result = await driver.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } }, { password: NEW_PASSWORD });
    expect(result.retiredSecretsRemoved).toEqual([result.retired.secretFile]);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("import into a folder whose wallet.json is gone but whose retired/ still holds that key's old pair", async () => {
    const dir = mkdir("adopt-import");
    const driver = drv(dir);
    await driver.importFrom({ kind: "private_key", private_key: A });
    await driver.replaceWallet({ kind: "create" });
    fs.rmSync(path.join(dir, "wallet.json")); // the operator lost wallet.json and imports the key again, this time with a password
    const again = drv(dir);
    const imported = await again.importFrom({ kind: "private_key", private_key: A }, { password: NEW_PASSWORD });
    expect(imported.retiredSecretsRemoved).toHaveLength(1);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("a brand-new random key has no retired copies, so a password create changes nothing there", async () => {
    const dir = mkdir("create-password");
    const driver = drv(dir);
    await driver.importFrom({ kind: "private_key", private_key: A });
    await driver.replaceWallet({ kind: "create" });
    const before = walk(dir).filter((f) => f.startsWith("retired/"));
    const created = await driver.replaceWallet({ kind: "create" }, { password: NEW_PASSWORD });
    expect(created.retiredSecretsRemoved).toBeUndefined();
    expect(before.every((f) => fs.existsSync(path.join(dir, f)))).toBe(true);
  });
});

describe("#1: when a retired secret cannot be removed, it is flagged, and removed as soon as the password is used", () => {
  const A = EthersWallet.createRandom().privateKey;

  async function aRetiredPairOpensTheKey(name: string) {
    const dir = mkdir(name);
    const driver = drv(dir);
    await driver.importFrom({ kind: "private_key", private_key: A });
    const replaced = await driver.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } });
    return { dir, driver, retiredSecret: replaced.retired.secretFile! };
  }
  /** Removing that one retired secret fails (a scanner holds it, a permission problem); everything else works. */
  function undeletable(retiredSecret: string) {
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      // (exactly that file: the displaced original is kept as "orphan-" + the same name, and on a fast file system both carry the same stamp)
      if (path.basename(String(file)) === retiredSecret) throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return realUnlink(file);
    }) as never);
  }

  it("OFF with an undeletable retired secret still succeeds, reports it, and health can flag it", async () => {
    const { dir, driver, retiredSecret } = await aRetiredPairOpensTheKey("flag");
    undeletable(retiredSecret);
    const off = await driver.disableAutoUnlock(NEW_PASSWORD);
    vi.restoreAllMocks();
    expect(off.address).toBeTruthy(); // the password is in place; the leftover is a warning, not a failure
    expect(off.retiredSecretsStillOpen).toEqual([retiredSecret]);
    expect(driver.retiredSecretsOpeningLiveKey).toEqual([retiredSecret]);
    expect(await openersOfLiveKey(dir)).not.toEqual([]);

    // a restart finds it again and keeps flagging it (it deletes nothing without a password proving the wallet is reachable)
    const restarted = drv(dir);
    await restarted.unlockOnStartup({});
    expect(restarted.isUnlocked()).toBe(false);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([retiredSecret]);
    expect(fs.existsSync(path.join(dir, "retired", retiredSecret))).toBe(true);

    // using the password proves the live keystore is reachable: now the leftover goes
    await restarted.unlock(NEW_PASSWORD);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([]);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("the startup password (env_or_file) proves it too", async () => {
    const { dir, driver, retiredSecret } = await aRetiredPairOpensTheKey("env-proves");
    undeletable(retiredSecret);
    await driver.disableAutoUnlock(NEW_PASSWORD);
    vi.restoreAllMocks();
    const restarted = drv(dir);
    const report = await restarted.unlockOnStartup({ password: NEW_PASSWORD });
    expect(report.unlocked).toBe(true);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([]);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("a locked password wallet is never cleaned up without its password (the retired pair may be the only way in)", async () => {
    const { dir, driver, retiredSecret } = await aRetiredPairOpensTheKey("locked");
    undeletable(retiredSecret);
    await driver.disableAutoUnlock(NEW_PASSWORD);
    vi.restoreAllMocks();
    const before = walk(dir);
    const restarted = drv(dir);
    await restarted.unlockOnStartup({ password: "not the password at all" });
    await expect(restarted.unlock("still not the password")).rejects.toThrow();
    expect(walk(dir)).toEqual(before);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([retiredSecret]);
  });

  it("an auto-unlock wallet has nothing to flag (the live secret is on the same disk anyway)", async () => {
    const { dir } = await aRetiredPairOpensTheKey("auto-live");
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([]);
  });
});

describe("#1: every deletion from retired/ is reported to the audit hook (file names only)", () => {
  const A = EthersWallet.createRandom().privateKey;

  it("OFF, a password unlock and a password replace each report what they removed and why", async () => {
    const events: Array<{ files: string[]; trigger: string }> = [];
    const hooked = (dir: string) => new LocalWalletDriver(dir, { ...FAST, onRetiredSecretsRemoved: (e: { files: string[]; trigger: string }) => events.push(e) } as never);

    const offDir = mkdir("audit-off");
    const d1 = hooked(offDir);
    await d1.importFrom({ kind: "private_key", private_key: A });
    await d1.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } });
    const off = await d1.disableAutoUnlock(NEW_PASSWORD);
    expect(events).toEqual([{ files: off.retiredSecretsRemoved, trigger: "auto_unlock_off" }]);

    events.length = 0;
    const replaceDir = mkdir("audit-replace");
    const d2 = hooked(replaceDir);
    await d2.importFrom({ kind: "private_key", private_key: A });
    await d2.replaceWallet({ kind: "create" });
    const back = await d2.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } }, { password: NEW_PASSWORD });
    expect(events).toEqual([{ files: back.retiredSecretsRemoved, trigger: "replace" }]);

    // nothing to remove -> nothing reported
    events.length = 0;
    const plain = hooked(mkdir("audit-none"));
    await plain.createWithPhrase();
    await plain.disableAutoUnlock(NEW_PASSWORD);
    expect(events).toEqual([]);
  });

  it("a hook that throws does not undo the clean-up", async () => {
    const dir = mkdir("audit-throws");
    const d = new LocalWalletDriver(dir, { ...FAST, onRetiredSecretsRemoved: () => { throw new Error("audit table is gone"); } } as never);
    await d.importFrom({ kind: "private_key", private_key: A });
    await d.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: A } });
    await d.disableAutoUnlock(NEW_PASSWORD);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });
});

// ==============================================================================================================
// #2: replace drains instead of being starved by steady traffic
// ==============================================================================================================

describe("#2: replaceWallet waits (bounded) for requests in flight, and refuses new leases while it waits", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const drainingDriver = (dir: string, drainTimeoutMs: number) => new LocalWalletDriver(dir, { ...FAST, drainTimeoutMs } as never);

  it("it waits for the open lease to finish and then goes through (it does not answer WALLET_BUSY at once)", async () => {
    const dir = mkdir("drain-wait");
    const driver = drainingDriver(dir, 5_000);
    const created = await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    let finished = false;
    const replacing = driver.replaceWallet({ kind: "create" }).then((r) => {
      finished = true;
      return r;
    });
    await sleep(150);
    expect(finished, "still waiting for the request in flight").toBe(false);
    expect(read(path.join(dir, "wallet.json"))).toContain(created.address.toLowerCase().slice(2)); // nothing touched yet
    const started = Date.now();
    lease.release();
    const result = await replacing;
    expect(Date.now() - started, "released -> the drain ends at once, it does not sleep out the bound").toBeLessThan(2_000);
    expect(result.address).not.toBe(created.address);
    expect(driver.getAddress()).toBe(result.address);
    expect(driver.inFlight).toBe(0);
  });

  it("while it waits, NEW leases are refused with WALLET_BUSY (so steady traffic cannot keep it waiting)", async () => {
    const dir = mkdir("drain-refuses");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const first = driver.leaseSigner()!;
    const replacing = driver.replaceWallet({ kind: "create" });
    await sleep(100);
    for (let i = 0; i < 3; i++) {
      let refused: unknown = null;
      try {
        driver.leaseSigner();
      } catch (e) {
        refused = e;
      }
      expect(refused, "a lease taken while a replace is waiting").toMatchObject({ code: "WALLET_BUSY" });
    }
    expect(driver.inFlight, "refused leases are not counted").toBe(1);
    first.release();
    const result = await replacing;
    // afterwards the flag is gone and the NEW wallet can be leased
    const next = driver.leaseSigner()!;
    expect(next.signer.address).toBe(result.address);
    next.release();
  });

  it("it gives up after the bound with WALLET_BUSY, touches nothing, and payments can start again", async () => {
    const dir = mkdir("drain-timeout");
    const driver = drainingDriver(dir, 150);
    const created = await driver.createWithPhrase();
    const before = walk(dir);
    const keystore = read(path.join(dir, "wallet.json"));
    const lease = driver.leaseSigner()!;
    const started = Date.now();
    const error = await driver.replaceWallet({ kind: "create" }).then(() => null, (e) => e);
    const elapsed = Date.now() - started;
    expect(error).toMatchObject({ code: "WALLET_BUSY" });
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(3_000);
    expect(walk(dir)).toEqual(before);
    expect(read(path.join(dir, "wallet.json"))).toBe(keystore);
    // the flag is cleared: the request in flight keeps its signer and new requests can lease again
    const another = driver.leaseSigner()!;
    expect(another.signer.address).toBe(created.address);
    another.release();
    lease.release();
    await expect(driver.replaceWallet({ kind: "create" })).resolves.toBeTruthy();
  });

  it("with nothing in flight it is as immediate as before", async () => {
    const dir = mkdir("drain-idle");
    const driver = drainingDriver(dir, 60_000);
    await driver.createWithPhrase();
    const started = Date.now();
    await driver.replaceWallet({ kind: "create" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a replace that is vetoed or fails after the wait clears the flag too", async () => {
    const dir = mkdir("drain-veto");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    const replacing = driver.replaceWallet({ kind: "create" }, {}, { guard: () => { throw new Error("vetoed by the caller"); } });
    await sleep(60);
    lease.release();
    await expect(replacing).rejects.toThrow("vetoed by the caller");
    const next = driver.leaseSigner();
    expect(next, "a vetoed replace must not leave the wallet refusing payments").not.toBeNull();
    next!.release();
  });

  it("lock() is still refused at once while a lease is open (it does not wait)", async () => {
    const dir = mkdir("drain-lock");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    expect(() => driver.lock()).toThrow(/in flight/);
    lease.release();
    driver.lock();
    expect(driver.leaseSigner()).toBeNull();
  });

  it("a second replace queued behind a waiting one waits its turn and still works", async () => {
    const dir = mkdir("drain-two");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    const one = driver.replaceWallet({ kind: "create" });
    const two = driver.replaceWallet({ kind: "create" });
    await sleep(80);
    lease.release();
    const [a, b] = await Promise.all([one, two]);
    expect(a.address).not.toBe(b.address);
    expect(driver.getAddress()).toBe(b.address);
  });
});
