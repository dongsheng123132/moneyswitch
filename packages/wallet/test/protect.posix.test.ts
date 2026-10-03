// M3 on POSIX: the data directory is 0700 and the unlock secret 0600 (verified, not assumed). Skipped on Windows,
// where protect.win32.test.ts covers the ACL equivalent.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWalletDriver } from "../src/index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-posix-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const FAST_SCRYPT = { scrypt: { N: 2 ** 10, r: 8, p: 1 } };
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const secretIn = (dir: string) => path.join(dir, fs.readdirSync(dir).find((f) => /^wallet-unlock.*\.secret$/.test(f))!);

describe.skipIf(process.platform === "win32")("POSIX: 0700 data directory, 0600 secret", () => {
  it("creating an auto-unlock wallet makes the directory 0700 and the secret 0600, and reports it", async () => {
    const dir = path.join(root, "data");
    fs.mkdirSync(dir, { mode: 0o755 });
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    await driver.createWithPhrase();
    expect(mode(dir)).toBe(0o700);
    expect(mode(secretIn(dir))).toBe(0o600);
    expect(mode(path.join(dir, "wallet.json"))).toBe(0o600);
    expect(driver.secretProtection).toMatchObject({ ok: true, method: "posix" });
  });

  it("a restart tightens a directory or secret that was loosened", async () => {
    const dir = path.join(root, "repair");
    await new LocalWalletDriver(dir, FAST_SCRYPT).createWithPhrase();
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(secretIn(dir), 0o644);
    const restarted = new LocalWalletDriver(dir, FAST_SCRYPT);
    expect((await restarted.unlockOnStartup({})).unlocked).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(mode(secretIn(dir))).toBe(0o600);
    expect(restarted.secretProtection).toMatchObject({ ok: true });
  });

  it("retired files and the retired directory are private too", async () => {
    const dir = path.join(root, "retired");
    const driver = new LocalWalletDriver(dir, FAST_SCRYPT);
    await driver.createWithPhrase();
    await driver.replaceWallet();
    expect(mode(path.join(dir, "retired"))).toBe(0o700);
    for (const f of fs.readdirSync(path.join(dir, "retired"))) expect(mode(path.join(dir, "retired", f)) & 0o077, f).toBe(0);
  });
});
