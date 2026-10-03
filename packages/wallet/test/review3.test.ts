// Third review round of the wallet lifecycle (minor findings, each reproduced by fault injection), as far as they apply to the
// reduced driver (create, replace, startup unlock):
//   #1 a retired secret that still opens a legacy password wallet is flagged, and removed only once the startup password proves it
//   #6 a replace that fails twice must not remove the new secret while wallet.json is still the new keystore
//   #8 an unlock secret moved aside while wallet.json belonged to another key is restored when the right wallet.json is back
//   #2 a replace drains the requests in flight instead of being starved by them
// Written against the defects first: they fail on the implementation the findings were made against.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet as EthersWallet, HDNodeWallet } from "ethers";
import { LocalWalletDriver } from "../src/index.js";
import { writeLegacyPasswordWallet } from "./legacy.js";

// Cheap scrypt, no OS-level ACL work (that is exercised in protect.*.test.ts), and a short drain so a refused replace answers at once.
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const;
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
    const error = await driver.replaceWallet({ onSwapped: () => { throw boom; } }).then(() => null, (e) => e);
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

  it("a rollback that DOES work still removes the new secret (the ordinary failure path is unchanged)", async () => {
    const dir = mkdir("single-failure");
    const driver = drv(dir);
    const created = await driver.createWithPhrase();
    const before = read(path.join(dir, "wallet.json"));
    const boom = new Error("database is locked");
    await expect(driver.replaceWallet({ onSwapped: () => { throw boom; } })).rejects.toBe(boom);
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

describe("#1: a retired secret that opens a legacy password wallet is flagged, and removed once the startup password proves the wallet reachable", () => {
  const events: Array<{ files: string[]; trigger: string }> = [];
  const hooked = (dir: string) => new LocalWalletDriver(dir, { ...FAST, onRetiredSecretsRemoved: (e: { files: string[]; trigger: string }) => events.push(e) } as never);
  beforeEach(() => {
    events.length = 0;
  });

  /**
   * A legacy password wallet whose key was once an auto wallet: the retired pair of that very key (keystore + secret) still opens it
   * without the password. (It came about when the old import feature put the key back with a password; built by hand here.)
   */
  async function aRetiredPairOpensTheLegacyKey(name: string) {
    const dir = mkdir(name);
    const driver = drv(dir);
    const first = await driver.createWithPhrase();
    const replaced = await driver.replaceWallet(); // the pair of `first` is now in retired/
    fs.rmSync(path.join(dir, "wallet.json"));
    for (const secret of secretFilesOf(dir)) fs.rmSync(path.join(dir, secret));
    await writeLegacyPasswordWallet(dir, NEW_PASSWORD, { wallet: HDNodeWallet.fromPhrase(first.mnemonic) });
    return { dir, first, retiredSecret: replaced.retired.secretFile! };
  }

  it("a locked legacy wallet is never cleaned up without its password (the retired pair may be the only way in): the secret is only flagged", async () => {
    const { dir, retiredSecret } = await aRetiredPairOpensTheLegacyKey("locked");
    expect(await openersOfLiveKey(dir), "setup: the retired pair really opens the live key").not.toEqual([]);
    const before = walk(dir);
    const restarted = hooked(dir);
    await restarted.unlockOnStartup({ password: "not the password at all" });
    expect(restarted.isUnlocked()).toBe(false);
    expect(walk(dir)).toEqual(before);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([retiredSecret]);
    expect(events).toEqual([]);
  });

  it("the startup password proves the wallet reachable: the secret that opened it is removed and reported once to the audit hook (file names only)", async () => {
    const { dir, retiredSecret } = await aRetiredPairOpensTheLegacyKey("startup-password");
    const restarted = hooked(dir);
    const report = await restarted.unlockOnStartup({ password: NEW_PASSWORD });
    expect(report.unlocked).toBe(true);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([]);
    expect(await openersOfLiveKey(dir), "nothing on disk opens the live key without the password").toEqual([]);
    expect(events).toEqual([{ files: [retiredSecret], trigger: "startup_password" }]);
    // the retired KEYSTORE stays as the record (without its secret it opens nothing); only the secret that opened the live key went
    expect(retiredFiles(dir, ".json")).toHaveLength(1);
    expect(retiredFiles(dir, ".secret")).toEqual([]);
  });

  it("a retired secret that cannot be removed does not stop the unlock: it stays flagged", async () => {
    const { dir, retiredSecret } = await aRetiredPairOpensTheLegacyKey("undeletable");
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      if (path.basename(String(file)) === retiredSecret) throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return realUnlink(file);
    }) as never);
    const restarted = hooked(dir);
    const report = await restarted.unlockOnStartup({ password: NEW_PASSWORD });
    vi.restoreAllMocks();
    expect(report.unlocked).toBe(true); // the password is in place; the leftover is a warning, not a failure
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([retiredSecret]);
    expect(fs.existsSync(path.join(dir, "retired", retiredSecret))).toBe(true);
    expect(events).toEqual([]);
  });

  it("a hook that throws does not undo the clean-up", async () => {
    const { dir } = await aRetiredPairOpensTheLegacyKey("hook-throws");
    const d = new LocalWalletDriver(dir, { ...FAST, onRetiredSecretsRemoved: () => { throw new Error("audit table is gone"); } } as never);
    expect((await d.unlockOnStartup({ password: NEW_PASSWORD })).unlocked).toBe(true);
    expect(await openersOfLiveKey(dir)).toEqual([]);
  });

  it("nothing to remove: nothing is reported", async () => {
    const dir = mkdir("audit-none");
    await writeLegacyPasswordWallet(dir, NEW_PASSWORD);
    expect((await hooked(dir).unlockOnStartup({ password: NEW_PASSWORD })).unlocked).toBe(true);
    expect(events).toEqual([]);
  });

  it("an auto-unlock wallet has nothing to flag (the live secret is on the same disk anyway)", async () => {
    const dir = mkdir("auto-live");
    const driver = drv(dir);
    await driver.createWithPhrase();
    await driver.replaceWallet();
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.retiredSecretsOpeningLiveKey).toEqual([]);
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
    const replacing = driver.replaceWallet().then((r) => {
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
    const replacing = driver.replaceWallet();
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
    const error = await driver.replaceWallet().then(() => null, (e) => e);
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
    await expect(driver.replaceWallet()).resolves.toBeTruthy();
  });

  it("with nothing in flight it is as immediate as before", async () => {
    const dir = mkdir("drain-idle");
    const driver = drainingDriver(dir, 60_000);
    await driver.createWithPhrase();
    const started = Date.now();
    await driver.replaceWallet();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a replace that is vetoed or fails after the wait clears the flag too", async () => {
    const dir = mkdir("drain-veto");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    const replacing = driver.replaceWallet({ guard: () => { throw new Error("vetoed by the caller"); } });
    await sleep(60);
    lease.release();
    await expect(replacing).rejects.toThrow("vetoed by the caller");
    const next = driver.leaseSigner();
    expect(next, "a vetoed replace must not leave the wallet refusing payments").not.toBeNull();
    next!.release();
  });

  it("a second replace queued behind a waiting one waits its turn and still works", async () => {
    const dir = mkdir("drain-two");
    const driver = drainingDriver(dir, 5_000);
    await driver.createWithPhrase();
    const lease = driver.leaseSigner()!;
    const one = driver.replaceWallet();
    const two = driver.replaceWallet();
    await sleep(80);
    lease.release();
    const [a, b] = await Promise.all([one, two]);
    expect(a.address).not.toBe(b.address);
    expect(driver.getAddress()).toBe(b.address);
  });
});
