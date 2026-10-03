// Server side of the security review of the wallet lifecycle: m6 (health follows the RECORDED mode and names the reason
// each unlock source failed), M1 (orphan credentials are reported), M2 (imports keep only the key), M3 (the protection
// of the secret is reported), m7 (expected_address), M4 (startup sweep of stale reservations) and M5 (leases).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet, HDNodeWallet, encryptKeystoreJson } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath, type Protector } from "@moneyswitch/wallet";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { buildContext, unlockWalletOnStartup } from "../../src/context.js";

// Cheap scrypt and no OS-level ACL work (that is exercised for real in packages/wallet and in the e2e suite).
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false } as const;
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

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
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
};

/** A fresh process on the same data dir: new driver, then the real startup unlock. */
async function restart(password: string | null = null, options: Record<string, unknown> = {}) {
  t.ctx.wallet = new LocalWalletDriver(t.tmpDir, { ...FAST, ...options } as never);
  await unlockWalletOnStartup(t.ctx.wallet, password);
}
async function createAuto() {
  const res = await post("/v1/admin/wallet/create", {});
  expect(res.statusCode).toBe(200);
  return res.json() as { address: string; recovery_phrase: string };
}

// ---------------------------------------------------------------------------------------------------------------
// m6
// ---------------------------------------------------------------------------------------------------------------

describe("m6: health follows the mode recorded in wallet.json and names the reason each unlock source failed", () => {
  it("(a) an auto wallet whose secret went missing is still AUTO: locked, secret_missing, and /backup explains instead of shrugging", async () => {
    quiet();
    const created = await createAuto();
    fs.rmSync(secretFile(created.address));
    await restart();
    const info = await walletInfo();
    expect(info.unlocked).toBe(false);
    expect(info.health).toMatchObject({
      protection: "auto",
      unlock_mode: "auto",
      auto_unlock_ok: false,
      unlock_sources: [{ source: "auto", ok: false, reason: "secret_missing" }],
    });
    const plain = await post("/v1/admin/wallet/backup");
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error).toBe("BACKUP_NEEDS_PASSWORD");
  });

  it("(b) a stale env password and a wrong secret are two separate findings; the secret is not blamed on the env var (nor the env var on the secret)", async () => {
    const errors = quiet();
    const created = await createAuto();
    fs.writeFileSync(secretFile(created.address), "ab".repeat(32));
    t.ctx.config.walletPassword = "stale-env-password";
    await restart("stale-env-password");
    const info = await walletInfo();
    expect(info.unlocked).toBe(false);
    expect(info.health).toMatchObject({
      protection: "auto",
      unlock_mode: "auto",
      auto_unlock_ok: false,
      unlock_sources: [
        { source: "env_or_file", ok: false, reason: "env_wrong" },
        { source: "auto", ok: false, reason: "secret_wrong" },
      ],
    });
    const lines = errors.mock.calls.map((c) => c.join(" "));
    const envLine = lines.find((l) => l.includes("MONEYSWITCH_WALLET_PASSWORD"));
    const secretLine = lines.find((l) => /unlock secret/i.test(l));
    expect(envLine, lines.join("\n")).toBeDefined();
    expect(secretLine, lines.join("\n")).toBeDefined();
    expect(secretLine).not.toContain("MONEYSWITCH_WALLET_PASSWORD");
    expect(envLine).not.toMatch(/unlock secret/i);
    expect(lines.join("\n")).not.toMatch(/stale-env-password|abab/);
  });

  it("(c) a manual wallet created next to a leftover secret is MANUAL: not 'auto broken', and /backup hands out wallet.json", async () => {
    quiet();
    const stray = Wallet.createRandom().address;
    fs.writeFileSync(unlockSecretPath(t.tmpDir, stray), "12".repeat(32));
    const created = await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    expect(created.statusCode).toBe(200);
    const info = await walletInfo();
    expect(info.health).toMatchObject({ protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [] });
    expect(info.auto_unlock_configured).toBe(false);
    const backup = await post("/v1/admin/wallet/backup");
    expect(backup.statusCode).toBe(200);
    expect((await Wallet.fromEncryptedJson(backup.json().keystore, "manual-pass-1")).address).toBe(created.json().address);

    await restart(); // no secret is tried, nothing is "broken"
    const again = await walletInfo();
    expect(again.unlocked).toBe(false);
    expect(again.health).toMatchObject({ protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [] });
  });

  it("(c') a key imported as a manual wallet while ITS OLD secret is still lying around is manual too; startup then moves the old secret to retired/", async () => {
    quiet();
    const key = Wallet.createRandom();
    fs.writeFileSync(unlockSecretPath(t.tmpDir, key.address), "34".repeat(32));
    expect((await post("/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey, password: "manual-pass-1" })).statusCode).toBe(200);
    expect((await walletInfo()).health).toMatchObject({ protection: "password", unlock_mode: "manual", auto_unlock_ok: null });
    expect((await post("/v1/admin/wallet/backup")).statusCode).toBe(200);

    await restart();
    expect(fs.existsSync(secretFile(key.address))).toBe(false);
    const retired = fs.readdirSync(path.join(t.tmpDir, "retired"));
    expect(retired).toHaveLength(1);
    expect(fs.readFileSync(path.join(t.tmpDir, "retired", retired[0]), "utf-8")).toBe("34".repeat(32));
  });

  it("an auto wallet whose secret file disappears WHILE RUNNING is flagged before the restart that would fail", async () => {
    const created = await createAuto();
    expect((await walletInfo()).health.secret_file_present).toBe(true);
    fs.rmSync(secretFile(created.address));
    const info = await walletInfo();
    expect(info.unlocked).toBe(true);
    expect(info.health).toMatchObject({ protection: "auto", secret_file_present: false });
  });

  it("a healthy auto start reports its one successful source; a password wallet has no secret file to report on", async () => {
    quiet();
    await createAuto();
    await restart();
    expect((await walletInfo()).health).toMatchObject({
      protection: "auto",
      unlock_mode: "auto",
      auto_unlock_ok: true,
      secret_file_present: true,
      unlock_sources: [{ source: "auto", ok: true }],
    });
  });

  it("without a wallet: protection none, nothing tried", async () => {
    expect((await walletInfo()).health).toMatchObject({
      protection: "none",
      unlock_mode: "none",
      auto_unlock_ok: null,
      unlock_sources: [],
      secret_protected: null,
      secret_file_present: null,
    });
  });

  it("startup writes one log line per source that failed, each with its own reason, and never a credential", async () => {
    const errors = quiet();
    const created = await createAuto();
    const file = secretFile(created.address);
    const original = fs.readFileSync(file, "utf-8");

    const lastErrors = async (password: string | null) => {
      errors.mockClear();
      await restart(password);
      return errors.mock.calls.map((c) => c.join(" ")).join("\n");
    };

    fs.rmSync(file);
    expect(await lastErrors(null)).toMatch(/unlock secret.*(missing|not found)/is);
    fs.writeFileSync(file, "");
    expect(await lastErrors(null)).toMatch(/unlock secret.*empty/is);
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(await lastErrors(null)).toMatch(/unlock secret.*cannot be read/is);
    fs.rmdirSync(file);
    fs.writeFileSync(file, "cd".repeat(32));
    const wrong = await lastErrors("an-old-env-password");
    expect(wrong).toMatch(/MONEYSWITCH_WALLET_PASSWORD/);
    expect(wrong).toMatch(/unlock secret.*does not open/is);
    expect(wrong).not.toMatch(/an-old-env-password|cdcd/);
    fs.writeFileSync(file, original);
    expect(await lastErrors(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M1: orphans are reported
// ---------------------------------------------------------------------------------------------------------------

describe("M1: credentials without a wallet.json are reported, not hidden behind an empty 'create' screen", () => {
  it("wallet.json gone but a secret and retired/ files remain: health lists them", async () => {
    quiet();
    const first = await createAuto();
    const replaced = await post("/v1/admin/wallet/replace", { confirm_address: first.address, reason: "lost_password" });
    expect(replaced.statusCode).toBe(200);
    fs.rmSync(walletFilePath(t.tmpDir));
    await restart();

    const info = await walletInfo();
    expect(info.has_keystore).toBe(false);
    expect(info.address).toBeNull();
    expect(info.health.protection).toBe("none");
    expect(info.health.orphan_files).toEqual({ secrets: [replaced.json().address], retired: 2, wallet_file_missing: true });
  });

  it("the startup log says wallet.json is missing while credential files are present", async () => {
    const errors = quiet();
    const first = await createAuto();
    fs.rmSync(walletFilePath(t.tmpDir));
    expect(fs.existsSync(secretFile(first.address))).toBe(true);
    await restart();
    expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/wallet\.json is missing/i);
  });

  it("creating a wallet in that state keeps the old secret (and a clean data directory reports nothing)", async () => {
    quiet();
    expect((await walletInfo()).health.orphan_files).toEqual({ secrets: [], retired: 0, wallet_file_missing: false });
    const first = await createAuto();
    const secret = fs.readFileSync(secretFile(first.address), "utf-8");
    fs.rmSync(walletFilePath(t.tmpDir));
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST);
    const second = await createAuto();
    expect(second.address).not.toBe(first.address);
    expect(fs.readFileSync(secretFile(first.address), "utf-8")).toBe(secret);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M2
// ---------------------------------------------------------------------------------------------------------------

describe("M2: an imported wallet keeps only its account-0 private key", () => {
  it("a recovery phrase import stores no phrase: reveal returns the private key, there is nothing to back up, and the audit log is clean", async () => {
    expect((await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE })).statusCode).toBe(200);
    const info = await walletInfo();
    expect(info.has_recovery_phrase).toBe(false);
    expect(info.health.backup).toBe("not_applicable");
    const revealed = await post("/v1/admin/wallet/reveal", { confirm_address: HARDHAT_ADDRESS });
    expect(revealed.json()).toEqual({ address: HARDHAT_ADDRESS, kind: "private_key", private_key: HDNodeWallet.fromPhrase(HARDHAT_PHRASE).privateKey });
    expect(revealed.body).not.toContain("junk");
    const on = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    expect(JSON.parse(on)["x-ethers"]?.mnemonicCiphertext).toBeUndefined();
    // and it cannot be "confirmed"
    expect((await post("/v1/admin/wallet/backup/confirm", { positions: [1, 2], words: ["test", "test"] })).json().error).toBe("NO_RECOVERY_PHRASE");
  });

  it("a keystore that carries a phrase on a non-default path is imported as the bare key it signs with", async () => {
    const hd = HDNodeWallet.fromPhrase(HARDHAT_PHRASE, undefined, "m/44'/60'/0'/0/5");
    const source = await encryptKeystoreJson(
      { address: hd.address, privateKey: hd.privateKey, mnemonic: { path: "m/44'/60'/0'/0/5", locale: "en", entropy: hd.mnemonic!.entropy } },
      "source-pass-1",
      FAST
    );
    expect((await post("/v1/admin/wallet/import", { kind: "keystore", keystore: source, source_password: "source-pass-1" })).statusCode).toBe(200);
    expect((await walletInfo()).address).toBe(hd.address);
    const revealed = await post("/v1/admin/wallet/reveal", { confirm_address: hd.address });
    expect(revealed.json()).toEqual({ address: hd.address, kind: "private_key", private_key: hd.privateKey });
  });

  it("replacing with an imported phrase keeps only the key too", async () => {
    quiet();
    const old = await createAuto();
    expect((await post("/v1/admin/wallet/replace", { confirm_address: old.address, kind: "mnemonic", mnemonic: HARDHAT_PHRASE })).statusCode).toBe(200);
    const revealed = await post("/v1/admin/wallet/reveal", { confirm_address: HARDHAT_ADDRESS });
    expect(revealed.json().kind).toBe("private_key");
    expect((await walletInfo()).has_recovery_phrase).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M3
// ---------------------------------------------------------------------------------------------------------------

describe("M3: the protection of the data directory and the unlock secret is verified and reported", () => {
  const failing: Protector = () => ({ ok: false, method: "acl", detail: "simulated: could not set the ACL (access denied)" });
  const working: Protector = () => ({ ok: true, method: "posix" });

  it("when it cannot be applied or verified, auto mode still works and health says secret_protected=false with the reason", async () => {
    quiet();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, { ...FAST, protect: failing } as never);
    const created = await createAuto();
    const info = await walletInfo();
    expect(info.unlocked).toBe(true);
    expect(info.health).toMatchObject({ protection: "auto", unlock_mode: "auto", auto_unlock_ok: true, secret_protected: false });
    expect(info.health.secret_protection_detail).toContain("could not set the ACL");

    await restart(null, { protect: failing }); // and it keeps being reported after a restart
    const again = await walletInfo();
    expect(again.address).toBe(created.address);
    expect(again.unlocked).toBe(true);
    expect(again.health).toMatchObject({ secret_protected: false });
  });

  it("when it is verified, secret_protected is true and there is no detail", async () => {
    quiet();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, { ...FAST, protect: working } as never);
    await createAuto();
    expect((await walletInfo()).health).toMatchObject({ secret_protected: true, secret_protection_detail: null });
  });

  it("a password wallet has no secret on disk, so there is nothing to report (null, not a false alarm)", async () => {
    quiet();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, { ...FAST, protect: failing } as never);
    await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    expect((await walletInfo()).health).toMatchObject({ secret_protected: null, secret_protection_detail: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// m7
// ---------------------------------------------------------------------------------------------------------------

describe("m7: expected_address makes import and replace refuse a key that belongs to another address", () => {
  it("import: a match (any letter case) is accepted", async () => {
    const res = await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE, expected_address: HARDHAT_ADDRESS.toLowerCase() });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe(HARDHAT_ADDRESS);
  });

  it("import: a mismatch is refused with EXPECTED_ADDRESS_MISMATCH and creates nothing", async () => {
    const other = Wallet.createRandom().address;
    const res = await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE, expected_address: other });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("EXPECTED_ADDRESS_MISMATCH");
    expect(res.body).not.toContain("junk");
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
    expect(fs.readdirSync(t.tmpDir)).toEqual([]);
  });

  it("import: expected_address must be a string", async () => {
    const res = await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE, expected_address: 12345 });
    expect(res.statusCode).toBe(400);
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
  });

  it("replace: a mismatch is refused before any file is touched", async () => {
    quiet();
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const files = fs.readdirSync(t.tmpDir).sort();
    const res = await post("/v1/admin/wallet/replace", {
      confirm_address: old.address,
      kind: "mnemonic",
      mnemonic: HARDHAT_PHRASE,
      expected_address: Wallet.createRandom().address,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("EXPECTED_ADDRESS_MISMATCH");
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual(files);
    const ok = await post("/v1/admin/wallet/replace", { confirm_address: old.address, kind: "mnemonic", mnemonic: HARDHAT_PHRASE, expected_address: HARDHAT_ADDRESS });
    expect(ok.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M5 (route level; the full in-flight paid fetch is in test/e2e/wallet-inflight.test.ts)
// ---------------------------------------------------------------------------------------------------------------

describe("M5: replace is refused while a request holds the signer", () => {
  it("409 WALLET_BUSY while a lease is open, nothing touched; fine once it is released", async () => {
    quiet();
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const files = fs.readdirSync(t.tmpDir).sort();
    const lease = t.ctx.wallet.leaseSigner()!;
    expect(t.ctx.wallet.inFlight).toBe(1);

    const busy = await post("/v1/admin/wallet/replace", { confirm_address: old.address });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("WALLET_BUSY");
    expect(busy.json().message).toMatch(/in flight|finish/i);
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual(files);
    expect(t.ctx.sqlite.prepare("SELECT count(*) AS n FROM wallet_retirements").get()).toEqual({ n: 0 });

    lease.release();
    expect((await post("/v1/admin/wallet/replace", { confirm_address: old.address })).statusCode).toBe(200);
  });

  it("a payment row in status reserved no longer blocks anything by itself (the in-process lease does)", async () => {
    quiet();
    const old = await createAuto();
    const now = new Date().toISOString();
    t.ctx.sqlite
      .prepare(
        `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind)
         VALUES ('pay-stale', 'k', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, 'reserved', ?, ?, 'fetch')`
      )
      .run(now, now);
    expect((await post("/v1/admin/wallet/replace", { confirm_address: old.address })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M4(a)
// ---------------------------------------------------------------------------------------------------------------

describe("M4(a): at startup, before serving, payments a dead process left reserved are resolved", () => {
  it("buildContext moves reserved rows WITH a captured authorization to unknown and those WITHOUT to failed, and leaves everything else alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-sweep-ctx-"));
    const config = { port: 18556, host: "127.0.0.1", dataDir: dir, dbFilePath: path.join(dir, "db.sqlite"), walletPassword: null };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = await buildContext(config);
      const longAgo = new Date(Date.now() - 3_600_000).toISOString();
      const insert = first.sqlite.prepare(
        `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind, auth_from, auth_nonce, auth_valid_before)
         VALUES (?, 'k', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, ?, ?, ?, 'fetch', ?, ?, ?)`
      );
      insert.run("signed", "reserved", longAgo, longAgo, "0x00000000000000000000000000000000000000aa", "0x" + "11".repeat(32), Math.floor(Date.now() / 1000) + 60);
      insert.run("unsigned", "reserved", longAgo, longAgo, null, null, null);
      insert.run("done", "settled", longAgo, longAgo, null, null, null);
      insert.run("held", "unknown", longAgo, longAgo, null, null, null);
      first.sqlite.close(); // the process "dies"

      const second = await buildContext(config); // the restart: the sweep has run by the time this returns
      const rows = Object.fromEntries(
        (second.sqlite.prepare("SELECT id, status, error_code FROM payments").all() as Array<{ id: string; status: string; error_code: string | null }>).map((r) => [r.id, r])
      );
      expect(rows.signed).toMatchObject({ status: "unknown", error_code: "RESTARTED_IN_FLIGHT" });
      expect(rows.unsigned).toMatchObject({ status: "failed", error_code: "RESTARTED_BEFORE_SIGNING" });
      expect(rows.done.status).toBe("settled");
      expect(rows.held.status).toBe("unknown");
      expect(second.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'payment.startup_sweep.%'").get()).toEqual({ n: 2 });
      second.sqlite.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
