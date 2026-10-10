import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Wallet, HDNodeWallet } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "@moneyswitch/wallet";
import { BASE_SEPOLIA, TESTNET, SOLANA_DEVNET } from "@moneyswitch/x402";
import { reconcileUnknownPayments, type AuthorizationReader } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { writeLegacyPasswordWallet } from "../legacy-wallet.js";
import { readWalletPassword } from "../../src/config.js";
import { unlockWalletOnStartup } from "../../src/context.js";

// Test-only: a cheap scrypt keeps the suite fast (the production costs are covered in packages/wallet), and no OS-level
// ACL work (it is exercised for real in packages/wallet/test/protect.*.test.ts).
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const; // (a replace that finds a request in flight waits this long, then answers WALLET_BUSY; production: 60 s)
const HARDHAT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// the request log of the app under test is noise here; tests that inspect logging build their own logger
process.env.LOG_LEVEL = "silent";

let t: TestCtx;
let headers: { authorization: string };

beforeEach(async () => {
  // Nothing in this file may reach a real RPC endpoint: balance reads answer "unreachable" unless a test stubs a value.
  stubRpc({});
  vi.spyOn(console, "log").mockImplementation(() => undefined); // startup "Wallet unlocked…" lines
  t = await buildTestApp({ walletOptions: FAST });
  headers = { authorization: `Bearer ${t.adminToken}` };
}, 60_000);
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.MONEYSWITCH_WALLET_FLOAT_LIMIT;
  delete process.env.MONEYSWITCH_NETWORKS;
  if (t) await cleanupTestApp(t);
});

const get = (url: string, h: Record<string, string> = headers) => t.app.inject({ method: "GET", url, headers: h });
const post = (url: string, payload?: unknown, h: Record<string, string> = headers) =>
  t.app.inject({ method: "POST", url, headers: h, ...(payload === undefined ? {} : { payload: payload as object }) });
const walletInfo = async () => (await get("/v1/admin/wallet")).json();
const auditRows = () => t.ctx.sqlite.prepare("SELECT action, detail FROM audit_log ORDER BY created_at, rowid").all() as Array<{ action: string; detail: string }>;
const auditDump = () => JSON.stringify(auditRows());
/** The unlock secret files in the data directory: one per wallet, named after its (lower-case) address. */
const secretFiles = () => fs.readdirSync(t.tmpDir).filter((f) => /^wallet-unlock-0x[0-9a-f]{40}\.secret$/.test(f));
const secretName = (address: string) => `wallet-unlock-${address.toLowerCase()}.secret`;
/** The content of the (single) live unlock secret. */
const secretOnDisk = () => {
  expect(secretFiles()).toHaveLength(1);
  return fs.readFileSync(path.join(t.tmpDir, secretFiles()[0]), "utf-8");
};

/** A fresh process on the same data dir: new driver, then the real startup unlock. */
async function restart(password: string | null = null) {
  t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST);
  await unlockWalletOnStartup(t.ctx.wallet, password);
}

async function createAuto() {
  const res = await post("/v1/admin/wallet/create", {});
  expect(res.statusCode).toBe(200);
  return res.json() as { address: string; recovery_phrase: string; backup_confirmed: boolean };
}

function stubRpc(balances: Record<string, bigint | "error">) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const value = balances[String(url)];
      if (value === undefined || value === "error") return new Response("rpc down", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + value.toString(16).padStart(64, "0") }));
    })
  );
  return calls;
}

function insertPayment(row: { id: string; status: string; authFrom?: string; authNonce?: string; authValidBefore?: number }) {
  const now = new Date().toISOString();
  t.ctx.sqlite
    .prepare(
      `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind, auth_from, auth_nonce, auth_valid_before)
       VALUES (?, 'k', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, ?, ?, ?, 'fetch', ?, ?, ?)`
    )
    .run(row.id, row.status, now, now, row.authFrom ?? null, row.authNonce ?? null, row.authValidBefore ?? null);
}

describe("access control", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/v1/admin/wallet"],
    ["POST", "/v1/admin/wallet/create", {}],
    ["POST", "/v1/admin/wallet/backup/confirm", {}],
    ["POST", "/v1/admin/wallet/replace", { confirm_address: HARDHAT_ADDRESS }],
  ];

  it("every wallet route rejects a missing token and a MoneyKey with 403, and does nothing", async () => {
    const moneyKey = (
      await post("/v1/keys", { name: "employee", total_budget: "1", daily_budget: "1", per_request_limit: "0.01", allowed_hosts: [] })
    ).json().key as string;
    for (const [method, url, payload] of routes) {
      for (const h of [{}, { authorization: `Bearer ${moneyKey}` }]) {
        const res = await t.app.inject({ method: method as "GET" | "POST", url, headers: h, ...(payload ? { payload: payload as object } : {}) });
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(h).slice(0, 30)}`).toBe(403);
        expect(res.body).not.toMatch(/recovery_phrase|private_key|keystore/);
      }
    }
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
    expect(fs.readdirSync(t.tmpDir)).toEqual([]);
  });

  it("the wallet surface is status, create, the backup acknowledgement and replace: everything else answers 404, even to the administrator", async () => {
    const created = await createAuto();
    const removed: Array<[string, string, unknown?]> = [
      ["POST", "/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: "test test test test test test test test test test test junk" }],
      ["POST", "/v1/admin/wallet/backup", { password: "portable-pass-1" }],
      ["POST", "/v1/admin/wallet/unlock", { password: "whatever-123" }],
      ["POST", "/v1/admin/wallet/reveal", { confirm_address: created.address }],
      ["POST", "/v1/admin/wallet/auto-unlock", { enabled: false, password: "whatever-123" }],
      ["GET", "/v1/admin/wallet/retired"],
    ];
    for (const [method, url, payload] of removed) {
      const res = await t.app.inject({ method: method as "GET" | "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).not.toContain(created.recovery_phrase);
    }
    expect(t.ctx.wallet.isUnlocked()).toBe(true);
  });
});

describe("create", () => {
  it("creates an auto-unlock wallet: a 12-word phrase returned once with no-store, secret file written, address matches the phrase", async () => {
    const res = await post("/v1/admin/wallet/create");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["address", "backup_confirmed", "recovery_phrase"]);
    expect(body.backup_confirmed).toBe(false);
    expect(body.recovery_phrase.split(" ")).toHaveLength(12);
    expect(HDNodeWallet.fromPhrase(body.recovery_phrase).address).toBe(body.address);
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual([secretName(body.address), "wallet.json"]);
    // the secret and the phrase are in no later response
    const later = [await walletInfo(), (await post("/v1/admin/wallet/backup/confirm", { address: body.address })).json()];
    for (const r of later) {
      expect(JSON.stringify(r)).not.toContain(secretOnDisk());
      expect(JSON.stringify(r)).not.toContain(body.recovery_phrase);
    }
    expect(auditDump()).not.toContain(body.recovery_phrase);
    expect(auditDump()).not.toContain(secretOnDisk());
    expect(auditRows().map((r) => r.action)).toContain("wallet.create");
  });

  it.each([
    [{ password: "manual-pass-1" }, "password wallets can no longer be created"],
    [{ password: 12345678 }, "password wallets can no longer be created"],
    [{ mode: "manual" }, "only the auto-unlock mode exists"],
    [{ mode: "sometimes" }, "only the auto-unlock mode exists"],
    [{ kind: "mnemonic", mnemonic: "test test test test test test test test test test test junk" }, "importing a wallet is not supported"],
    [{ kind: "private_key", private_key: "0x" + "11".repeat(32) }, "importing a wallet is not supported"],
  ])("refuses the removed option %j instead of quietly creating something else", async (payload, message) => {
    const res = await post("/v1/admin/wallet/create", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "UNSUPPORTED" });
    expect(res.json().message).toContain(message);
    expect(res.body).not.toContain("11111111");
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
    expect(fs.readdirSync(t.tmpDir)).toEqual([]);
  });

  it("refuses to overwrite an existing wallet", async () => {
    const first = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const again = await post("/v1/admin/wallet/create", {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("WALLET_EXISTS");
    expect(again.body).not.toContain("recovery_phrase\":\"");
    expect((await walletInfo()).address).toBe(first.address);
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
  });
});

describe("health", () => {
  it("no wallet yet", async () => {
    const info = await walletInfo();
    expect(info).toMatchObject({
      address: null,
      unlocked: false,
      has_keystore: false,
      has_recovery_phrase: false,
      backup_confirmed_at: null,
      usdc_balance: null,
      network: TESTNET.caip2,
      retired_wallets: [],
    });
    expect(info.networks).toEqual([
      { address: null, address_url: null, network: TESTNET.caip2, label: TESTNET.label, explorer_base: TESTNET.explorerBase, is_mainnet: false, usdc_balance: null, over_float_limit: null },
    ]);
    expect(info.health).toEqual({
      protection: "none",
      unlock_mode: "none",
      auto_unlock_ok: null,
      unlock_sources: [],
      secret_file_present: null,
      retired_secrets_open_live_key: [],
      secret_protected: null,
      secret_protection_detail: null,
      orphan_files: { secrets: [], retired: 0, wallet_file_missing: false },
      backup: "not_applicable",
      float_limit: "50",
      over_float_limit: {},
    });
  });

  it("reports the address, the lock state and the balance on every enabled chain", async () => {
    const created = await createAuto();
    stubRpc({ [TESTNET.rpcUrl]: 520_000n });
    const info = await walletInfo();
    expect(info).toMatchObject({
      address: created.address,
      unlocked: true,
      has_keystore: true,
      usdc_balance: "0.52",
      network: TESTNET.caip2,
    });
    expect(info.networks).toEqual([
      { address: created.address, address_url: `${TESTNET.explorerBase}/address/${created.address}`, network: TESTNET.caip2, label: TESTNET.label, explorer_base: TESTNET.explorerBase, is_mainnet: false, usdc_balance: "0.52", over_float_limit: false },
    ]);
    expect(info).not.toHaveProperty("auto_unlock_configured");
  });

  it("shows a separate Solana address and Devnet explorer, reads balances with the correct owner, and retains the retired address", async () => {
    process.env.MONEYSWITCH_NETWORKS = `${TESTNET.caip2},${SOLANA_DEVNET.caip2}`;
    const created = await createAuto();
    const oldSolana = t.ctx.wallet.getSolanaAddress()!;
    const svmRead = vi.spyOn(t.ctx.wallet, "getSolanaUsdcBalanceOf").mockResolvedValue(12345n);
    stubRpc({ [TESTNET.rpcUrl]: 520000n });
    const info = await walletInfo();
    expect(info.networks[1]).toMatchObject({ address: oldSolana, address_url: `https://explorer.solana.com/address/${oldSolana}?cluster=devnet`, network: SOLANA_DEVNET.caip2, usdc_balance: "0.012345" });
    expect(oldSolana).not.toBe(created.address);
    expect(svmRead).toHaveBeenCalledWith(oldSolana, SOLANA_DEVNET.rpcUrl, SOLANA_DEVNET.usdcAddress);
    const response = await post("/v1/admin/wallet/replace", { confirm_address: created.address });
    expect(response.statusCode).toBe(200);
    const after = await walletInfo();
    expect(after.retired_wallets[0].solana_address).toBe(oldSolana);
    expect(after.networks[1].address).not.toBe(oldSolana);
    expect(after.retired_wallets[0].balances[SOLANA_DEVNET.caip2]).toBe("0.012345");
  });

  it("auto wallet: unlock_mode auto, last decrypt ok, backup missing until the human says the words are written down", async () => {
    await createAuto();
    const { health, has_recovery_phrase, backup_confirmed_at } = await walletInfo();
    expect(health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: true, backup: "missing" });
    expect(has_recovery_phrase).toBe(true);
    expect(backup_confirmed_at).toBeNull();
  });

  it("survives a restart without any password: unlocked, auto, ok", async () => {
    const created = await createAuto();
    await restart();
    const info = await walletInfo();
    expect(info).toMatchObject({ address: created.address, unlocked: true });
    expect(info.health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: true });
  });

  it("an empty configured password is ignored: still unlocked by the secret, mode auto", async () => {
    await createAuto();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "", MONEYSWITCH_WALLET_PASSWORD_FILE: "" })).toBeNull();
    await restart(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "  " }));
    const { health, unlocked } = await walletInfo();
    expect(unlocked).toBe(true);
    expect(health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: true });
  });

  it("a wrong secret leaves the wallet locked and says auto-unlock is broken", async () => {
    const created = await createAuto();
    fs.writeFileSync(unlockSecretPath(t.tmpDir, created.address), "ab".repeat(32));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await restart();
    const { health, unlocked } = await walletInfo();
    expect(unlocked).toBe(false);
    expect(health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: false });
    expect(errors.mock.calls.flat().join("\n")).toContain("does not open wallet.json");
    expect(errors.mock.calls.flat().join("\n")).not.toContain("abab");
  });

  it("legacy password wallet without a startup password: unlock_mode manual, locked, no auto_unlock_ok; the page can only offer to replace it", async () => {
    await writeLegacyPasswordWallet(t.tmpDir, "manual-pass-1");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await restart();
    const info = await walletInfo();
    expect(info).toMatchObject({ unlocked: false, has_keystore: true });
    expect(info.health).toMatchObject({ protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [], secret_file_present: null });
  });

  it("legacy startup password: env_or_file, and ok=true after it unlocked", async () => {
    const legacy = await writeLegacyPasswordWallet(t.tmpDir, "legacy-pass-1");
    t.ctx.config.walletPassword = "legacy-pass-1";
    await restart("legacy-pass-1");
    const info = await walletInfo();
    expect(info).toMatchObject({ address: legacy.address, unlocked: true });
    expect(info.health).toMatchObject({ protection: "password", unlock_mode: "env_or_file", auto_unlock_ok: true });
  });

  it("a stale legacy password does not lock out a working secret (and the failure is logged without the password)", async () => {
    await createAuto();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await restart("an-outdated-password");
    const info = await walletInfo();
    expect(info.unlocked).toBe(true);
    expect(info.health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: true });
    const logged = errors.mock.calls.flat().join("\n");
    expect(logged).toContain("MONEYSWITCH_WALLET_PASSWORD(_FILE) is set but does not unlock");
    expect(logged).not.toContain("an-outdated-password");
  });

  it("a legacy password that fails with nothing else to try: locked, auto_unlock_ok false, mode env_or_file", async () => {
    await writeLegacyPasswordWallet(t.tmpDir, "legacy-pass-1");
    t.ctx.config.walletPassword = "wrong-legacy-pass";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await restart("wrong-legacy-pass");
    const { health, unlocked } = await walletInfo();
    expect(unlocked).toBe(false);
    expect(health).toMatchObject({ unlock_mode: "env_or_file", auto_unlock_ok: false });
  });

  it("float limit: default 50, MONEYSWITCH_WALLET_FLOAT_LIMIT overrides it, nonsense falls back, and 'over' is per chain where the balance is known", async () => {
    await createAuto();
    process.env.MONEYSWITCH_NETWORKS = `${TESTNET.caip2},${BASE_SEPOLIA.caip2}`;
    stubRpc({ [TESTNET.rpcUrl]: 60_000_000n, [BASE_SEPOLIA.rpcUrl]: "error" });
    let info = await walletInfo();
    expect(info.health.float_limit).toBe("50");
    // 60 USDC on Monad testnet is over; Base Sepolia could not be read, so it is not mentioned at all
    expect(info.health.over_float_limit).toEqual({ [TESTNET.caip2]: true });
    expect(info.usdc_balance).toBe("60");

    // balance exactly at the limit is not "over"
    process.env.MONEYSWITCH_WALLET_FLOAT_LIMIT = "60";
    vi.setSystemTime(Date.now() + 60_000); // past the balance cache
    stubRpc({ [TESTNET.rpcUrl]: 60_000_000n, [BASE_SEPOLIA.rpcUrl]: 1_000_000n });
    info = await walletInfo();
    expect(info.health.float_limit).toBe("60");
    expect(info.health.over_float_limit).toEqual({ [TESTNET.caip2]: false, [BASE_SEPOLIA.caip2]: false });

    for (const bad of ["", "abc", "-5", "0", "1e3"]) {
      process.env.MONEYSWITCH_WALLET_FLOAT_LIMIT = bad;
      expect((await walletInfo()).health.float_limit, bad).toBe("50");
    }
    process.env.MONEYSWITCH_WALLET_FLOAT_LIMIT = "12.5";
    expect((await walletInfo()).health.float_limit).toBe("12.5");
  });

  it("balances are shared between polls (a dashboard polling every few seconds does not multiply RPC calls)", async () => {
    await createAuto();
    const calls = stubRpc({ [TESTNET.rpcUrl]: 1_000_000n });
    await walletInfo();
    await walletInfo();
    await Promise.all([walletInfo(), walletInfo()]);
    expect(calls).toHaveLength(1);
  });
});

describe("backup acknowledgement ('I wrote the words down')", () => {
  /** The acknowledgement names the wallet whose words were written down; by default the one that is current. */
  const acknowledge = async (address?: string) => post("/v1/admin/wallet/backup/confirm", { address: address ?? (await walletInfo()).address });

  it("records backup_confirmed_at and flips health.backup to confirmed; no word is asked for, and a second click keeps the first time", async () => {
    await createAuto();
    expect((await walletInfo()).health.backup).toBe("missing");
    const res = await acknowledge();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().confirmed).toBe(true);
    const info = await walletInfo();
    expect(info.health.backup).toBe("confirmed");
    expect(info.backup_confirmed_at).toBe(res.json().backup_confirmed_at);
    expect(auditRows().map((r) => r.action)).toContain("wallet.backup.confirm");
    const again = await acknowledge();
    expect(again.json().backup_confirmed_at).toBe(res.json().backup_confirmed_at);
  });

  it("is tied to a wallet: it must say whose words were written down (no address: 400, nothing recorded)", async () => {
    await createAuto();
    for (const payload of [{}, { address: "" }, { address: 5 }, { address: null }]) {
      const res = await post("/v1/admin/wallet/backup/confirm", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe("ADDRESS_REQUIRED");
    }
    expect((await walletInfo()).health.backup).toBe("missing");
  });

  it("a replace that lands between showing the words and the click cannot mark the NEW wallet as backed up: 409, nothing recorded", async () => {
    const first = await createAuto(); // the words on screen belong to this wallet
    const replaced = await post("/v1/admin/wallet/replace", { confirm_address: first.address });
    expect(replaced.statusCode).toBe(200);
    const second = replaced.json() as { address: string };
    expect(second.address).not.toBe(first.address);

    const stale = await acknowledge(first.address); // the click for the old words, after the swap
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("WALLET_CHANGED");
    const info = await walletInfo();
    expect(info.address).toBe(second.address);
    expect(info.health.backup).toBe("missing");
    expect(info.backup_confirmed_at).toBeNull();
    expect(auditRows().map((r) => r.action)).not.toContain("wallet.backup.confirm");

    // the words of the wallet that IS current can still be acknowledged
    expect((await acknowledge(second.address)).statusCode).toBe(200);
    expect((await walletInfo()).health.backup).toBe("confirmed");
  });

  it("an address that was never this server's wallet is refused the same way", async () => {
    await createAuto();
    const res = await acknowledge(HARDHAT_ADDRESS);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("WALLET_CHANGED");
    expect((await walletInfo()).health.backup).toBe("missing");
  });

  it("the address is compared without regard to letter case (checksummed or lower-case)", async () => {
    const created = await createAuto();
    expect((await acknowledge(created.address.toLowerCase())).statusCode).toBe(200);
    expect((await acknowledge(created.address)).statusCode).toBe(200);
  });

  it("needs a wallet that has a recovery phrase", async () => {
    expect((await post("/v1/admin/wallet/backup/confirm", { address: HARDHAT_ADDRESS })).statusCode).toBe(404);
    // an older wallet made from a bare private key has nothing to write down
    const key = Wallet.createRandom();
    await writeLegacyPasswordWallet(t.tmpDir, "legacy-pass-1", { wallet: new Wallet(key.privateKey) });
    expect((await walletInfo()).health.backup).toBe("not_applicable");
    const res = await acknowledge();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NO_RECOVERY_PHRASE");
  });

  it("a wallet that predates the confirmation table (a phrase, no row) shows backup: missing and can still be acknowledged", async () => {
    // an older build: a password wallet with its phrase inside, nothing recorded in the database
    await writeLegacyPasswordWallet(t.tmpDir, "legacy-pass-1");
    expect((await walletInfo()).health.backup).toBe("missing");
    expect((await acknowledge()).statusCode).toBe(200);
    expect((await walletInfo()).health.backup).toBe("confirmed");
  });

  it("works while the wallet is locked (nothing is checked against the words)", async () => {
    await createAuto();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fs.rmSync(path.join(t.tmpDir, secretFiles()[0]));
    await restart();
    expect((await walletInfo()).unlocked).toBe(false);
    expect((await acknowledge()).statusCode).toBe(200);
  });
});

describe("replace wallet", () => {
  const replace = (payload: Record<string, unknown>) => post("/v1/admin/wallet/replace", payload);

  async function seedHistory() {
    const key = (
      await post("/v1/keys", { name: "analyst", total_budget: "5", daily_budget: "1", per_request_limit: "0.5", allowed_hosts: ["api.example.com:443"] })
    ).json();
    const now = new Date().toISOString();
    insertPayment({ id: "pay-settled", status: "settled" });
    t.ctx.sqlite
      .prepare(
        `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, decided_at, created_at)
         VALUES ('ap-1', ?, 'https://api.example.com/a', 'GET', 'sha', 'eip155:10143', '0xa', '0xb', 150000, 'approved', ?, ?, ?)`
      )
      .run(key.id, now, now, now);
    return key;
  }
  const snapshot = () =>
    JSON.stringify(
      ["money_keys", "payments", "approvals"].map((table) => t.ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
    );

  it("moves the old files into retired/ (never deletes), records the retirement, creates a new auto wallet with a new phrase, and leaves keys/budgets/approvals/payments alone", async () => {
    const old = await createAuto();
    const oldSolanaAddress = t.ctx.wallet.getSolanaAddress();
    const oldKeystore = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const oldSecret = secretOnDisk();
    await seedHistory();
    const before = snapshot();

    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["address", "backup_confirmed", "recovery_phrase", "retired"]);
    expect(body.address).not.toBe(old.address);
    expect(body.backup_confirmed).toBe(false);
    expect(body.recovery_phrase).not.toBe(old.recovery_phrase);
    expect(HDNodeWallet.fromPhrase(body.recovery_phrase).address).toBe(body.address);
    expect(body.retired).toMatchObject({ address: old.address, reason: "lost_password" });

    // the old key files are in retired/ under names with the old address, byte for byte
    const retiredDir = path.join(t.tmpDir, "retired");
    const names = fs.readdirSync(retiredDir).sort();
    expect(names).toHaveLength(2);
    expect(names.every((n) => n.includes(old.address.toLowerCase()))).toBe(true);
    expect(fs.readFileSync(path.join(retiredDir, body.retired.keystore_file), "utf-8")).toBe(oldKeystore);
    expect(fs.readFileSync(path.join(retiredDir, names.find((n) => n.endsWith(".secret"))!), "utf-8")).toBe(oldSecret);
    expect((await Wallet.fromEncryptedJson(oldKeystore, oldSecret)).address).toBe(old.address);

    // the database knows
    const row = t.ctx.sqlite.prepare("SELECT * FROM wallet_retirements").get() as Record<string, string>;
    expect(row).toMatchObject({ address: old.address, reason: "lost_password", keystore_file: body.retired.keystore_file, replaced_by: body.address });
    expect(row.secret_file).toBe(names.find((n) => n.endsWith(".secret")));
    expect(row.retired_at).toBe(body.retired.retired_at);
    const info = await walletInfo();
    expect(info.address).toBe(body.address);
    expect(info.retired_wallets).toEqual([
      {
        address: old.address,
        solana_address: oldSolanaAddress,
        retired_at: body.retired.retired_at,
        reason: "lost_password",
        keystore_file: body.retired.keystore_file,
        has_secret_file: true,
        replaced_by: body.address,
        balances: { [TESTNET.caip2]: null },
      },
    ]);
    expect(info.health.backup).toBe("missing"); // the new generated wallet has to be written down too

    // everything that is not the wallet is untouched
    expect(snapshot()).toBe(before);
    // the audit row names addresses and files, never a secret
    const audit = JSON.parse(auditRows().find((r) => r.action === "wallet.replace")!.detail);
    expect(audit).toMatchObject({ old_address: old.address, new_address: body.address, reason: "lost_password" });
    expect(auditDump()).not.toContain(body.recovery_phrase);
    expect(auditDump()).not.toContain(old.recovery_phrase);
    expect(auditDump()).not.toContain(oldSecret);

    // and it survives a restart on its own
    await restart();
    expect(await walletInfo()).toMatchObject({ address: body.address, unlocked: true });
  });

  it("works with the old wallet LOCKED and its password lost, and the old keystore still opens with the old password if it turns up", async () => {
    const old = await writeLegacyPasswordWallet(t.tmpDir, "the-lost-password");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await restart();
    expect((await walletInfo()).unlocked).toBe(false);
    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    expect(res.statusCode).toBe(200);
    expect(await walletInfo()).toMatchObject({ address: res.json().address, unlocked: true });
    const kept = fs.readFileSync(path.join(t.tmpDir, "retired", res.json().retired.keystore_file), "utf-8");
    expect((await Wallet.fromEncryptedJson(kept, "the-lost-password")).address).toBe(old.address);
  });

  it("must echo the current address exactly, and changes nothing otherwise", async () => {
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    for (const confirm of [undefined, "", old.address.toLowerCase(), HARDHAT_ADDRESS, old.address.slice(0, 20)]) {
      const res = await replace({ ...(confirm === undefined ? {} : { confirm_address: confirm }) });
      expect(res.statusCode, String(confirm)).toBe(400);
      expect(res.json().error).toBe("ADDRESS_MISMATCH");
    }
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(t.tmpDir, "retired"))).toBe(false);
    expect(auditRows().filter((r) => r.action === "wallet.replace.denied")).toHaveLength(5);
  });

  // (Refusing while a payment is in flight is covered by wallet-hardening.test.ts [lease] and
  // test/e2e/wallet-inflight.test.ts [a real paid fetch]; a payment row's status no longer decides it.)

  it("old unknown payments still reconcile after the swap: reconcile reads the address stored on each payment, not the current wallet", async () => {
    const old = await createAuto();
    insertPayment({ id: "pay-unknown", status: "unknown", authFrom: old.address, authNonce: "0x" + "11".repeat(32), authValidBefore: 1_000 });
    const res = await replace({ confirm_address: old.address });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).not.toBe(old.address);

    const asked: string[] = [];
    const reader: AuthorizationReader = {
      authorizationState: async (authorizer) => {
        asked.push(authorizer);
        return false; // never used on chain -> released
      },
      findAuthorizationUsedTx: async () => null,
    };
    // through the admin route, as the dashboard button does
    t.ctx.chainReader = reader;
    const reconcile = await post("/v1/admin/reconcile");
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json().reconciled_payment_ids).toEqual(["pay-unknown"]);
    expect(asked).toEqual([old.address]);
    expect(t.ctx.sqlite.prepare("SELECT status, error_code FROM payments WHERE id = 'pay-unknown'").get()).toEqual({
      status: "failed",
      error_code: "NOT_SETTLED_EXPIRED",
    });
    // and the library entry point, same thing
    insertPayment({ id: "pay-unknown-2", status: "unknown", authFrom: old.address, authNonce: "0x" + "22".repeat(32), authValidBefore: 1_000 });
    const out = await reconcileUnknownPayments({ db: t.ctx.db, reader });
    expect(out.reconciledPaymentIds).toEqual(["pay-unknown-2"]);
  });

  it("validates reason and refuses the removed options (password, mode, import) before touching anything", async () => {
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    for (const extra of [
      { reason: "free text with spaces" },
      { reason: "x".repeat(50) },
      { reason: 12 },
      { password: "long-enough-pw" },
      { mode: "manual" },
      { kind: "seed" },
      { kind: "private_key", private_key: "nope" },
      { kind: "mnemonic", mnemonic: "test test test test test test test test test test test test" },
    ]) {
      const res = await replace({ confirm_address: old.address, ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.body).not.toContain("nope");
      expect(res.body).not.toContain("test test");
      expect(res.body).not.toContain("long-enough-pw");
    }
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(t.tmpDir, "retired"))).toBe(false);
  });

  it("without a wallet there is nothing to replace", async () => {
    expect((await replace({ confirm_address: HARDHAT_ADDRESS })).statusCode).toBe(404);
  });

  it("if recording the retirement fails the swap is rolled back (nothing half-done)", async () => {
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    t.ctx.sqlite.exec("DROP TABLE wallet_retirements");
    const res = await replace({ confirm_address: old.address });
    expect(res.statusCode).toBe(500);
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual([secretName(old.address), "wallet.json"]);
    expect(t.ctx.wallet.getAddress()).toBe(old.address);
  });

  it("the status lists the retired wallets with their USDC balance per chain and where the files are", async () => {
    const old = await createAuto();
    const oldSolanaAddress = t.ctx.wallet.getSolanaAddress();
    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    const calls = stubRpc({ [TESTNET.rpcUrl]: 520_000n });
    const info = await walletInfo();
    expect(info.retired_wallets).toEqual([
      {
        address: old.address,
        solana_address: oldSolanaAddress,
        retired_at: res.json().retired.retired_at,
        reason: "lost_password",
        keystore_file: res.json().retired.keystore_file,
        has_secret_file: true,
        replaced_by: res.json().address,
        balances: { [TESTNET.caip2]: "0.52" },
      },
    ]);
    expect(calls).toHaveLength(2); // the live wallet and the retired one, one read each
    // an unreachable RPC is "unknown", not zero
    vi.setSystemTime(Date.now() + 60_000);
    stubRpc({ [TESTNET.rpcUrl]: "error" });
    expect((await walletInfo()).retired_wallets[0].balances).toEqual({ [TESTNET.caip2]: null });
  });
});

describe("secrets never reach the log, the audit trail or an unintended response", () => {
  it("through a full lifecycle, the phrase, private key and the unlock secret appear only in the responses meant to carry them", async () => {
    const { Writable } = await import("node:stream");
    const Fastify = (await import("fastify")).default;
    const { registerAdminRoutes } = await import("../../src/routes/admin.js");
    let logged = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      },
    });
    const consoleOutput: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleOutput.push(args.map(String).join(" ")));
    }
    const app = Fastify({ logger: { stream, level: "trace" } });
    registerAdminRoutes(app, t.ctx);
    await app.ready();
    const call = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

    const responses: Array<{ label: string; body: string }> = [];
    const keep = async (label: string, p: Promise<{ body: string }>) => {
      const r = await p;
      responses.push({ label, body: r.body });
      return JSON.parse(r.body || "{}");
    };

    // a wallet is created, restarted, acknowledged, looked at, replaced and looked at again
    const created = await keep("create", call("POST", "/v1/admin/wallet/create", {}));
    const unlockSecret = secretOnDisk();
    await restart();
    await keep("status", call("GET", "/v1/admin/wallet"));
    await keep("confirm", call("POST", "/v1/admin/wallet/backup/confirm", { address: created.address }));
    const replaced = await keep("replace", call("POST", "/v1/admin/wallet/replace", { confirm_address: created.address, reason: "lost_password" }));
    await keep("status-after", call("GET", "/v1/admin/wallet"));
    await app.close();

    const secrets = [
      created.recovery_phrase,
      replaced.recovery_phrase,
      unlockSecret,
      HDNodeWallet.fromPhrase(created.recovery_phrase).privateKey,
      HDNodeWallet.fromPhrase(replaced.recovery_phrase).privateKey,
      HDNodeWallet.fromPhrase(created.recovery_phrase).privateKey.slice(2),
    ];
    const audit = auditDump();
    for (const secret of secrets) {
      expect(logged, "request log").not.toContain(secret);
      expect(consoleOutput.join("\n"), "console").not.toContain(secret);
      expect(audit, "audit log").not.toContain(secret);
    }
    // each response that carries a secret is one of the intended ones
    const carriers = responses.filter((r) => secrets.some((s) => r.body.includes(s))).map((r) => r.label);
    expect(carriers.sort()).toEqual(["create", "replace"].sort());
  });
});

describe("startup credentials", () => {
  it("MONEYSWITCH_WALLET_PASSWORD(_FILE): empty value, empty file, whitespace-only file and unreadable file all mean 'not configured'", () => {
    const dir = fs.mkdtempSync(path.join(t.tmpDir, "pw-"));
    const file = (name: string, content: string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readWalletPassword({})).toBeNull();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "" })).toBeNull();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "   " })).toBeNull();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD_FILE: file("empty", "") })).toBeNull();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD_FILE: file("blank", " \n") })).toBeNull();
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD_FILE: path.join(dir, "missing") })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    // real values
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "from-env" })).toBe("from-env");
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD_FILE: file("pw", "from-file\n") })).toBe("from-file");
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "from-env", MONEYSWITCH_WALLET_PASSWORD_FILE: file("pw2", "from-file") })).toBe("from-env");
    // an empty variable does not hide a usable file
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD: "", MONEYSWITCH_WALLET_PASSWORD_FILE: file("pw3", "from-file") })).toBe("from-file");
  });

  it("a password that is only in a file is not trimmed of inner spaces, only of the surrounding newline", () => {
    const p = path.join(t.tmpDir, "pw");
    fs.writeFileSync(p, "two words here\r\n");
    expect(readWalletPassword({ MONEYSWITCH_WALLET_PASSWORD_FILE: p })).toBe("two words here");
  });

  it("startup log lines name the outcome and never a credential", async () => {
    await createAuto();
    const lines: string[] = [];
    for (const method of ["log", "error"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const secret = secretOnDisk();
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect(lines.join("\n")).toContain(`Wallet unlocked automatically (unlock secret ${secretFiles()[0]})`);
    expect(lines.join("\n")).not.toContain(secret);

    // a legacy password wallet with nothing configured says it is locked, and what to do (no Dashboard form any more)
    const legacyDir = fs.mkdtempSync(path.join(t.tmpDir, "legacy-"));
    await writeLegacyPasswordWallet(legacyDir, "manual-pass-1");
    lines.length = 0;
    await unlockWalletOnStartup(new LocalWalletDriver(legacyDir, FAST), null);
    expect(lines.join("\n")).toContain("Wallet is locked: no unlock credential configured");
    expect(lines.join("\n")).toContain("MONEYSWITCH_WALLET_PASSWORD");
    expect(lines.join("\n")).not.toContain("manual-pass-1");

    // an auto wallet whose secret went missing says THAT, not "no credential configured"
    lines.length = 0;
    fs.rmSync(path.join(t.tmpDir, secretFiles()[0]));
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect(lines.join("\n")).toContain("is missing");
    expect(lines.join("\n")).not.toContain("no unlock credential configured");
    expect(lines.join("\n")).not.toMatch(/import your recovery phrase/i);
  });
});
