import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Wallet, HDNodeWallet, encryptKeystoreJson } from "ethers";
import { LocalWalletDriver, unlockSecretPath, walletFilePath } from "@moneyswitch/wallet";
import { BASE_SEPOLIA, TESTNET } from "@moneyswitch/x402";
import { reconcileUnknownPayments, type AuthorizationReader } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";
import { readWalletPassword } from "../../src/config.js";
import { unlockWalletOnStartup } from "../../src/context.js";

// Test-only: a cheap scrypt keeps the suite fast (the production costs are covered in packages/wallet), and no OS-level
// ACL work (it is exercised for real in packages/wallet/test/protect.*.test.ts).
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false, drainTimeoutMs: 40 } as const; // (a replace that finds a request in flight waits this long, then answers WALLET_BUSY; production: 60 s)
const HARDHAT_PHRASE = "test test test test test test test test test test test junk";
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
  return res.json() as { address: string; recovery_phrase: string; unlock_mode: string; backup_confirmed: boolean };
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
    ["GET", "/v1/admin/wallet/retired"],
    ["POST", "/v1/admin/wallet/create", {}],
    ["POST", "/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE }],
    ["POST", "/v1/admin/wallet/backup", {}],
    ["POST", "/v1/admin/wallet/unlock", { password: "whatever-123" }],
    ["POST", "/v1/admin/wallet/backup/confirm", { positions: [1, 2], words: ["a", "b"] }],
    ["POST", "/v1/admin/wallet/reveal", { confirm_address: HARDHAT_ADDRESS }],
    ["POST", "/v1/admin/wallet/auto-unlock", { enabled: true }],
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
});

describe("create", () => {
  it("defaults to auto-unlock: no password, a 12-word phrase returned once with no-store, secret file written, address matches the phrase", async () => {
    const res = await post("/v1/admin/wallet/create");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["address", "backup_confirmed", "recovery_phrase", "unlock_mode"]);
    expect(body.unlock_mode).toBe("auto");
    expect(body.backup_confirmed).toBe(false);
    expect(body.recovery_phrase.split(" ")).toHaveLength(12);
    expect(HDNodeWallet.fromPhrase(body.recovery_phrase).address).toBe(body.address);
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual([secretName(body.address), "wallet.json"]);
    // the secret and the phrase are in no later response
    const later = [await walletInfo(), (await post("/v1/admin/wallet/backup", { password: "portable-pass-1" })).json()];
    for (const r of later) {
      expect(JSON.stringify(r)).not.toContain(secretOnDisk());
      expect(JSON.stringify(r)).not.toContain(body.recovery_phrase);
    }
    expect(auditDump()).not.toContain(body.recovery_phrase);
    expect(auditDump()).not.toContain(secretOnDisk());
  });

  it("with a password it is the old manual mode (no secret file) and still returns the phrase", async () => {
    const res = await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().unlock_mode).toBe("manual");
    expect(res.json().recovery_phrase.split(" ")).toHaveLength(12);
    expect(fs.readdirSync(t.tmpDir)).toEqual(["wallet.json"]);
    expect((await walletInfo()).health.unlock_mode).toBe("manual");
  });

  it.each([
    [{ password: "short" }, "at least 8"],
    [{ password: 12345678 }, "at least 8"],
    [{ mode: "sometimes" }, "mode must be"],
    [{ mode: "auto", password: "long-enough-pw" }, "does not take a password"],
    [{ mode: "manual" }, "at least 8"],
  ])("rejects %j", async (payload, message) => {
    const res = await post("/v1/admin/wallet/create", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(message);
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
  });

  it("refuses to overwrite an existing wallet", async () => {
    const first = await createAuto();
    const again = await post("/v1/admin/wallet/create", {});
    expect(again.statusCode).toBe(400);
    expect(again.body).not.toContain("recovery_phrase");
    expect((await walletInfo()).address).toBe(first.address);
  });
});

describe("health", () => {
  it("no wallet yet", async () => {
    const info = await walletInfo();
    expect(info).toMatchObject({ address: null, unlocked: false, has_keystore: false, auto_unlock_configured: false, usdc_balance: null });
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
      retired_wallets: [],
    });
  });

  it("keeps the fields older clients read", async () => {
    const created = await createAuto();
    stubRpc({ [TESTNET.rpcUrl]: 520_000n });
    const info = await walletInfo();
    expect(info).toMatchObject({
      address: created.address,
      unlocked: true,
      has_keystore: true,
      auto_unlock_configured: true,
      usdc_balance: "0.52",
      network: TESTNET.caip2,
    });
  });

  it("auto wallet: unlock_mode auto, last decrypt ok, backup missing until the words are confirmed", async () => {
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
    const { health, unlocked, auto_unlock_configured } = await walletInfo();
    expect(unlocked).toBe(false);
    expect(health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: false });
    expect(auto_unlock_configured).toBe(true);
    expect(errors.mock.calls.flat().join("\n")).toContain("does not open wallet.json");
    expect(errors.mock.calls.flat().join("\n")).not.toContain("abab");
  });

  it("manual wallet: unlock_mode manual, no auto_unlock_ok; an unlocked-by-password wallet is not 'auto'", async () => {
    await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    await restart();
    expect((await walletInfo()).health).toMatchObject({ unlock_mode: "manual", auto_unlock_ok: null });
    expect((await post("/v1/admin/wallet/unlock", { password: "manual-pass-1" })).json()).toMatchObject({ unlocked: true });
    expect((await walletInfo()).health).toMatchObject({ unlock_mode: "manual", auto_unlock_ok: null });
  });

  it("legacy startup password: env_or_file, and ok=true after it unlocked", async () => {
    await post("/v1/admin/wallet/create", { password: "legacy-pass-1" });
    t.ctx.config.walletPassword = "legacy-pass-1";
    await restart("legacy-pass-1");
    expect((await walletInfo()).health).toMatchObject({ unlock_mode: "env_or_file", auto_unlock_ok: true });
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
    await post("/v1/admin/wallet/create", { password: "legacy-pass-1" });
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

describe("backup confirmation", () => {
  const confirm = (positions: unknown, words: unknown) => post("/v1/admin/wallet/backup/confirm", { positions, words });

  it("two correct words (1-based positions) record backup_confirmed_at and flip health.backup to confirmed", async () => {
    const created = await createAuto();
    const w = created.recovery_phrase.split(" ");
    const res = await confirm([4, 11], [w[3], w[10].toUpperCase()]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().confirmed).toBe(true);
    const info = await walletInfo();
    expect(info.health.backup).toBe("confirmed");
    expect(info.backup_confirmed_at).toBe(res.json().backup_confirmed_at);
    expect(auditRows().map((r) => r.action)).toContain("wallet.backup.confirm");
    expect(auditDump()).not.toContain(w[3] + " " + w[10]);
    // idempotent: the first timestamp is kept
    const again = await confirm([4, 11], [w[3], w[10]]);
    expect(again.json().backup_confirmed_at).toBe(res.json().backup_confirmed_at);
  });

  it("a wrong word is refused and nothing is recorded", async () => {
    const created = await createAuto();
    const w = created.recovery_phrase.split(" ");
    const res = await confirm([2, 5], [w[1], w[2] === w[4] ? "zebra" : w[2]]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("WORDS_MISMATCH");
    expect((await walletInfo()).health.backup).toBe("missing");
    expect(auditRows().map((r) => r.action)).toContain("wallet.backup.confirm_failed");
  });

  it.each([
    ["one position", [3], ["a"]],
    ["three positions", [1, 2, 3], ["a", "b", "c"]],
    ["the same position twice", [3, 3], ["a", "a"]],
    ["position 0", [0, 2], ["a", "b"]],
    ["position 25", [1, 25], ["a", "b"]],
    ["a fractional position", [1.5, 2], ["a", "b"]],
    ["a numeric word", [1, 2], [1, 2]],
    ["an empty word", [1, 2], ["a", ""]],
    ["a missing words field", [1, 2], undefined],
  ])("rejects %s with 400", async (_label, positions, words) => {
    await createAuto();
    const res = await confirm(positions, words);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_REQUEST");
    expect((await walletInfo()).health.backup).toBe("missing");
  });

  it("needs a wallet, an unlocked wallet and a recovery phrase", async () => {
    expect((await confirm([1, 2], ["a", "b"])).statusCode).toBe(404);
    await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    await restart();
    expect((await confirm([1, 2], ["a", "b"])).statusCode).toBe(409);
    expect((await confirm([1, 2], ["a", "b"])).json().error).toBe("WALLET_LOCKED");
  });

  it("a wallet imported from a bare private key has no phrase to confirm (backup: not_applicable)", async () => {
    const key = Wallet.createRandom();
    expect((await post("/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey })).statusCode).toBe(200);
    expect((await walletInfo()).health.backup).toBe("not_applicable");
    const res = await confirm([1, 2], ["a", "b"]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NO_RECOVERY_PHRASE");
  });

  it("a wallet that predates the confirmation table (a phrase, no row) shows backup: missing and can still be confirmed", async () => {
    // an older build: password wallet created by the driver directly, nothing recorded in the database
    const legacy = await t.ctx.wallet.createWithPhrase({ password: "legacy-pass-1" });
    expect((await walletInfo()).health.backup).toBe("missing");
    const w = legacy.mnemonic.split(" ");
    expect((await confirm([1, 12], [w[0], w[11]])).statusCode).toBe(200);
    expect((await walletInfo()).health.backup).toBe("confirmed");
  });
});

describe("reveal", () => {
  it("returns the phrase only for the exact current address, with no-store, and audits it without the secret", async () => {
    const created = await createAuto();
    const lower = await post("/v1/admin/wallet/reveal", { confirm_address: created.address.toLowerCase() });
    expect(lower.statusCode).toBe(400);
    expect(lower.json().error).toBe("ADDRESS_MISMATCH");
    expect(lower.body).not.toContain(created.recovery_phrase);
    expect((await post("/v1/admin/wallet/reveal", {})).statusCode).toBe(400);
    expect((await post("/v1/admin/wallet/reveal", { confirm_address: HARDHAT_ADDRESS })).statusCode).toBe(400);

    const ok = await post("/v1/admin/wallet/reveal", { confirm_address: created.address });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.json()).toEqual({ address: created.address, kind: "mnemonic", recovery_phrase: created.recovery_phrase });

    const actions = auditRows().map((r) => r.action);
    expect(actions).toContain("wallet.reveal");
    expect(actions.filter((a) => a === "wallet.reveal.denied")).toHaveLength(3);
    expect(auditDump()).not.toContain(created.recovery_phrase);
    expect(auditDump()).not.toContain(created.recovery_phrase.split(" ")[0] + " " + created.recovery_phrase.split(" ")[1]);
    expect(JSON.parse(auditRows().find((r) => r.action === "wallet.reveal")!.detail)).toEqual({ address: created.address, kind: "mnemonic" });
  });

  it("still returns the same phrase after a restart (it lives inside the encrypted keystore)", async () => {
    const created = await createAuto();
    await restart();
    const res = await post("/v1/admin/wallet/reveal", { confirm_address: created.address });
    expect(res.json().recovery_phrase).toBe(created.recovery_phrase);
  });

  it("a wallet imported from a private key reveals that key", async () => {
    const key = Wallet.createRandom();
    await post("/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey });
    const res = await post("/v1/admin/wallet/reveal", { confirm_address: key.address });
    expect(res.json()).toEqual({ address: key.address, kind: "private_key", private_key: key.privateKey });
    expect(auditDump()).not.toContain(key.privateKey.slice(2));
  });

  it("needs a wallet, and an unlocked one", async () => {
    expect((await post("/v1/admin/wallet/reveal", { confirm_address: HARDHAT_ADDRESS })).statusCode).toBe(404);
    const created = await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    await restart();
    const res = await post("/v1/admin/wallet/reveal", { confirm_address: created.json().address });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain("recovery_phrase\":\"");
  });
});

describe("import", () => {
  it("a recovery phrase: same address a wallet app shows, auto-unlock by default, only the key is kept (nothing to back up), nothing echoed", async () => {
    const res = await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ address: HARDHAT_ADDRESS });
    expect(fs.readdirSync(t.tmpDir).sort()).toEqual([secretName(HARDHAT_ADDRESS), "wallet.json"]);
    const info = await walletInfo();
    // M2: the phrase is NOT kept (it may control other funds), so there is nothing for the operator to write down
    expect(info.health).toMatchObject({ unlock_mode: "auto", auto_unlock_ok: true, backup: "not_applicable" });
    expect(res.body + auditDump()).not.toContain("junk");
  });

  it("a recovery phrase with a password is manual mode", async () => {
    await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: HARDHAT_PHRASE, password: "manual-pass-1" });
    expect(fs.readdirSync(t.tmpDir)).toEqual(["wallet.json"]);
    await restart();
    expect((await post("/v1/admin/wallet/unlock", { password: "manual-pass-1" })).json().address).toBe(HARDHAT_ADDRESS);
  });

  it("a bad phrase is rejected without being echoed and creates nothing", async () => {
    const bad = "test test test test test test test test test test test test";
    const res = await post("/v1/admin/wallet/import", { kind: "mnemonic", mnemonic: bad });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("test test");
    expect(t.ctx.wallet.hasKeystore()).toBe(false);
    expect((await post("/v1/admin/wallet/import", { kind: "mnemonic" })).statusCode).toBe(400);
    expect((await post("/v1/admin/wallet/import", { kind: "seed", mnemonic: bad })).statusCode).toBe(400);
  });

  it("a keystore import without a new password is auto mode: the source password is only used once", async () => {
    const original = Wallet.createRandom();
    const source = await encryptKeystoreJson({ address: original.address, privateKey: original.privateKey }, "source-pass-1", FAST);
    const res = await post("/v1/admin/wallet/import", { kind: "keystore", keystore: source, source_password: "source-pass-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe(original.address);
    expect((await walletInfo()).health.unlock_mode).toBe("auto");
    expect(auditDump()).not.toContain("source-pass-1");
  });
});

describe("backup download", () => {
  it("auto wallet: the raw wallet.json is useless to the operator, so a plain request explains and a password gives a portable keystore", async () => {
    const created = await createAuto();
    const plain = await post("/v1/admin/wallet/backup");
    expect(plain.statusCode).toBe(409);
    expect(plain.json().error).toBe("BACKUP_NEEDS_PASSWORD");
    expect(plain.body).not.toContain("Crypto");

    const res = await post("/v1/admin/wallet/backup", { password: "portable-pass-1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const opened = await Wallet.fromEncryptedJson(res.json().keystore, "portable-pass-1");
    expect(opened.address).toBe(created.address);
    expect((opened as HDNodeWallet).mnemonic?.phrase).toBe(created.recovery_phrase);
    expect(res.body).not.toContain(secretOnDisk());
    expect(auditDump()).not.toContain("portable-pass-1");
    expect((await post("/v1/admin/wallet/backup", { password: "short" })).statusCode).toBe(400);
  });

  it("needs the wallet unlocked to export with a password; manual wallets still download wallet.json as before", async () => {
    await post("/v1/admin/wallet/create", { password: "manual-pass-1" });
    await restart();
    expect((await post("/v1/admin/wallet/backup", { password: "portable-pass-1" })).statusCode).toBe(409);
    const plain = await post("/v1/admin/wallet/backup");
    expect(plain.statusCode).toBe(200);
    expect((await Wallet.fromEncryptedJson(plain.json().keystore, "manual-pass-1")).address).toBeTruthy();
  });
});

describe("turning auto-unlock on and off", () => {
  const toggle = (payload: unknown) => post("/v1/admin/wallet/auto-unlock", payload);

  it("manual -> auto -> manual, with restarts in between, never changing the address", async () => {
    const created = (await post("/v1/admin/wallet/create", { password: "manual-pass-1" })).json();
    await restart();
    expect((await toggle({ enabled: true })).statusCode).toBe(409); // locked
    await post("/v1/admin/wallet/unlock", { password: "manual-pass-1" });

    const on = await toggle({ enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.headers["cache-control"]).toBe("no-store");
    expect(on.json()).toEqual({ address: created.address, unlock_mode: "auto", auto_unlock_ok: true });
    expect(fs.existsSync(unlockSecretPath(t.tmpDir, created.address))).toBe(true);
    expect((await toggle({ enabled: true })).statusCode).toBe(409);
    await restart();
    expect(await walletInfo()).toMatchObject({ address: created.address, unlocked: true, health: { unlock_mode: "auto", auto_unlock_ok: true } });

    expect((await toggle({ enabled: false })).statusCode).toBe(400);
    expect((await toggle({ enabled: false, password: "short" })).statusCode).toBe(400);
    const off = await toggle({ enabled: false, password: "second-pass-2" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ address: created.address, unlock_mode: "manual", auto_unlock_ok: null });
    expect(fs.existsSync(unlockSecretPath(t.tmpDir, created.address))).toBe(false);
    expect(fs.readdirSync(t.tmpDir)).toEqual(["wallet.json"]); // no secret, no .bak, nothing that opens the key without the password
    expect((await toggle({ enabled: false, password: "third-pass-3" })).statusCode).toBe(409); // already off
    await restart();
    expect((await walletInfo()).unlocked).toBe(false);
    expect((await post("/v1/admin/wallet/unlock", { password: "second-pass-2" })).json().address).toBe(created.address);
    // the recovery phrase survived both re-encryptions
    const reveal = await post("/v1/admin/wallet/reveal", { confirm_address: created.address });
    expect(reveal.json().recovery_phrase).toBe(created.recovery_phrase);
    expect(auditRows().map((r) => r.action)).toEqual(expect.arrayContaining(["wallet.auto_unlock.enable", "wallet.auto_unlock.disable"]));
    expect(auditDump()).not.toMatch(/second-pass-2|manual-pass-1/);
  });

  it("validates its body", async () => {
    await createAuto();
    expect((await toggle({})).statusCode).toBe(400);
    expect((await toggle({ enabled: "yes" })).statusCode).toBe(400);
    expect((await toggle({ enabled: true, password: "long-enough-pw" })).statusCode).toBe(400);
    expect((await toggle(undefined)).statusCode).toBe(400);
  });

  it("a failure half-way answers 500 and leaves the wallet exactly as it was", async () => {
    const created = (await post("/v1/admin/wallet/create", { password: "manual-pass-1" })).json();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const real = fs.renameSync;
    let renames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof real>) => {
      if (++renames === 2) throw Object.assign(new Error("simulated"), { code: "EIO" });
      return real(...args);
    }) as never);
    const res = await toggle({ enabled: true });
    vi.restoreAllMocks();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("STORAGE_FAILED");
    expect(fs.readFileSync(walletFilePath(t.tmpDir), "utf-8")).toBe(before);
    expect(secretFiles()).toEqual([]);
    await restart();
    expect((await post("/v1/admin/wallet/unlock", { password: "manual-pass-1" })).json().address).toBe(created.address);
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
    t.ctx.sqlite.prepare(`INSERT INTO notify_settings (key, value, updated_at) VALUES ('webhook.url', 'https://hook.test/x', ?)`).run(now);
    return key;
  }
  const snapshot = () =>
    JSON.stringify(
      ["money_keys", "payments", "approvals", "notify_settings"].map((table) => t.ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
    );

  it("moves the old files into retired/ (never deletes), records the retirement, creates a new auto wallet with a new phrase, and leaves keys/budgets/approvals/payments/notifications alone", async () => {
    const old = await createAuto();
    const oldKeystore = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    const oldSecret = secretOnDisk();
    await seedHistory();
    const before = snapshot();

    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.address).not.toBe(old.address);
    expect(body.unlock_mode).toBe("auto");
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
    expect(info.health.retired_wallets).toEqual([{ address: old.address, retired_at: body.retired.retired_at, reason: "lost_password" }]);
    expect(info.health.backup).toBe("missing"); // the new generated wallet has to be confirmed too

    // everything that is not the wallet is untouched
    expect(snapshot()).toBe(before);
    // the audit row names addresses and files, never a secret
    const audit = JSON.parse(auditRows().find((r) => r.action === "wallet.replace")!.detail);
    expect(audit).toMatchObject({ old_address: old.address, new_address: body.address, reason: "lost_password", source: "create" });
    expect(auditDump()).not.toContain(body.recovery_phrase);
    expect(auditDump()).not.toContain(old.recovery_phrase);
    expect(auditDump()).not.toContain(oldSecret);

    // and it survives a restart on its own
    await restart();
    expect(await walletInfo()).toMatchObject({ address: body.address, unlocked: true });
  });

  it("works with the old wallet LOCKED and its password lost, and the old keystore still opens with the old password if it turns up", async () => {
    const old = (await post("/v1/admin/wallet/create", { password: "the-lost-password" })).json();
    await restart();
    expect((await walletInfo()).unlocked).toBe(false);
    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    expect(res.statusCode).toBe(200);
    expect((await walletInfo())).toMatchObject({ address: res.json().address, unlocked: true });
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

  it("can replace with a recovery phrase or a private key; either way only the key is kept, so there is no new phrase to back up", async () => {
    const old = await createAuto();
    const viaPhrase = await replace({ confirm_address: old.address, kind: "mnemonic", mnemonic: HARDHAT_PHRASE });
    expect(viaPhrase.statusCode).toBe(200);
    expect(viaPhrase.json().address).toBe(HARDHAT_ADDRESS);
    expect(viaPhrase.body).not.toContain("recovery_phrase");
    expect((await walletInfo()).health.backup).toBe("not_applicable");

    const key = Wallet.createRandom();
    const viaKey = await replace({ confirm_address: HARDHAT_ADDRESS, kind: "private_key", private_key: key.privateKey, reason: "suspected_leak" });
    expect(viaKey.statusCode).toBe(200);
    expect((await walletInfo()).address).toBe(key.address);
    expect((await walletInfo()).health.backup).toBe("not_applicable");
    expect((await walletInfo()).health.retired_wallets.map((r: { address: string }) => r.address)).toEqual([HARDHAT_ADDRESS, old.address]);
    expect(auditDump()).not.toContain(key.privateKey.slice(2));
  });

  it("a manual replacement needs its password and writes no secret", async () => {
    const old = await createAuto();
    const res = await replace({ confirm_address: old.address, password: "new-manual-pass" });
    expect(res.statusCode).toBe(200);
    expect(res.json().unlock_mode).toBe("manual");
    expect(secretFiles()).toEqual([]); // the old secret moved to retired/ with the old keystore; the new wallet has none
    expect((await walletInfo()).health).toMatchObject({ unlock_mode: "manual", auto_unlock_ok: null });
  });

  it("validates reason, password and import fields before touching anything", async () => {
    const old = await createAuto();
    const before = fs.readFileSync(walletFilePath(t.tmpDir), "utf-8");
    for (const extra of [
      { reason: "free text with spaces" },
      { reason: "x".repeat(50) },
      { reason: 12 },
      { password: "short" },
      { mode: "auto", password: "long-enough-pw" },
      { kind: "seed" },
      { kind: "private_key", private_key: "nope" },
      { kind: "mnemonic", mnemonic: "test test test test test test test test test test test test" },
    ]) {
      const res = await replace({ confirm_address: old.address, ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.body).not.toContain("nope");
      expect(res.body).not.toContain("test test");
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

  it("retired wallets are listed with their live USDC balance and where the files are", async () => {
    const old = await createAuto();
    const res = await replace({ confirm_address: old.address, reason: "lost_password" });
    const calls = stubRpc({ [TESTNET.rpcUrl]: 520_000n });
    const list = await get("/v1/admin/wallet/retired");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      network: TESTNET.caip2,
      folder: "retired",
      retired_wallets: [
        {
          address: old.address,
          retired_at: res.json().retired.retired_at,
          reason: "lost_password",
          keystore_file: res.json().retired.keystore_file,
          has_secret_file: true,
          replaced_by: res.json().address,
          usdc_balance: "0.52",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    // an unreachable RPC is "unknown", not zero
    vi.setSystemTime(Date.now() + 60_000);
    stubRpc({ [TESTNET.rpcUrl]: "error" });
    expect((await get("/v1/admin/wallet/retired")).json().retired_wallets[0].usdc_balance).toBeNull();
    expect((await get("/v1/admin/wallet/retired?network=eip155:1")).statusCode).toBe(400);
  });
});

describe("secrets never reach the log, the audit trail or an unintended response", () => {
  it("through a full lifecycle, the phrase, private key, passwords and the unlock secret appear only in the responses meant to carry them", async () => {
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

    const passwords = ["life-pass-aaaa1", "life-pass-bbbb2", "portable-cccc3", "replace-pass-dddd4"];
    const responses: Array<{ label: string; body: string }> = [];
    const keep = async (label: string, p: Promise<{ body: string }>) => {
      const r = await p;
      responses.push({ label, body: r.body });
      return JSON.parse(r.body || "{}");
    };

    // 1. a manual wallet, restarted, unlocked, turned auto, backed up, revealed, turned manual, replaced
    const created = await keep("create", call("POST", "/v1/admin/wallet/create", { password: passwords[0] }));
    await restart();
    await keep("unlock", call("POST", "/v1/admin/wallet/unlock", { password: passwords[0] }));
    const w = created.recovery_phrase.split(" ");
    await keep("confirm", call("POST", "/v1/admin/wallet/backup/confirm", { positions: [2, 7], words: [w[1], w[6]] }));
    await keep("enable", call("POST", "/v1/admin/wallet/auto-unlock", { enabled: true }));
    const unlockSecret = secretOnDisk();
    const portable = await keep("backup", call("POST", "/v1/admin/wallet/backup", { password: passwords[2] }));
    const revealed = await keep("reveal", call("POST", "/v1/admin/wallet/reveal", { confirm_address: created.address }));
    await keep("disable", call("POST", "/v1/admin/wallet/auto-unlock", { enabled: false, password: passwords[1] }));
    await keep("info", call("GET", "/v1/admin/wallet"));
    const replaced = await keep("replace", call("POST", "/v1/admin/wallet/replace", { confirm_address: created.address, password: passwords[3], reason: "lost_password" }));
    await keep("retired", call("GET", "/v1/admin/wallet/retired"));
    const key = Wallet.createRandom();
    await keep("import-denied", call("POST", "/v1/admin/wallet/import", { kind: "private_key", private_key: key.privateKey }));
    await app.close();

    const secrets = [
      created.recovery_phrase,
      replaced.recovery_phrase,
      ...passwords,
      unlockSecret,
      HDNodeWallet.fromPhrase(created.recovery_phrase).privateKey,
      HDNodeWallet.fromPhrase(replaced.recovery_phrase).privateKey,
      key.privateKey,
      key.privateKey.slice(2),
    ];
    const audit = auditDump();
    for (const secret of secrets) {
      expect(logged, "request log").not.toContain(secret);
      expect(consoleOutput.join("\n"), "console").not.toContain(secret);
      expect(audit, "audit log").not.toContain(secret);
    }
    // each response that carries a secret is one of the intended ones
    const carriers = responses.filter((r) => secrets.some((s) => r.body.includes(s))).map((r) => r.label);
    expect(carriers.sort()).toEqual(["create", "replace", "reveal"].sort());
    expect(revealed.recovery_phrase).toBe(created.recovery_phrase);
    // the portable keystore is encrypted, not plaintext
    expect(JSON.stringify(portable)).not.toContain(created.recovery_phrase);
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

    // a password wallet with nothing configured just says it is locked
    const manualDir = fs.mkdtempSync(path.join(t.tmpDir, "manual-"));
    await new LocalWalletDriver(manualDir, FAST).createWithPhrase({ password: "manual-pass-1" });
    lines.length = 0;
    await unlockWalletOnStartup(new LocalWalletDriver(manualDir, FAST), null);
    expect(lines.join("\n")).toContain("Wallet is locked: no unlock credential configured");

    // an auto wallet whose secret went missing says THAT, not "no credential configured"
    lines.length = 0;
    fs.rmSync(path.join(t.tmpDir, secretFiles()[0]));
    t.ctx.wallet = new LocalWalletDriver(t.tmpDir, FAST);
    await unlockWalletOnStartup(t.ctx.wallet, null);
    expect(lines.join("\n")).toContain("is missing");
    expect(lines.join("\n")).not.toContain("no unlock credential configured");
  });
});
