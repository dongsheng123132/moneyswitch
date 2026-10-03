// M3 on Windows: mode 0o600 means nothing there; the secret would inherit the data directory's ACL (on a typical
// machine: Users, Authenticated Users, other local accounts and sandboxed agents can read it). These tests run the
// REAL protection against REAL icacls on a throw-away directory under the OS temp dir.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver } from "../src/index.js";
import { defaultProtector } from "../src/protect.js";
import { writeLegacyPasswordWallet } from "./legacy.js";

// Starting PowerShell and icacls takes seconds on a loaded machine (the five tests below each start several processes).
vi.setConfig({ testTimeout: 90_000 });

const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const ICACLS = path.join(SYSTEM32, "icacls.exe");
const WHOAMI = path.join(SYSTEM32, "whoami.exe");

/** SID of the user running the tests (locale-independent). */
function currentSid(): string {
  const csv = execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8" }).trim();
  return /"(S-1-[0-9-]+)"\s*$/.exec(csv)![1];
}

/** SDDL writes well-known SIDs as two-letter aliases. */
const ALIASES: Record<string, string> = { SY: "S-1-5-18", BU: "S-1-5-32-545", BA: "S-1-5-32-544", AU: "S-1-5-11", WD: "S-1-1-0", LS: "S-1-5-19", NS: "S-1-5-20", IU: "S-1-5-4" };

/**
 * SDDL also writes two machine-relative accounts as aliases: LA (the built-in Administrator, RID 500 - the account GitHub's
 * Windows runners use) and LG (Guest, RID 501). Their SID is the local machine's prefix plus the RID, which equals the
 * running user's prefix whenever that user is a local account (the only case in which SDDL can print the alias for it).
 */
function machineAlias(alias: string): string | undefined {
  const rid = alias === "LA" ? "500" : alias === "LG" ? "501" : null;
  if (!rid) return undefined;
  const me = currentSid();
  return /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(me) ? me.replace(/-\d+$/, `-${rid}`) : undefined;
}

/** The DACL of `target` as `icacls /save` writes it: SDDL, so every trustee is a SID or a well-known alias, never a localized name. */
function aclOf(target: string) {
  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-icacls-")), "acl.txt");
  try {
    execFileSync(ICACLS, [target, "/save", saved], { stdio: "pipe" });
    const text = fs.readFileSync(saved).toString("utf16le").replace(/^\uFEFF/, "");
    const sddl = text.split(/\r?\n/).find((l) => l.startsWith("D:"))!;
    const flags = /^D:([A-Z]*)/.exec(sddl)![1];
    const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
    const trustees = aces.map((a) => ALIASES[a[5]] ?? machineAlias(a[5]) ?? a[5]);
    return { sddl, protectedDacl: flags.includes("P"), types: aces.map((a) => a[0]), trustees: trustees.sort(), rights: aces.map((a) => a[2]) };
  } finally {
    fs.rmSync(path.dirname(saved), { recursive: true, force: true });
  }
}
const listing = (target: string) => execFileSync(ICACLS, [target], { encoding: "utf-8" }).trim();

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-acl-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const FAST_SCRYPT = { scrypt: { N: 2 ** 10, r: 8, p: 1 } };
const secretIn = (dir: string) => path.join(dir, fs.readdirSync(dir).find((f) => /^wallet-unlock.*\.secret$/.test(f))!);

describe.skipIf(process.platform !== "win32")("Windows: the data directory and the unlock secret are protected with an owner + SYSTEM only ACL", () => {
  it("creating an auto-unlock wallet leaves a protected DACL with exactly two allow entries: the current user and SYSTEM", async () => {
    const dir = path.join(root, "data");
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    await driver.createWithPhrase();
    const me = currentSid();
    for (const target of [dir, secretIn(dir), path.join(dir, "wallet.json")]) {
      const acl = aclOf(target);
      console.log(`icacls ${path.basename(target)}:\n${listing(target)}\n`);
      // the directory and the secret are protected explicitly; wallet.json simply inherits from the protected directory
      if (target !== path.join(dir, "wallet.json")) expect(acl.protectedDacl, `inheritance must be removed on ${target}: ${acl.sddl}`).toBe(true);
      expect(acl.types, target).toEqual(["A", "A"]);
      expect(acl.trustees, `${target}: ${acl.sddl}`).toEqual([me, "S-1-5-18"].sort());
    }
    expect(driver.secretProtection).toMatchObject({ ok: true, method: "acl" });
  });

  it("a directory that other accounts could read before is locked down, including the files already in it", async () => {
    const dir = path.join(root, "preexisting");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "moneyswitch.sqlite"), "pretend database");
    // make the starting point explicit: add a broad grant first, so the test does not depend on how the temp dir is configured
    execFileSync(ICACLS, [dir, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdio: "pipe" }); // BUILTIN\Users
    expect(aclOf(dir).trustees).toContain("S-1-5-32-545");
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    await driver.createWithPhrase();
    const me = currentSid();
    expect(aclOf(dir).trustees).toEqual([me, "S-1-5-18"].sort());
    expect(aclOf(path.join(dir, "moneyswitch.sqlite")).trustees, "existing files inherit the protected DACL").toEqual([me, "S-1-5-18"].sort());
  });

  it("a restart re-checks the secret and repairs a loosened ACL", async () => {
    const dir = path.join(root, "repair");
    await new LocalWalletDriver(dir, FAST_SCRYPT).createWithPhrase();
    const secret = secretIn(dir);
    execFileSync(ICACLS, [secret, "/inheritance:e", "/grant", "*S-1-5-32-545:R"], { stdio: "pipe" });
    expect(aclOf(secret).trustees).toContain("S-1-5-32-545");
    const restarted = new LocalWalletDriver(dir, FAST_SCRYPT);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    const me = currentSid();
    expect(aclOf(secret).trustees).toEqual([me, "S-1-5-18"].sort());
    expect(restarted.secretProtection).toMatchObject({ ok: true });
  });

  it("works for a path with spaces, quotes and non-ASCII characters", async () => {
    const dir = path.join(root, "数据 目录 'quoted' & more");
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    await driver.createWithPhrase();
    expect(driver.secretProtection).toMatchObject({ ok: true });
    expect(aclOf(secretIn(dir)).trustees).toEqual([currentSid(), "S-1-5-18"].sort());
  });

  it("if the ACL cannot be applied the wallet still works in auto mode and the driver reports secret_protected = false", async () => {
    const dir = path.join(root, "no-powershell");
    const driver = new LocalWalletDriver(dir, { ...FAST_SCRYPT, powershellPath: path.join(root, "does-not-exist.exe") } as never);
    const created = await driver.createWithPhrase();
    expect(driver.secretProtection).toMatchObject({ ok: false, method: "acl" });
    expect(driver.secretProtection?.detail).toBeTruthy();
    const restarted = new LocalWalletDriver(dir, { ...FAST_SCRYPT, powershellPath: path.join(root, "does-not-exist.exe") } as never);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(restarted.getAddress()).toBe(created.address);
    expect(restarted.secretProtection).toMatchObject({ ok: false });
  });

  it("a legacy password wallet writes no secret, so there is nothing to protect and nothing is reported", async () => {
    const dir = path.join(root, "pw");
    await writeLegacyPasswordWallet(dir, "a password to test with");
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    expect((await driver.unlockOnStartup({ password: "a password to test with" })).unlocked).toBe(true);
    expect(driver.secretProtection).toBeNull();
  });

  // #4: the PowerShell calls used to be execFileSync: the whole server stood still for 1-3 s per call (30 s if it hung).
  it("#4: PowerShell runs without blocking the event loop (other requests are served meanwhile)", async () => {
    const dir = path.join(root, "nonblocking");
    fs.mkdirSync(dir);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let result;
    try {
      result = await defaultProtector()({ dir });
    } finally {
      clearInterval(timer);
    }
    expect(result).toMatchObject({ ok: true, method: "acl" });
    expect(ticks, "the event loop kept turning while PowerShell was running").toBeGreaterThan(20);
  });

  it("#4: creating a wallet does not stand the server still either", async () => {
    const driver = new LocalWalletDriver(path.join(root, "create-nonblocking"), FAST_SCRYPT);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      await driver.createWithPhrase();
    } finally {
      clearInterval(timer);
    }
    expect(driver.secretProtection).toMatchObject({ ok: true });
    expect(ticks, "create kept the event loop turning across both PowerShell calls").toBeGreaterThan(40);
  });

  it("#4: a PowerShell that never answers is cut off at the timeout and reported as not protected, without blocking anything", async () => {
    const dir = path.join(root, "hangs");
    fs.mkdirSync(dir);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const started = Date.now();
    let result;
    try {
      result = await defaultProtector({ timeoutMs: 700, script: "Start-Sleep -Seconds 60" })({ dir });
    } finally {
      clearInterval(timer);
    }
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not answer within/i);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(ticks).toBeGreaterThan(20);
  });

  it("#3: the real read-back on this machine is by SID: the current user and SYSTEM only", async () => {
    const dir = path.join(root, "by-sid");
    fs.mkdirSync(dir);
    const result = await defaultProtector()({ dir });
    expect(result).toEqual({ ok: true, method: "acl" });
    // the same two SIDs icacls reports (and no BUILTIN\Users, Administrators or Authenticated Users)
    expect(aclOf(dir).trustees).toEqual([currentSid(), "S-1-5-18"].sort());
  });
});
