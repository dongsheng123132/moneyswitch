// Server side of the third review round: startup log lines (#8), retired copies of the live key (#1), draining replace (#2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "@moneyswitch/wallet";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { unlockWalletOnStartup } from "../../src/context.js";

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
