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
