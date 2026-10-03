// Server side of the third review round: startup log lines (#8), retired copies of the live key (#1), draining replace (#2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "@moneyswitch/wallet";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
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

describe("#1: the routes report what the driver removed from retired/, and health flags what it could not", () => {
  const key = Wallet.createRandom();
  async function sameKeyReplaced() {
    expect((await post("/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey })).statusCode).toBe(200);
    const replaced = await post("/v1/admin/wallet/replace", { confirm_address: key.address, kind: "private_key", private_key: key.privateKey });
    expect(replaced.statusCode).toBe(200);
    return replaced.json();
  }
  const retiredSecretFiles = () => fs.readdirSync(path.join(t.tmpDir, "retired")).filter((f) => f.endsWith(".secret"));

  it("OFF: the response names the removed files, /retired no longer claims a secret file, health flags nothing", async () => {
    await sameKeyReplaced();
    const before = (await get("/v1/admin/wallet/retired")).json();
    expect(before.retired_wallets[0].has_secret_file).toBe(true);
    const names = retiredSecretFiles();
    expect(names.length).toBeGreaterThan(0);

    const off = await post("/v1/admin/wallet/auto-unlock", { enabled: false, password: "second-pass-2" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ address: key.address, unlock_mode: "manual", auto_unlock_ok: null });
    expect([...off.json().retired_secrets_removed].sort()).toEqual([...names].sort());
    expect(off.json().retired_secrets_still_open).toBeUndefined();
    expect(retiredSecretFiles()).toEqual([]);
    expect((await get("/v1/admin/wallet/retired")).json().retired_wallets[0].has_secret_file).toBe(false);
    expect((await walletInfo()).health.retired_secrets_open_live_key).toEqual([]);
  });

  it("OFF in the ordinary case answers exactly what it always did (no new keys)", async () => {
    await post("/v1/admin/wallet/create", {});
    const off = await post("/v1/admin/wallet/auto-unlock", { enabled: false, password: "second-pass-2" });
    expect(Object.keys(off.json()).sort()).toEqual(["address", "auto_unlock_ok", "unlock_mode"]);
  });

  it("import with a password: the response names what it removed", async () => {
    await sameKeyReplaced();
    await post("/v1/admin/wallet/replace", { confirm_address: key.address });
    fs.rmSync(path.join(t.tmpDir, "wallet.json")); // wallet.json lost; the key is imported again, this time protected by a password
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    const imported = await post("/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey, password: "manual-pass-1" });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().address).toBe(key.address);
    expect(imported.json().retired_secrets_removed.length).toBeGreaterThan(0);
  });

  it("replace back to the same key in password mode: the response names what it removed", async () => {
    await sameKeyReplaced();
    const back = await post("/v1/admin/wallet/replace", { confirm_address: key.address, kind: "private_key", private_key: key.privateKey, password: "manual-pass-1" });
    expect(back.statusCode).toBe(200);
    expect(back.json().retired_secrets_removed.length).toBeGreaterThan(0);
    expect(retiredSecretFiles()).toEqual([]);
  });

  it("a retired secret that cannot be removed is flagged in health (with its name) until the password is used", async () => {
    await sameKeyReplaced();
    const stuck = retiredSecretFiles()[0];
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      if (String(file).endsWith(stuck)) throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return realUnlink(file);
    }) as never);
    const off = await post("/v1/admin/wallet/auto-unlock", { enabled: false, password: "second-pass-2" });
    vi.restoreAllMocks();
    expect(off.statusCode).toBe(200); // the password is in place; this is a warning, not a failure
    expect(off.json().retired_secrets_still_open).toEqual([stuck]);
    expect((await walletInfo()).health.retired_secrets_open_live_key).toEqual([stuck]);

    // after a restart the wallet is locked: flagged, never cleaned up without the password
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect((await walletInfo()).health.retired_secrets_open_live_key).toEqual([stuck]);
    expect(lines.join("\n")).toContain(stuck);
    expect(fs.existsSync(path.join(t.tmpDir, "retired", stuck))).toBe(true);

    expect((await post("/v1/admin/wallet/unlock", { password: "second-pass-2" })).statusCode).toBe(200);
    expect((await walletInfo()).health.retired_secrets_open_live_key).toEqual([]);
    expect(fs.existsSync(path.join(t.tmpDir, "retired", stuck))).toBe(false);
  });

  it("the startup log says it plainly when a locked password wallet can be opened from retired/", async () => {
    await sameKeyReplaced();
    const stuck = retiredSecretFiles()[0];
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((file: fs.PathLike) => {
      if (String(file).endsWith(stuck)) throw Object.assign(new Error("access denied"), { code: "EPERM" });
      return realUnlink(file);
    }) as never);
    await post("/v1/admin/wallet/auto-unlock", { enabled: false, password: "second-pass-2" });
    vi.restoreAllMocks();
    const lines = captureLogs();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST as never);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect(lines.join("\n")).toMatch(/retired\/.*still opens this wallet without the password/i);
  });
});

describe("#1: buildContext audits every deletion from retired/", () => {
  it("the audit row names the files and what triggered it, never a secret", async () => {
    const dir = fs.mkdtempSync(path.join(t.tmpDir, "ctx-"));
    const config = { port: 18557, host: "127.0.0.1", dataDir: dir, dbFilePath: path.join(dir, "db.sqlite"), walletPassword: null };
    captureLogs();
    const ctx = await buildContext(config, { walletOptions: FAST });
    try {
      const key = Wallet.createRandom().privateKey;
      await ctx.wallet.importFrom({ kind: "private_key", private_key: key });
      await ctx.wallet.replaceWallet({ kind: "import", source: { kind: "private_key", private_key: key } });
      const secretText = fs.readdirSync(path.join(dir, "retired")).filter((f) => f.endsWith(".secret")).map((f) => fs.readFileSync(path.join(dir, "retired", f), "utf-8").trim());
      const off = await ctx.wallet.disableAutoUnlock("second-pass-2");
      const rows = ctx.sqlite.prepare("SELECT actor, action, detail FROM audit_log WHERE action = 'wallet.retired_secrets_removed'").all() as Array<{ actor: string; action: string; detail: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe("system");
      expect(JSON.parse(rows[0].detail)).toEqual({ files: off.retiredSecretsRemoved, trigger: "auto_unlock_off" });
      for (const secret of secretText) expect(rows[0].detail).not.toContain(secret);
    } finally {
      ctx.sqlite.close();
    }
  });
});
