// Server side of the third review round, as far as it applies to the reduced surface: startup log lines (#8) and retired copies of the
// key of a legacy password wallet (#1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HDNodeWallet } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "@moneyswitch/wallet";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { writeLegacyPasswordWallet } from "../legacy-wallet.js";
import { buildContext, unlockWalletOnStartup } from "../../src/context.js";

// Cheap scrypt, no OS-level ACL work, and a short drain so a refused replace answers at once.
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const;

process.env.LOG_LEVEL = "silent";

let t: TestCtx;
let headers: { authorization: string };

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("rpc down", { status: 503 }))); // nothing here may reach a real RPC endpoint
  t = await buildTestApp({ walletOptions: FAST });
  headers = { authorization: `Bearer ${t.adminToken}` };
}, 60_000);
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (t) await cleanupTestApp(t);
});

const get = (url: string) => t.app.inject({ method: "GET", url, headers });
const post = (url: string, payload?: unknown) => t.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const walletInfo = async () => (await get("/v1/admin/wallet")).json();
const secretFile = (address: string) => unlockSecretPath(t.tmpDir, address);

/** Captures everything the startup unlock logs. */
function captureLogs() {
  const lines: string[] = [];
  for (const method of ["log", "error", "warn"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// #8
// ---------------------------------------------------------------------------------------------------------------

describe("#8: startup says what happened to a secret that was moved to retired/", () => {
  /** Wallet A in t.tmpDir, then a different key's wallet.json for one start (the secret of A is moved aside), then A's wallet.json back. */
  async function aThenForeignThenBack() {
    const a = await t.ctx.wallet.createWithPhrase();
    const aKeystore = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const aSecret = fs.readFileSync(secretFile(a.address), "utf-8");
    const other = fs.mkdtempSync(path.join(t.tmpDir, "other-"));
    await new LocalWalletDriver(other, FAST as never).createWithPhrase();
    fs.writeFileSync(walletFilePath(t.tmpDir), fs.readFileSync(path.join(other, "wallet.json"), "utf-8"));
    const quiet = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    quiet.length = 0;
    vi.restoreAllMocks();
    const retiredFile = fs.readdirSync(path.join(t.tmpDir, "retired"))[0];
    fs.writeFileSync(walletFilePath(t.tmpDir), aKeystore);
    return { a, aSecret, retiredFile };
  }

  it("when the right wallet.json is back, the secret is moved back, the wallet unlocks, and the log says so (not 'restore from a backup')", async () => {
    const { a, aSecret, retiredFile } = await aThenForeignThenBack();
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    const log = lines.join("\n");
    expect(log).toContain(`retired/${retiredFile}`);
    expect(log).toMatch(/moved back/i);
    expect(log).not.toMatch(/restore that file from a backup/i);
    expect(log).not.toContain(aSecret.trim());
    const info = await walletInfo();
    expect(info).toMatchObject({ address: a.address, unlocked: true });
    expect(info.health).toMatchObject({ protection: "auto", auto_unlock_ok: true, secret_file_present: true });
    expect(fs.readFileSync(secretFile(a.address), "utf-8")).toBe(aSecret);
  });

  it("when the retired copy does not open the wallet, the error names that exact file instead of a generic 'restore from a backup'", async () => {
    const { a, retiredFile } = await aThenForeignThenBack();
    fs.writeFileSync(path.join(t.tmpDir, "retired", retiredFile), "cd".repeat(32));
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    const log = lines.join("\n");
    expect(log).toContain(`retired/${retiredFile}`);
    expect(log).toMatch(/is missing/);
    expect(log).not.toContain("cdcd");
    const info = await walletInfo();
    expect(info).toMatchObject({ address: a.address, unlocked: false });
    expect(info.health.unlock_sources).toEqual([{ source: "auto", ok: false, reason: "secret_missing" }]);
  });

  it("a missing secret with nothing in retired/ for it keeps the generic advice", async () => {
    const a = await t.ctx.wallet.createWithPhrase();
    fs.rmSync(secretFile(a.address));
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect(lines.join("\n")).toMatch(/is missing/);
    expect(lines.join("\n")).toMatch(/backup of the data directory/i);
    expect(lines.join("\n")).not.toContain("retired/orphan");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// #1
// ---------------------------------------------------------------------------------------------------------------

describe("#1: a retired secret that opens a legacy password wallet is flagged in health and in the startup log, and removed once the startup password proves the wallet reachable", () => {
  /**
   * The legacy password wallet whose key was once an auto wallet: the retired pair of that very key still opens it without the
   * password. (It came about when the old import feature put the key back with a password; built by hand here.)
   */
  async function legacyWalletWithAnOpenerInRetired() {
    const first = await t.ctx.wallet.createWithPhrase();
    const replaced = await t.ctx.wallet.replaceWallet(); // the pair of \`first\` is now in retired/
    fs.rmSync(path.join(t.tmpDir, "wallet.json"));
    for (const f of fs.readdirSync(t.tmpDir)) if (/^wallet-unlock-0x[0-9a-f]{40}\.secret$/.test(f)) fs.rmSync(path.join(t.tmpDir, f));
    await writeLegacyPasswordWallet(t.tmpDir, "legacy-pass-1", { wallet: HDNodeWallet.fromPhrase(first.mnemonic) });
    return { first, retiredSecret: replaced.retired.secretFile! };
  }
  const retiredNames = () => fs.readdirSync(path.join(t.tmpDir, "retired")).sort();

  it("while the wallet is locked it is only flagged (health, startup log): nothing is deleted without the password", async () => {
    const { retiredSecret } = await legacyWalletWithAnOpenerInRetired();
    const before = retiredNames();
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, "not-the-password");
    const info = await walletInfo();
    expect(info.unlocked).toBe(false);
    expect(info.health.retired_secrets_open_live_key).toEqual([retiredSecret]);
    expect(lines.join("\n")).toMatch(/retired\/.*still opens this wallet without the password/i);
    expect(lines.join("\n")).toContain(retiredSecret);
    expect(retiredNames()).toEqual(before);
  });

  it("the startup password proves it reachable: that secret goes and health flags nothing", async () => {
    const { first, retiredSecret } = await legacyWalletWithAnOpenerInRetired();
    captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, "legacy-pass-1");
    const info = await walletInfo();
    expect(info).toMatchObject({ address: first.address, unlocked: true });
    expect(info.health.retired_secrets_open_live_key).toEqual([]);
    expect(retiredNames()).not.toContain(retiredSecret);
  });

  it("a retired secret that cannot be removed is flagged in health (with its name) even though the wallet unlocked", async () => {
    const { retiredSecret } = await legacyWalletWithAnOpenerInRetired();
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      if (String(file).endsWith(retiredSecret)) throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return realUnlink(file);
    }) as never);
    captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, "legacy-pass-1");
    vi.restoreAllMocks();
    const info = await walletInfo();
    expect(info.unlocked).toBe(true); // the password is in place; the leftover is a warning, not a failure
    expect(info.health.retired_secrets_open_live_key).toEqual([retiredSecret]);
    expect(retiredNames()).toContain(retiredSecret);
  });

  it("an auto-unlock wallet has nothing to flag (the live secret is on the same disk anyway)", async () => {
    await t.ctx.wallet.createWithPhrase();
    await t.ctx.wallet.replaceWallet();
    captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect((await walletInfo()).health.retired_secrets_open_live_key).toEqual([]);
  });
});

describe("#1: buildContext audits every deletion from retired/", () => {
  it("the audit row names the files and what triggered it (the startup password), never a secret", async () => {
    const dir = fs.mkdtempSync(path.join(t.tmpDir, "ctx-"));
    const config = { port: 18557, host: "127.0.0.1", dataDir: dir, dbFilePath: path.join(dir, "db.sqlite"), walletPassword: null as string | null };
    captureLogs();
    const first = await buildContext(config, { walletOptions: FAST });
    let removed: string[];
    try {
      const created = await first.wallet.createWithPhrase();
      const replaced = await first.wallet.replaceWallet();
      // the live wallet becomes a legacy password wallet holding the key whose retired pair still opens it
      fs.rmSync(path.join(dir, "wallet.json"));
      for (const f of fs.readdirSync(dir)) if (/^wallet-unlock-0x[0-9a-f]{40}\.secret$/.test(f)) fs.rmSync(path.join(dir, f));
      await writeLegacyPasswordWallet(dir, "legacy-pass-1", { wallet: HDNodeWallet.fromPhrase(created.mnemonic) });
      removed = [replaced.retired.secretFile!];
    } finally {
      first.sqlite.close();
    }
    const secretText = removed.map((f) => fs.readFileSync(path.join(dir, "retired", f), "utf-8").trim());

    config.walletPassword = "legacy-pass-1";
    const ctx = await buildContext(config, { walletOptions: FAST }); // the restart: the startup password proves the wallet reachable
    try {
      const rows = ctx.sqlite.prepare("SELECT actor, action, detail FROM audit_log WHERE action = 'wallet.retired_secrets_removed'").all() as Array<{ actor: string; action: string; detail: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe("system");
      expect(JSON.parse(rows[0].detail)).toEqual({ files: removed, trigger: "startup_password" });
      for (const secret of secretText) expect(rows[0].detail).not.toContain(secret);
    } finally {
      ctx.sqlite.close();
    }
  });
});
