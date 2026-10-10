// Regression tests for the security review of the wallet lifecycle (M1, M5, m6 and the leftover items) that still apply to the
// reduced driver (create, replace, startup unlock). Written against the defects first: these reproduced them on the earlier
// implementation. The import / reveal / toggle / password-unlock parts of that review went away with those features.
//
// Crash model used throughout: "the process died between two file-system calls". crashAt(k, run) lets the first
// k-1 mutating calls (rename / link / unlink / copy / write / mkdir ...) through and makes call k and every later
// one throw, so no rollback code can run, exactly like a killed process. The test then looks at what is on disk,
// the way a restarted server would.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver, WalletError } from "../src/index.js";
import { writeLegacyPasswordWallet } from "./legacy.js";

// Test-only: cheap scrypt, no OS-level ACL work (that is exercised for real in protect.win32.test.ts).
// (a short drain: a replace that finds a request in flight waits this long before it answers WALLET_BUSY; the production default is 60 s)
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const;
const PASSWORD = "original password 1";

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
/** Does any file under dir hold exactly this text? */
const fileHolding = (dir: string, text: string) => walk(dir).find((f) => read(path.join(dir, f)).trim() === text.trim());

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
    const total = await countCalls(() => probe.driver.replaceWallet());
    expect(total).toBeGreaterThan(5);
    const problems: string[] = [];
    for (let k = 1; k <= total; k++) {
      const old = await autoWallet(`replace-${k}`);
      const { died } = await crashAt(k, () => old.driver.replaceWallet());
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
    await old.driver.replaceWallet().catch(() => undefined);
    vi.restoreAllMocks();
    expect(state.dead).toBe(true);
    expect(fs.existsSync(path.join(old.dir, "wallet.json"))).toBe(true);
    const restarted = drv(old.dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(old.address);
  });
});

describe("M1: on Windows a rename that fails with EPERM / EBUSY (an indexer or scanner holds the file) is retried", () => {
  it.skipIf(process.platform !== "win32")("every rename fails once with EPERM, then works: create and replace still succeed", async () => {
    const realRename = fs.renameSync;
    const failedOnce = new Set<string>();
    vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      const key = `${String(from)}->${String(to)}`;
      if (!failedOnce.has(key)) {
        failedOnce.add(key);
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return realRename(from, to);
    }) as never);

    const dir = mkdir("flaky");
    const driver = drv(dir);
    const created = await driver.createWithPhrase();
    await expect(driver.replaceWallet()).resolves.toBeTruthy();
    vi.restoreAllMocks();
    const restarted = drv(dir);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).not.toBe(created.address);
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
    await old.driver.replaceWallet();
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

  it("there is no way to take a signer without a lease: the driver has no getSigner(), only leaseSigner()", () => {
    // A route that wants to sign has to go through leaseSigner(), so replace and lock can always see it. (getSigner() used to hand
    // out an unleased signer; a future route using it would have silently opted out of the WALLET_BUSY protection.)
    expect("getSigner" in LocalWalletDriver.prototype).toBe(false);
    expect(typeof LocalWalletDriver.prototype.leaseSigner).toBe("function");
    // Both EVM and SVM public signers must participate in the same replacement lease boundary.
    expect(typeof LocalWalletDriver.prototype.leaseSvmSigner).toBe("function");
    const handingOutASigner = Object.getOwnPropertyNames(LocalWalletDriver.prototype).filter((name) => /signer/i.test(name) && name !== "leaseSigner" && name !== "leaseSvmSigner" && name !== "makeSigner");
    expect(handingOutASigner).toEqual([]);
  });

  it("an open lease makes replace refuse with WALLET_BUSY (nothing touched); releasing it lets replace through", async () => {
    const old = await autoWallet("m5-lease");
    const lease = old.driver.leaseSigner()!;
    expect(old.driver.inFlight).toBe(1);
    const before = walk(old.dir);
    const e = await old.driver.replaceWallet().then(() => null, (err) => err);
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).code).toBe("WALLET_BUSY");
    expect(walk(old.dir)).toEqual(before);
    expect(read(path.join(old.dir, "wallet.json"))).toBe(old.keystore);
    // the leased signer is still good for the request that holds it
    await expect(lease.signer.signTypedData(typed)).resolves.toMatch(/^0x/);
    lease.release();
    lease.release(); // idempotent
    expect(old.driver.inFlight).toBe(0);
    await expect(old.driver.replaceWallet()).resolves.toBeTruthy();
  });

  it("many concurrent leases are counted and each release frees exactly one", async () => {
    const old = await autoWallet("m5-many");
    const leases = [old.driver.leaseSigner()!, old.driver.leaseSigner()!, old.driver.leaseSigner()!];
    expect(old.driver.inFlight).toBe(3);
    leases[0].release();
    leases[1].release();
    expect(old.driver.inFlight).toBe(1);
    await expect(old.driver.replaceWallet()).rejects.toMatchObject({ code: "WALLET_BUSY" });
    leases[2].release();
    await expect(old.driver.replaceWallet()).resolves.toBeTruthy();
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

  it("(c) a legacy password wallet next to a leftover secret is 'password' and never tries it", async () => {
    const leftover = await autoWallet("m6c");
    fs.rmSync(path.join(leftover.dir, "wallet.json"));
    const legacy = await writeLegacyPasswordWallet(leftover.dir, PASSWORD);
    const restarted = drv(leftover.dir);
    const report = await restarted.unlockOnStartup({});
    expect(report).toEqual({ unlocked: false, attempts: [] });
    expect(restarted.protection()).toBe("password");
    expect(restarted.getAddress()).toBe(legacy.address);
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
    // a keystore from before the marker existed has none: that is a password wallet
    const legacy = mkdir("m6-legacy");
    await writeLegacyPasswordWallet(legacy, "legacy pw 1", { marker: false });
    expect(JSON.parse(read(path.join(legacy, "wallet.json")))["x-moneyswitch"]).toBeUndefined();
    expect(drv(legacy).protection()).toBe("password");
    expect(drv(mkdir("m6-none")).protection()).toBeNull();
  });
});

// ==============================================================================================================
// startup tidy-up: temp files are swept, a leftover secret is moved aside and never deleted
// ==============================================================================================================

describe("startup tidy-up: temp files are swept, a leftover secret is moved aside and never deleted", () => {
  it("a leftover secret that cannot open a keystore marked 'password' is moved to retired/ at startup, never deleted", async () => {
    const dir = mkdir("leftover");
    const legacy = await writeLegacyPasswordWallet(dir, PASSWORD);
    fs.writeFileSync(path.join(dir, `wallet-unlock-${legacy.address.toLowerCase()}.secret`), "cd".repeat(32));
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
});

// ==============================================================================================================
// orphan reporting (health needs it)
// ==============================================================================================================

describe("orphan files are reported instead of silently offering a fresh wallet", () => {
  it("no wallet.json but a secret and retired files: orphanFiles() says so", async () => {
    const old = await autoWallet("orph-report");
    await old.driver.replaceWallet();
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
