// Regression tests for the security review of the wallet lifecycle (M1, M2, M5, m6, m7, LATENT and the re-encryption
// items). Written against the defects first: these reproduce them on the earlier implementation.
//
// Crash model used throughout: "the process died between two file-system calls". crashAt(k, run) lets the first
// k-1 mutating calls (rename / link / unlink / copy / write / mkdir ...) through and makes call k and every later
// one throw, so no rollback code can run, exactly like a killed process. The test then looks at what is on disk,
// the way a restarted server would.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet as EthersWallet, HDNodeWallet, encryptKeystoreJson } from "ethers";
import { LocalWalletDriver, WalletError, walletFilePath } from "../src/index.js";
import { addressFromPhrase } from "./bip44.js";

// Test-only: cheap scrypt, no OS-level ACL work (that is exercised for real in protect.win32.test.ts).
// (a short drain: a replace that finds a request in flight waits this long before it answers WALLET_BUSY; the production default is 60 s)
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const;
const PASSWORD = "original password 1";
const NEW_PASSWORD = "brand new password 2";

let tmpDir: string;
const drv = (dir = tmpDir, extra: Record<string, unknown> = {}) => new LocalWalletDriver(dir, { ...FAST, ...extra } as never);
const read = (p: string) => fs.readFileSync(p, "utf-8");
const mkdir = (name: string) => {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-hard-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------------------------------------------
// helpers: look at the disk
// --------------------------------------------------------------------------------------------------------------

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
const isSecretName = (f: string) => /(^|\/)(orphan-)?wallet-unlock[^/]*\.secret$/.test(f);
const liveSecretNames = (dir: string) => fs.readdirSync(dir).filter((f) => /^wallet-unlock[^/]*\.secret$/.test(f));
/** Content of every secret file anywhere under dir (live and retired). */
const allSecretTexts = (dir: string) => walk(dir).filter(isSecretName).map((f) => read(path.join(dir, f)).trim());
/** Does any file under dir hold exactly this text? */
const fileHolding = (dir: string, text: string) => walk(dir).find((f) => read(path.join(dir, f)).trim() === text.trim());

async function opens(json: string, credential: string): Promise<boolean> {
  try {
    await EthersWallet.fromEncryptedJson(json, credential);
    return true;
  } catch {
    return false;
  }
}
/** Which of the given credentials (plus every secret found on disk) opens the live wallet.json? */
async function liveOpenedBy(dir: string, passwords: string[] = []): Promise<string | null> {
  if (!fs.existsSync(path.join(dir, "wallet.json"))) return null;
  const json = read(path.join(dir, "wallet.json"));
  for (const c of [...passwords, ...allSecretTexts(dir)]) if (c && (await opens(json, c))) return c;
  return null;
}

// --------------------------------------------------------------------------------------------------------------
// helpers: crash injection
// --------------------------------------------------------------------------------------------------------------

class Crash extends Error {}
const MUTATIONS = ["renameSync", "linkSync", "unlinkSync", "copyFileSync", "writeFileSync", "mkdirSync", "rmdirSync", "chmodSync"] as const;

function instrument(crashCall: number | null) {
  const real = new Map<string, (...args: unknown[]) => unknown>();
  const state = { calls: 0, dead: false };
  for (const name of MUTATIONS) {
    const original = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    real.set(name, original);
    vi.spyOn(fs, name as "renameSync").mockImplementation(((...args: unknown[]) => {
      if (state.dead) throw new Crash("process is dead");
      state.calls++;
      if (crashCall !== null && state.calls === crashCall) {
        state.dead = true;
        throw new Crash(`process died at fs call #${crashCall} (${name})`);
      }
      return original(...args);
    }) as never);
  }
  return state;
}
/** Runs `run` and kills the "process" at its k-th file-system mutation. */
async function crashAt(k: number, run: () => Promise<unknown>): Promise<{ died: boolean }> {
  const state = instrument(k);
  try {
    await run();
  } catch {
    /* the operation fails after the crash; that is the point */
  } finally {
    vi.restoreAllMocks();
  }
  return { died: state.dead };
}
/** How many mutating fs calls `run` makes when nothing goes wrong. */
async function countCalls(run: () => Promise<unknown>): Promise<number> {
  const state = instrument(null);
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return state.calls;
}

/** A fresh data directory holding one auto-unlock wallet; returns what a later check needs. */
async function autoWallet(name: string) {
  const dir = mkdir(name);
  const driver = drv(dir);
  const created = await driver.createWithPhrase();
  const secrets = liveSecretNames(dir);
  expect(secrets).toHaveLength(1);
  return { dir, driver, ...created, keystore: read(path.join(dir, "wallet.json")), secret: read(path.join(dir, secrets[0])).trim() };
}

// ==============================================================================================================
// M1: a secret is never destroyed for another key; every crash point leaves a matching pair
// ==============================================================================================================

describe("M1: creating a wallet never destroys an existing unlock secret", () => {
  it("wallet.json is missing but a secret exists (operator moved the file, or a crash): Create keeps that secret", async () => {
    const old = await autoWallet("orphan");
    fs.rmSync(path.join(old.dir, "wallet.json")); // the keystore is gone, the credential for it is not
    const created = await drv(old.dir).createWithPhrase();
    expect(created.address).not.toBe(old.address);
    // the old credential is still on disk somewhere (live under its own name, or moved into retired/), never unlinked
    expect(fileHolding(old.dir, old.secret), `walk: ${walk(old.dir).join(", ")}`).toBeTruthy();
    // and the new wallet has its own, working pair
    const restarted = drv(old.dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
  });

  it("import over an orphan secret keeps it too", async () => {
    const old = await autoWallet("orphan-import");
    fs.rmSync(path.join(old.dir, "wallet.json"));
    await drv(old.dir).importFrom({ kind: "private_key", private_key: EthersWallet.createRandom().privateKey });
    expect(fileHolding(old.dir, old.secret)).toBeTruthy();
  });

  it("two creates racing in one process leave one wallet whose secret matches it", async () => {
    const dir = mkdir("race");
    const results = await Promise.allSettled([drv(dir).createWithPhrase(), drv(dir).createWithPhrase()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
  });

  it("a crash at ANY file-system call of create leaves a pre-existing orphan secret untouched", async () => {
    const seed = await autoWallet("seed");
    fs.rmSync(path.join(seed.dir, "wallet.json"));
    const orphan = seed.secret;
    const countDir = mkdir("count-create"); // (made outside the counted run)
    const total = await countCalls(() => drv(countDir).createWithPhrase());
    expect(total).toBeGreaterThan(3);
    for (let k = 1; k <= total; k++) {
      const dir = mkdir(`create-${k}`);
      // same orphan situation in a scratch copy
      for (const name of liveSecretNames(seed.dir)) fs.copyFileSync(path.join(seed.dir, name), path.join(dir, name));
      const { died } = await crashAt(k, () => drv(dir).createWithPhrase());
      expect(died, `call ${k} of ${total}`).toBe(true);
      expect(fileHolding(dir, orphan), `after a crash at call ${k}: ${walk(dir).join(", ")}`).toBeTruthy();
      // a restarted server can still create a wallet and open it
      const next = drv(dir);
      await next.unlockOnStartup({});
      if (!next.hasKeystore()) await next.createWithPhrase();
      const again = drv(dir);
      expect((await again.unlockOnStartup({})).unlocked, `restart after crash ${k}`).toBe(true);
    }
  });
});

describe("M1: replace never leaves the live wallet missing, whatever call the process dies at", () => {
  it("a crash at every file-system call of replaceWallet leaves a wallet.json that opens, and the old pair recoverable", async () => {
    const probe = await autoWallet("probe");
    const total = await countCalls(() => probe.driver.replaceWallet({ kind: "create" }));
    expect(total).toBeGreaterThan(5);
    const problems: string[] = [];
    for (let k = 1; k <= total; k++) {
      const old = await autoWallet(`replace-${k}`);
      const { died } = await crashAt(k, () => old.driver.replaceWallet({ kind: "create" }));
      if (!died) continue;
      const where = `crash at call ${k}/${total}: ${walk(old.dir).join(", ")}`;
      // 1. the live wallet is there
      if (!fs.existsSync(path.join(old.dir, "wallet.json"))) {
        problems.push(`wallet.json is MISSING after ${where}`);
        continue;
      }
      // 2. a restarted server opens it on its own (the pair on disk matches)
      const restarted = drv(old.dir);
      const report = await restarted.unlockOnStartup({});
      if (!report.unlocked) problems.push(`live wallet does not unlock after ${where}`);
      // 3. nothing of the OLD wallet is lost: its keystore and its secret exist somewhere, byte for byte
      if (!fileHolding(old.dir, old.keystore)) problems.push(`old keystore lost after ${where}`);
      if (!fileHolding(old.dir, old.secret)) problems.push(`old secret lost after ${where}`);
      // 4. if the swap happened, the old pair is complete in retired/
      if (restarted.getAddress() !== old.address) {
        const retired = walk(old.dir).filter((f) => f.startsWith("retired/"));
        const ks = retired.find((f) => read(path.join(old.dir, f)) === old.keystore);
        const sec = retired.find((f) => isSecretName(f) && read(path.join(old.dir, f)).trim() === old.secret);
        if (!ks || !sec) problems.push(`swap happened but retired/ lacks the old pair after ${where}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("a replace that fails part-way and cannot even roll back (every later call fails) still leaves the old wallet usable", async () => {
    const old = await autoWallet("noroll");
    // first call succeeds, everything after it fails: the worst case for a rollback that renames files back
    const state = instrument(2);
    await old.driver.replaceWallet({ kind: "create" }).catch(() => undefined);
    vi.restoreAllMocks();
    expect(state.dead).toBe(true);
    expect(fs.existsSync(path.join(old.dir, "wallet.json"))).toBe(true);
    const restarted = drv(old.dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(old.address);
  });
});

describe("M1: crash points of the auto-unlock toggles always leave a wallet.json something can open", () => {
  it("turning ON (password -> auto): crash at every call", async () => {
    const probeDir = mkdir("on-probe");
    const probe = drv(probeDir);
    await probe.createWithPhrase({ password: PASSWORD });
    const total = await countCalls(() => probe.enableAutoUnlock());
    expect(total).toBeGreaterThan(2);
    const problems: string[] = [];
    for (let k = 1; k <= total; k++) {
      const dir = mkdir(`on-${k}`);
      const driver = drv(dir);
      const created = await driver.createWithPhrase({ password: PASSWORD });
      const { died } = await crashAt(k, () => driver.enableAutoUnlock());
      if (!died) continue;
      const opener = await liveOpenedBy(dir, [PASSWORD]);
      if (!opener) problems.push(`nothing opens wallet.json after a crash at call ${k}/${total}: ${walk(dir).join(", ")}`);
      const restarted = drv(dir);
      await restarted.unlockOnStartup({});
      if (!restarted.isUnlocked()) {
        try {
          await restarted.unlock(PASSWORD);
        } catch {
          problems.push(`restart cannot unlock after a crash at call ${k}/${total}`);
        }
      }
      if (restarted.getAddress() !== created.address) problems.push(`address changed after crash ${k}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("turning OFF (auto -> password): crash at every call", async () => {
    const probe = await autoWallet("off-probe");
    const total = await countCalls(() => probe.driver.disableAutoUnlock(NEW_PASSWORD));
    expect(total).toBeGreaterThan(2);
    const problems: string[] = [];
    for (let k = 1; k <= total; k++) {
      const old = await autoWallet(`off-${k}`);
      const { died } = await crashAt(k, () => old.driver.disableAutoUnlock(NEW_PASSWORD));
      if (!died) continue;
      const opener = await liveOpenedBy(old.dir, [NEW_PASSWORD]);
      if (!opener) problems.push(`nothing opens wallet.json after a crash at call ${k}/${total}: ${walk(old.dir).join(", ")}`);
      const restarted = drv(old.dir);
      const report = await restarted.unlockOnStartup({});
      if (!report.unlocked) {
        try {
          await restarted.unlock(NEW_PASSWORD);
        } catch {
          problems.push(`restart cannot unlock after a crash at call ${k}/${total}`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("M1: on Windows a rename that fails with EPERM / EBUSY (an indexer or scanner holds the file) is retried", () => {
  it.skipIf(process.platform !== "win32")("every rename fails once with EPERM, then works: toggle, replace and create still succeed", async () => {
    const realRename = fs.renameSync;
    const failedOnce = new Set<string>();
    const flaky = () =>
      vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        const key = `${String(from)}->${String(to)}`;
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
        return realRename(from, to);
      }) as never);

    const created = await drv(mkdir("flaky-create")).createWithPhrase({ password: PASSWORD });
    expect(created.address).toMatch(/^0x/);
    const dir = mkdir("flaky");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    flaky();
    await expect(driver.enableAutoUnlock()).resolves.toBeTruthy();
    await expect(driver.disableAutoUnlock(NEW_PASSWORD)).resolves.toBeTruthy();
    await expect(driver.replaceWallet({ kind: "create" }, { password: NEW_PASSWORD })).resolves.toBeTruthy();
    vi.restoreAllMocks();
    expect((await drv(dir).unlock(NEW_PASSWORD)).address).toMatch(/^0x/);
  });
});

// ==============================================================================================================
// M2: an import keeps only the account-0 private key
// ==============================================================================================================

describe("M2: imports persist only the private key, never a seed", () => {
  const PHRASE = "test test test test test test test test test test test junk";

  it("a phrase import stores no mnemonic, and reveal returns the private key", async () => {
    const dir = mkdir("m2-phrase");
    const driver = drv(dir);
    const imported = await driver.importFrom({ kind: "mnemonic", mnemonic: PHRASE });
    const expectedKey = HDNodeWallet.fromPhrase(PHRASE).privateKey;
    expect(imported.address).toBe(addressFromPhrase(PHRASE));
    expect(driver.reveal()).toEqual({ kind: "private_key", privateKey: expectedKey });
    expect(driver.keystoreHasRecoveryPhrase()).toBe(false);
    const stored = JSON.parse(read(path.join(dir, "wallet.json")));
    expect(stored["x-ethers"]).toBeUndefined();
    // not in plaintext anywhere either
    for (const f of walk(dir)) {
      const text = read(path.join(dir, f));
      expect(text, f).not.toContain("junk");
      expect(text, f).not.toContain(expectedKey.slice(2));
    }
    // and after a restart, from the auto-unlocked keystore
    const restarted = drv(dir);
    await restarted.unlockOnStartup({});
    expect(restarted.reveal()).toEqual({ kind: "private_key", privateKey: expectedKey });
  });

  it("a keystore that carries a mnemonic on a NON-default path is imported as the bare key: reveal gives that key, not a phrase for another address", async () => {
    const account5 = HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/0'/0/5");
    expect(account5.address).not.toBe(addressFromPhrase(PHRASE));
    const keystore = await account5.encrypt("source password 3");
    expect(JSON.parse(keystore)["x-ethers"]).toBeDefined(); // the source really has the seed inside
    const dir = mkdir("m2-keystore");
    const driver = drv(dir);
    const imported = await driver.importFrom({ kind: "keystore", keystore, source_password: "source password 3" });
    expect(imported.address).toBe(account5.address);
    expect(driver.reveal()).toEqual({ kind: "private_key", privateKey: account5.privateKey });
    expect(JSON.parse(read(path.join(dir, "wallet.json")))["x-ethers"]).toBeUndefined();
    expect(driver.keystoreHasRecoveryPhrase()).toBe(false);
  }, 60_000);

  it("a private-key import is unchanged: no phrase, reveal returns the key", async () => {
    const key = EthersWallet.createRandom();
    const driver = drv(mkdir("m2-key"));
    await driver.importFrom({ kind: "private_key", private_key: key.privateKey });
    expect(driver.reveal()).toEqual({ kind: "private_key", privateKey: key.privateKey });
  });

  it("replacing with an imported phrase keeps only the key as well", async () => {
    const old = await autoWallet("m2-replace");
    const result = await old.driver.replaceWallet({ kind: "import", source: { kind: "mnemonic", mnemonic: PHRASE } });
    expect(result.hasRecoveryPhrase).toBe(false);
    expect(old.driver.reveal()).toEqual({ kind: "private_key", privateKey: HDNodeWallet.fromPhrase(PHRASE).privateKey });
    expect(JSON.parse(read(path.join(old.dir, "wallet.json")))["x-ethers"]).toBeUndefined();
  });

  it("only wallets GENERATED here keep their phrase (and it still reveals as words)", async () => {
    const dir = mkdir("m2-generated");
    const driver = drv(dir);
    const created = await driver.createWithPhrase();
    expect(driver.keystoreHasRecoveryPhrase()).toBe(true);
    expect(driver.reveal()).toEqual({ kind: "mnemonic", phrase: created.mnemonic });
    expect(addressFromPhrase(created.mnemonic)).toBe(created.address);
  });

  it("the auto-unlock toggles keep an imported wallet seedless and a generated one with its phrase", async () => {
    const imported = drv(mkdir("m2-toggle"));
    await imported.importFrom({ kind: "mnemonic", mnemonic: PHRASE }, { password: PASSWORD });
    await imported.enableAutoUnlock();
    await imported.disableAutoUnlock(NEW_PASSWORD);
    expect(imported.keystoreHasRecoveryPhrase()).toBe(false);
    expect(imported.reveal().kind).toBe("private_key");
  });
});

// ==============================================================================================================
// m7: expected_address
// ==============================================================================================================

describe("m7: an import can state the address it expects, and is refused when it differs", () => {
  const PHRASE = "test test test test test test test test test test test junk";

  it("matching (any letter case) is accepted; a different address refuses and creates nothing", async () => {
    const address = addressFromPhrase(PHRASE);
    for (const expected of [address, address.toLowerCase()]) {
      const dir = mkdir(`m7-ok-${expected === address ? "checksum" : "lower"}`);
      const imported = await drv(dir).importFrom({ kind: "mnemonic", mnemonic: PHRASE }, { expectedAddress: expected } as never);
      expect(imported.address).toBe(address);
    }
    const dir = mkdir("m7-bad");
    const wrong = HDNodeWallet.fromPhrase(PHRASE, undefined, "m/44'/60'/0'/0/5").address;
    const e = await drv(dir).importFrom({ kind: "mnemonic", mnemonic: PHRASE }, { expectedAddress: wrong } as never).then(() => null, (err) => err);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).code).toBe("EXPECTED_ADDRESS_MISMATCH");
    expect(fs.readdirSync(dir)).toEqual([]);
    // an address that is not even an address
    const garbage = await drv(dir).importFrom({ kind: "mnemonic", mnemonic: PHRASE }, { expectedAddress: "0x1234" } as never).then(() => null, (err) => err);
    expect((garbage as WalletError).code).toBe("EXPECTED_ADDRESS_MISMATCH");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("replace refuses on a mismatch before touching any file", async () => {
    const old = await autoWallet("m7-replace");
    const before = walk(old.dir);
    const e = await old.driver
      .replaceWallet({ kind: "import", source: { kind: "private_key", private_key: EthersWallet.createRandom().privateKey } }, { expectedAddress: EthersWallet.createRandom().address } as never)
      .then(() => null, (err) => err);
    expect((e as WalletError).code).toBe("EXPECTED_ADDRESS_MISMATCH");
    expect(walk(old.dir)).toEqual(before);
    expect(read(path.join(old.dir, "wallet.json"))).toBe(old.keystore);
  });
});

// ==============================================================================================================
// M5: the retired key must not keep signing
// ==============================================================================================================

describe("M5: a signer obtained before a replace cannot sign after it", () => {
  const typed = {
    domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
    types: { Ping: [{ name: "n", type: "uint256" }] },
    primaryType: "Ping",
    message: { n: 1n },
  };

  it("with the guard bypassed (a signer that outlived its lease), the stale signer refuses to sign after replace", async () => {
    const old = await autoWallet("m5-stale");
    // The lease is given back at once, so nothing stops the replace below: the "guard bypassed" situation the epoch check exists for.
    const lease = old.driver.leaseSigner()!;
    const signer = lease.signer;
    lease.release();
    await expect(signer.signTypedData(typed)).resolves.toMatch(/^0x/); // fine while current
    await old.driver.replaceWallet({ kind: "create" });
    const e = await signer.signTypedData(typed).then(() => null, (err) => err);
    expect(e, "the retired key must not sign any more").toBeInstanceOf(WalletError);
    expect((e as WalletError).code).toBe("WALLET_CHANGED");
    // a fresh signer signs with the NEW wallet
    const freshLease = old.driver.leaseSigner()!;
    const fresh = freshLease.signer;
    expect(fresh.address).toBe(old.driver.getAddress());
    expect(fresh.address).not.toBe(old.address);
    await expect(fresh.signTypedData(typed)).resolves.toMatch(/^0x/);
    freshLease.release();
  });

  it("a stale signer also refuses after lock()", async () => {
    const old = await autoWallet("m5-lock");
    const lease = old.driver.leaseSigner()!;
    const signer = lease.signer;
    lease.release();
    old.driver.lock();
    const e = await signer.signTypedData(typed).then(() => null, (err) => err);
    expect((e as WalletError)?.code).toBe("WALLET_CHANGED");
    expect(old.driver.leaseSigner()).toBeNull();
  });

  it("there is no way to take a signer without a lease: the driver has no getSigner(), only leaseSigner()", () => {
    // A route that wants to sign has to go through leaseSigner(), so replace and lock can always see it. (getSigner() used to hand
    // out an unleased signer; a future route using it would have silently opted out of the WALLET_BUSY protection.)
    expect("getSigner" in LocalWalletDriver.prototype).toBe(false);
    expect(typeof LocalWalletDriver.prototype.leaseSigner).toBe("function");
    // (makeSigner is the driver's private factory; leaseSigner is the only member that hands a signer out)
    const handingOutASigner = Object.getOwnPropertyNames(LocalWalletDriver.prototype).filter((name) => /signer/i.test(name) && name !== "leaseSigner" && name !== "makeSigner");
    expect(handingOutASigner).toEqual([]);
  });

  it("an open lease makes replace refuse with WALLET_BUSY (nothing touched); releasing it lets replace through", async () => {
    const old = await autoWallet("m5-lease");
    const lease = old.driver.leaseSigner()!;
    expect(old.driver.inFlight).toBe(1);
    const before = walk(old.dir);
    const e = await old.driver.replaceWallet({ kind: "create" }).then(() => null, (err) => err);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).code).toBe("WALLET_BUSY");
    expect(walk(old.dir)).toEqual(before);
    expect(read(path.join(old.dir, "wallet.json"))).toBe(old.keystore);
    // the leased signer is still good for the request that holds it
    await expect(lease.signer.signTypedData(typed)).resolves.toMatch(/^0x/);
    lease.release();
    lease.release(); // idempotent
    expect(old.driver.inFlight).toBe(0);
    await expect(old.driver.replaceWallet({ kind: "create" })).resolves.toBeTruthy();
  });

  it("lock() refuses while a lease is open", async () => {
    const old = await autoWallet("m5-lock-lease");
    const lease = old.driver.leaseSigner()!;
    expect(() => old.driver.lock()).toThrow(/in flight|busy/i);
    expect(old.driver.isUnlocked()).toBe(true);
    lease.release();
    old.driver.lock();
    expect(old.driver.isUnlocked()).toBe(false);
    expect(old.driver.leaseSigner()).toBeNull();
  });

  it("many concurrent leases are counted and each release frees exactly one", async () => {
    const old = await autoWallet("m5-many");
    const leases = [old.driver.leaseSigner()!, old.driver.leaseSigner()!, old.driver.leaseSigner()!];
    expect(old.driver.inFlight).toBe(3);
    leases[0].release();
    leases[1].release();
    expect(old.driver.inFlight).toBe(1);
    await expect(old.driver.replaceWallet({ kind: "create" })).rejects.toMatchObject({ code: "WALLET_BUSY" });
    leases[2].release();
    await expect(old.driver.replaceWallet({ kind: "create" })).resolves.toBeTruthy();
  });

  it("a toggle does not invalidate a signer in flight (same key, same wallet object)", async () => {
    const dir = mkdir("m5-toggle");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    const lease = driver.leaseSigner()!;
    await driver.enableAutoUnlock();
    await expect(lease.signer.signTypedData(typed)).resolves.toMatch(/^0x/);
    lease.release();
  });
});

// ==============================================================================================================
// LATENT: unlock() must not adopt a wallet that is no longer the one on disk
// ==============================================================================================================

describe("LATENT: unlock() runs under the same lock as replace and verifies the address it adopts", () => {
  it("an unlock that was decrypting while a replace completed does not leave the retired wallet unlocked", { timeout: 90_000 }, async () => {
    const dir = mkdir("latent");
    // a password wallet with the DEFAULT (slow) scrypt so the unlock is still decrypting when the replace finishes
    const slow = new LocalWalletDriver(dir, { protect: false } as never);
    const created = await slow.createWithPhrase({ password: PASSWORD });
    slow.lock();
    const unlocking = slow.unlock(PASSWORD).then(() => "unlocked", (e) => `refused: ${(e as Error).message}`);
    const replaced = slow.replaceWallet({ kind: "create" }, {}).then((r) => r.address);
    const [outcome, newAddress] = await Promise.all([unlocking, replaced]);
    expect(newAddress).not.toBe(created.address);
    // Whatever the unlock did, the wallet that is unlocked now is the one on disk
    expect(slow.getAddress()).toBe(newAddress);
    expect(drv(dir).getAddress()).toBe(newAddress);
    expect(outcome).toBeTruthy();
    if (slow.isUnlocked()) {
      const lease = slow.leaseSigner()!;
      expect(lease.signer.address).toBe(newAddress);
      lease.release();
    }
  });

  it("unlock() refuses a keystore that changed on disk while it was being decrypted", async () => {
    const dir = mkdir("latent-swap");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    driver.lock();
    const other = EthersWallet.createRandom();
    const swapped = await encryptKeystoreJson({ address: other.address, privateKey: other.privateKey }, "someone else", FAST);
    // Deterministic stand-in for "another process / the operator swapped wallet.json while scrypt was running":
    // the first read of wallet.json (before decrypting) sees the original, every later read sees the other wallet.
    const realRead = fs.readFileSync;
    let reads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file) === walletFilePath(dir) && ++reads >= 2) return swapped;
      return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
    }) as never);
    const outcome = await driver.unlock(PASSWORD).then(() => "unlocked", () => "refused");
    vi.restoreAllMocks();
    expect(outcome).toBe("refused");
    expect(driver.isUnlocked()).toBe(false);
  });

  it("turning auto-unlock ON or OFF refuses when wallet.json on disk is not the wallet that is unlocked (it would overwrite someone else's keystore)", async () => {
    const other = EthersWallet.createRandom();
    const theirs = JSON.stringify({
      ...JSON.parse(await encryptKeystoreJson({ address: other.address, privateKey: other.privateKey }, "someone else", FAST)),
      "x-moneyswitch": { version: 1, protection: "password" },
    });

    const dirOn = mkdir("latent-toggle-on");
    const mine = drv(dirOn);
    await mine.createWithPhrase({ password: PASSWORD }); // unlocked in memory
    fs.writeFileSync(path.join(dirOn, "wallet.json"), theirs); // swapped on disk behind the driver's back
    await expect(mine.enableAutoUnlock()).rejects.toMatchObject({ code: "WALLET_CHANGED" });
    expect(read(path.join(dirOn, "wallet.json"))).toBe(theirs);
    expect(walk(dirOn)).toEqual(["wallet.json"]);

    const dirOff = mkdir("latent-toggle-off");
    const auto = drv(dirOff);
    await auto.createWithPhrase();
    fs.writeFileSync(path.join(dirOff, "wallet.json"), theirs);
    await expect(auto.disableAutoUnlock("a brand new password")).rejects.toMatchObject({ code: "WALLET_CHANGED" });
    expect(read(path.join(dirOff, "wallet.json"))).toBe(theirs);
  });
});

// ==============================================================================================================
// m6: health is based on the RECORDED protection, and every source reports why it failed
// ==============================================================================================================

describe("m6: the protection mode is recorded, not inferred from which files happen to exist", () => {
  it("(a) an auto wallet whose secret went missing is still 'auto' and says secret_missing", async () => {
    const old = await autoWallet("m6a");
    for (const name of liveSecretNames(old.dir)) fs.rmSync(path.join(old.dir, name));
    const restarted = drv(old.dir);
    const report = await restarted.unlockOnStartup({});
    expect(report.unlocked).toBe(false);
    expect(report.attempts).toEqual([{ source: "auto", ok: false, reason: "secret_missing" }]);
    expect(restarted.protection()).toBe("auto");
    // a plain wallet.json copy would be useless to the operator: the driver says what the file needs
    expect(restarted.protection()).not.toBe("password");
  });

  it("(b) a stale env password and a wrong secret are reported separately; the secret failure is not blamed on the env var", async () => {
    const old = await autoWallet("m6b");
    const secretFile = path.join(old.dir, liveSecretNames(old.dir)[0]);
    fs.writeFileSync(secretFile, "ab".repeat(32));
    const restarted = drv(old.dir);
    const report = await restarted.unlockOnStartup({ password: "stale env password" });
    expect(report.attempts).toEqual([
      { source: "env_or_file", ok: false, reason: "env_wrong" },
      { source: "auto", ok: false, reason: "secret_wrong" },
    ]);
    expect(restarted.protection()).toBe("auto");
  });

  it("(c) a password wallet created next to a leftover secret is 'password' and never tries it", async () => {
    const leftover = await autoWallet("m6c");
    fs.rmSync(path.join(leftover.dir, "wallet.json"));
    const created = await drv(leftover.dir).createWithPhrase({ password: PASSWORD });
    const restarted = drv(leftover.dir);
    const report = await restarted.unlockOnStartup({});
    expect(report).toEqual({ unlocked: false, attempts: [] });
    expect(restarted.protection()).toBe("password");
    expect(restarted.getAddress()).toBe(created.address);
    // the leftover is kept (it belongs to another key), out of the live directory
    expect(fileHolding(leftover.dir, leftover.secret)).toBeTruthy();
  });

  it("the marker is non-secret metadata in wallet.json and does not break the V3 format", async () => {
    const dir = mkdir("m6-marker");
    const driver = drv(dir);
    await driver.createWithPhrase();
    const stored = JSON.parse(read(path.join(dir, "wallet.json")));
    expect(stored["x-moneyswitch"]).toEqual({ version: 1, protection: "auto" });
    expect(stored.version).toBe(3);
    expect(driver.protection()).toBe("auto");
    const pw = drv(mkdir("m6-marker-pw"));
    await pw.createWithPhrase({ password: PASSWORD });
    expect(JSON.parse(read(path.join(tmpDir, "m6-marker-pw", "wallet.json")))["x-moneyswitch"].protection).toBe("password");
    // a keystore from before this release has no marker: that is a password wallet
    const legacy = mkdir("m6-legacy");
    fs.writeFileSync(path.join(legacy, "wallet.json"), await EthersWallet.createRandom().encrypt("legacy pw 1"));
    expect(drv(legacy).protection()).toBe("password");
    expect(drv(mkdir("m6-none")).protection()).toBeNull();
  }, 60_000);

  it("both toggles keep the marker truthful", async () => {
    const dir = mkdir("m6-toggle");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    expect(driver.protection()).toBe("password");
    await driver.enableAutoUnlock();
    expect(driver.protection()).toBe("auto");
    await driver.disableAutoUnlock(NEW_PASSWORD);
    expect(driver.protection()).toBe("password");
    expect(JSON.parse(read(path.join(dir, "wallet.json")))["x-moneyswitch"].protection).toBe("password");
  });

  it("the portable export (for MetaMask) carries no server marker", async () => {
    const driver = drv(mkdir("m6-export"));
    await driver.createWithPhrase();
    const exported = JSON.parse(await driver.exportKeystoreWithPassword("portable pw 9"));
    expect(exported["x-moneyswitch"]).toBeUndefined();
  });
});

// ==============================================================================================================
// re-encryption: nothing is left behind that a retired credential can open
// ==============================================================================================================

describe("re-encryption leaves no persistent copy that a retired credential opens", () => {
  it("turning auto-unlock OFF: no .bak, the old secret is gone, and nothing on disk opens the key without the new password", async () => {
    const old = await autoWallet("off-clean");
    await old.driver.disableAutoUnlock(NEW_PASSWORD);
    expect(walk(old.dir).filter((f) => /\.bak/.test(f)), walk(old.dir).join(", ")).toEqual([]);
    expect(fileHolding(old.dir, old.secret), "the old secret must be gone").toBeUndefined();
    expect(walk(old.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // every keystore-looking file, every secret on disk and the OLD secret: none of them opens the key
    const candidates = [...allSecretTexts(old.dir), old.secret];
    for (const f of walk(old.dir).filter((n) => n.endsWith(".json"))) {
      for (const c of candidates) expect(await opens(read(path.join(old.dir, f)), c), `${f} opened by a retired credential`).toBe(false);
    }
    expect(await opens(read(path.join(old.dir, "wallet.json")), NEW_PASSWORD)).toBe(true);
    expect(await opens(old.keystore, old.secret)).toBe(true); // (the saved copy in this test's memory still opens: it is NOT on disk)
  });

  it("turning auto-unlock ON: no .bak either, and the previous password keystore is not left on disk", async () => {
    const dir = mkdir("on-clean");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    const previous = read(path.join(dir, "wallet.json"));
    await driver.enableAutoUnlock();
    expect(walk(dir).filter((f) => /\.bak/.test(f)), walk(dir).join(", ")).toEqual([]);
    expect(fileHolding(dir, previous)).toBeUndefined();
    expect(walk(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(liveSecretNames(dir)).toHaveLength(1);
  });

  it("a leftover secret that cannot open a keystore marked 'password' is moved to retired/ at startup, never deleted", async () => {
    const dir = mkdir("leftover");
    const driver = drv(dir);
    const created = await driver.createWithPhrase({ password: PASSWORD });
    fs.writeFileSync(path.join(dir, `wallet-unlock-${created.address.toLowerCase()}.secret`), "cd".repeat(32));
    const restarted = drv(dir);
    const report = await restarted.unlockOnStartup({});
    expect(report).toEqual({ unlocked: false, attempts: [] });
    expect(liveSecretNames(dir)).toEqual([]);
    expect(fileHolding(dir, "cd".repeat(32))).toMatch(/^retired\//);
    expect(restarted.protection()).toBe("password");
  });

  it("stale temp files from a crashed run are swept at startup (they may hold an encrypted copy of the key)", async () => {
    const old = await autoWallet("temps");
    fs.writeFileSync(path.join(old.dir, ".wallet-11111111-1111-1111-1111-111111111111.tmp"), old.keystore);
    fs.writeFileSync(path.join(old.dir, ".wallet-unlock-22222222-2222-2222-2222-222222222222.tmp"), old.secret);
    const restarted = drv(old.dir);
    await restarted.unlockOnStartup({});
    expect(walk(old.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a crash during ON followed by OFF cannot leave a pair that opens the key without the password", async () => {
    const dir = mkdir("on-crash-off");
    const driver = drv(dir);
    await driver.createWithPhrase({ password: PASSWORD });
    const total = await countCalls(async () => {
      const probe = drv(mkdir("on-crash-off-probe"));
      await probe.createWithPhrase({ password: PASSWORD });
      await probe.enableAutoUnlock();
    });
    expect(total).toBeGreaterThan(2);
    // die late in ON (after the new keystore and secret may both exist as temp files), then restart and turn it OFF
    const { died } = await crashAt(Math.max(1, Math.floor(total / 2)), () => driver.enableAutoUnlock());
    expect(died).toBe(true);
    const restarted = drv(dir);
    await restarted.unlockOnStartup({});
    if (!restarted.isUnlocked()) await restarted.unlock(PASSWORD);
    if (restarted.protection() === "password") await restarted.enableAutoUnlock();
    await restarted.disableAutoUnlock(NEW_PASSWORD);
    for (const f of walk(dir).filter((n) => n.endsWith(".json") || n.endsWith(".tmp"))) {
      for (const c of allSecretTexts(dir)) expect(await opens(read(path.join(dir, f)), c), `${f} still opens with a stored secret`).toBe(false);
    }
  });
});

// ==============================================================================================================
// orphan reporting (health needs it)
// ==============================================================================================================

describe("orphan files are reported instead of silently offering a fresh wallet", () => {
  it("no wallet.json but a secret and retired files: orphanFiles() says so", async () => {
    const old = await autoWallet("orph-report");
    await old.driver.replaceWallet({ kind: "create" });
    fs.rmSync(path.join(old.dir, "wallet.json"));
    const bare = drv(old.dir);
    expect(bare.hasKeystore()).toBe(false);
    const orphans = bare.orphanFiles();
    expect(orphans.secrets.length).toBeGreaterThan(0);
    expect(orphans.retired).toBeGreaterThan(0);
  });

  it("a clean data directory has none", async () => {
    const dir = mkdir("orph-clean");
    const driver = drv(dir);
    await driver.createWithPhrase();
    expect(driver.orphanFiles()).toEqual({ secrets: [], retired: 0 });
  });
});
