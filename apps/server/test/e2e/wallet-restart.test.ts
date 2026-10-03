import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Wallet as EthersWallet } from "ethers";

/**
 * The reason this feature exists: a restart must not lock the wallet. These tests run the REAL server
 * entry point (apps/server/dist/index.js, needs `pnpm build`) as a child process against a throwaway data
 * directory, kill it, start it again on the same directory and look at what a person at the Dashboard
 * would see. No password is given to the second process; no real network is reachable (RPC points at a
 * closed local port, the proxy is off).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "..", "dist", "index.js");

interface Running {
  proc: ChildProcess;
  base: string;
  output: () => string;
  adminToken: string | null;
  stop: () => Promise<void>;
}

const running: Running[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
  for (const dir of dataDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200)); // Windows can hold the sqlite -wal/-shm briefly
      }
    }
  }
});

/** A process that was killed by a signal has exitCode null but signalCode set: it is gone either way. */
function exited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function boot(dataDir: string, extraEnv: Record<string, string> = {}): Promise<Running> {
  expect(fs.existsSync(entry), "run `pnpm build` first").toBe(true);
  const port = await freePort();
  let out = "";
  const proc = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      MONEYSWITCH_DATA_DIR: dataDir,
      MONEYSWITCH_PORT: String(port),
      MONEYSWITCH_HOST: "127.0.0.1",
      MONEYSWITCH_RECONCILE_INTERVAL_MS: "0",
      MONEYSWITCH_PROXY: "off",
      MONEYSWITCH_TESTNET_RPC_URL: "http://127.0.0.1:1", // closed port: balance reads fail fast, nothing leaves the machine
      LOG_LEVEL: "warn",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (c) => (out += c.toString()));
  proc.stderr!.on("data", (c) => (out += c.toString()));
  const start = Date.now();
  while (!/server listening on/.test(out)) {
    if (exited(proc)) throw new Error(`server exited early:\n${out}`);
    if (Date.now() - start > 25_000) {
      proc.kill();
      throw new Error(`server did not start within 25s:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const r: Running = {
    proc,
    base: `http://127.0.0.1:${port}`,
    output: () => out,
    adminToken: /(ms_admin_[A-Za-z0-9]+)/.exec(out)?.[1] ?? null,
    stop: async () => {
      if (exited(proc)) return;
      const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.kill();
      await gone;
    },
  };
  running.push(r);
  return r;
}

async function api(server: Running, token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${server.base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
}

function newDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-wallet-restart-"));
  dataDirs.push(dir);
  return dir;
}

describe("a restart does not lock the wallet", () => {
  it("create (no password) -> kill -> start again with NO password, an EMPTY password file and an empty variable -> unlocked, same address, same phrase", async () => {
    const dataDir = newDataDir();

    // --- first run: fresh data dir, the operator creates a wallet without choosing a password
    const first = await boot(dataDir);
    const token = first.adminToken!;
    expect(token).toMatch(/^ms_admin_/);
    const created = await api(first, token, "POST", "/v1/admin/wallet/create", {});
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { address, recovery_phrase: phrase } = created.json as { address: string; recovery_phrase: string };
    expect(phrase.split(" ")).toHaveLength(12);
    const words = phrase.split(" ");
    const confirmed = await api(first, token, "POST", "/v1/admin/wallet/backup/confirm", { positions: [3, 10], words: [words[2], words[9]] });
    expect(confirmed.status).toBe(200);
    const before = (await api(first, token, "GET", "/v1/admin/wallet")).json;
    expect(before).toMatchObject({ address, unlocked: true, has_keystore: true });
    expect(before.health).toMatchObject({ protection: "auto", unlock_mode: "auto", auto_unlock_ok: true, backup: "confirmed" });
    const secretFile = `wallet-unlock-${address.toLowerCase()}.secret`;
    expect(fs.readdirSync(dataDir).sort()).toEqual(expect.arrayContaining(["wallet.json", secretFile]));
    // M3, for real: the OS-level protection of the data directory and the secret was applied AND verified (icacls /
    // PowerShell on Windows, chmod 0700/0600 elsewhere) by the real server process, not by a stub.
    expect(before.health).toMatchObject({ secret_protected: true, secret_protection_detail: null });
    await first.stop();

    // --- second run: the same data dir. The deployment mounts an EMPTY password file and an empty variable.
    const emptyFile = path.join(dataDir, "..", `ms-empty-password-${path.basename(dataDir)}`);
    fs.writeFileSync(emptyFile, "");
    try {
      const second = await boot(dataDir, { MONEYSWITCH_WALLET_PASSWORD: "", MONEYSWITCH_WALLET_PASSWORD_FILE: emptyFile });
      expect(second.adminToken, "the admin token is only ever printed on the first boot").toBeNull();
      const after = (await api(second, token, "GET", "/v1/admin/wallet")).json;
      expect(after).toMatchObject({ address, unlocked: true, has_keystore: true, auto_unlock_configured: true });
      expect(after.health).toMatchObject({ protection: "auto", unlock_mode: "auto", auto_unlock_ok: true, backup: "confirmed", secret_protected: true });
      // really unlocked: the encrypted keystore opened, and the phrase inside it is intact
      const reveal = await api(second, token, "POST", "/v1/admin/wallet/reveal", { confirm_address: address });
      expect(reveal.status).toBe(200);
      expect(reveal.json.recovery_phrase).toBe(phrase);
      // what the operator can read in the process output says what happened, and nothing secret
      const log = second.output();
      expect(log).toContain(`Wallet unlocked automatically (unlock secret ${secretFile})`);
      expect(log).toContain("MONEYSWITCH_WALLET_PASSWORD_FILE is empty; ignoring it");
      const secret = fs.readFileSync(path.join(dataDir, secretFile), "utf-8");
      for (const hidden of [phrase, secret, token]) expect(log).not.toContain(hidden);
      await second.stop();

      // --- third run: crash-style kill again (proc.kill) and one more start, still no password
      const third = await boot(dataDir);
      expect((await api(third, token, "GET", "/v1/admin/wallet")).json).toMatchObject({ address, unlocked: true });
    } finally {
      fs.rmSync(emptyFile, { force: true });
    }
  });

  it("a broken secret is visible: the wallet stays locked, health says auto-unlock is broken, the log says why, and the password route still works for a manual wallet", async () => {
    const dataDir = newDataDir();
    const first = await boot(dataDir);
    const token = first.adminToken!;
    const created = (await api(first, token, "POST", "/v1/admin/wallet/create", {})).json as { address: string };
    await first.stop();

    fs.writeFileSync(path.join(dataDir, `wallet-unlock-${created.address.toLowerCase()}.secret`), "ab".repeat(32));
    const second = await boot(dataDir);
    const info = (await api(second, token, "GET", "/v1/admin/wallet")).json;
    expect(info).toMatchObject({ address: created.address, unlocked: false });
    expect(info.health).toMatchObject({
      protection: "auto",
      unlock_mode: "auto",
      auto_unlock_ok: false,
      unlock_sources: [{ source: "auto", ok: false, reason: "secret_wrong" }],
    });
    expect(second.output()).toContain("does not open wallet.json");
    expect(second.output()).not.toContain("abab");
  });

  it("turn auto-unlock off with a password -> restart -> locked until the password is given; turn it on again -> restart -> unlocked", async () => {
    const dataDir = newDataDir();
    const first = await boot(dataDir);
    const token = first.adminToken!;
    const created = (await api(first, token, "POST", "/v1/admin/wallet/create", {})).json as { address: string };
    expect((await api(first, token, "POST", "/v1/admin/wallet/auto-unlock", { enabled: false, password: "a long manual password" })).status).toBe(200);
    expect(fs.readdirSync(dataDir).filter((f) => f.startsWith("wallet-unlock"))).toEqual([]);
    await first.stop();

    const second = await boot(dataDir);
    expect((await api(second, token, "GET", "/v1/admin/wallet")).json).toMatchObject({ address: created.address, unlocked: false, health: { unlock_mode: "manual", auto_unlock_ok: null } });
    expect((await api(second, token, "POST", "/v1/admin/wallet/unlock", { password: "wrong password!" })).status).toBe(400);
    expect((await api(second, token, "POST", "/v1/admin/wallet/unlock", { password: "a long manual password" })).status).toBe(200);
    expect((await api(second, token, "POST", "/v1/admin/wallet/auto-unlock", { enabled: true })).status).toBe(200);
    await second.stop();

    const third = await boot(dataDir);
    expect((await api(third, token, "GET", "/v1/admin/wallet")).json).toMatchObject({ address: created.address, unlocked: true, health: { unlock_mode: "auto", auto_unlock_ok: true } });
  });

  it(
    "a legacy password wallet whose password is LOST (locked, backup never confirmed) can be replaced: nothing is decrypted, the old file is kept, the new wallet opens by itself, keys and history stay",
    { timeout: 180_000 },
    async () => {
      const dataDir = newDataDir();

      // --- the instance as it was: a fresh data dir with an agent key (this boot only creates the database)
      const first = await boot(dataDir);
      const token = first.adminToken!;
      const key = (
        await api(first, token, "POST", "/v1/keys", { name: "agent", total_budget: "5", daily_budget: "1", per_request_limit: "0.5", allowed_hosts: ["api.example.com:443"] })
      ).json as { id: string };
      await first.stop();

      // --- what the PREVIOUS release left behind: ethers' own password keystore (HDNodeWallet.encrypt: recovery phrase inside, no
      // MoneySwitch marker, no unlock secret), a password that nobody will ever pass again, and payment history
      const lostPassword = "the password nobody remembers any more";
      const legacy = EthersWallet.createRandom();
      const legacyKeystore = await legacy.encrypt(lostPassword);
      fs.writeFileSync(path.join(dataDir, "wallet.json"), legacyKeystore);
      const sqlite = new Database(path.join(dataDir, "moneyswitch.sqlite"));
      const insert = sqlite.prepare(
        "INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind, auth_from, auth_nonce, auth_valid_before) " +
          "VALUES (?, ?, 'https://api.example.com/x', 'api.example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, ?, ?, ?, 'fetch', ?, ?, ?)"
      );
      const stamp = "2026-09-01T00:00:00.000Z";
      insert.run("hist-settled", key.id, "settled", stamp, stamp, null, null, null);
      insert.run("hist-unknown", key.id, "unknown", stamp, stamp, legacy.address, "0x" + "11".repeat(32), 1_000);
      sqlite.close();

      // --- the restart, exactly like the US testnet instance: an EMPTY password file, no unlock secret, no credential at all
      const emptyFile = path.join(dataDir, "..", "ms-empty-password-" + path.basename(dataDir));
      fs.writeFileSync(emptyFile, "");
      try {
        const second = await boot(dataDir, { MONEYSWITCH_WALLET_PASSWORD: "", MONEYSWITCH_WALLET_PASSWORD_FILE: emptyFile });
        const locked = (await api(second, token, "GET", "/v1/admin/wallet")).json;
        expect(locked).toMatchObject({ address: legacy.address, unlocked: false, has_keystore: true, has_recovery_phrase: true });
        expect(locked.health).toMatchObject({ protection: "password", unlock_mode: "manual", auto_unlock_ok: null, unlock_sources: [], backup: "missing" });

        // the dead end the operator was in: no password to unlock with, a phrase that cannot be shown while locked, so a backup that
        // can never be confirmed (and a dashboard that therefore shows no address)
        expect((await api(second, token, "POST", "/v1/admin/wallet/reveal", { confirm_address: legacy.address })).status).toBe(409);
        expect((await api(second, token, "POST", "/v1/admin/wallet/backup/confirm", { positions: [1, 2], words: ["a", "b"] })).status).toBe(409);
        expect((await api(second, token, "POST", "/v1/admin/wallet/unlock", { password: "a wrong guess" })).status).toBe(400);

        // --- replace it: the address is all that is asked for; the old file is only MOVED, nothing is decrypted
        const replaced = await api(second, token, "POST", "/v1/admin/wallet/replace", { confirm_address: legacy.address, reason: "lost_password" });
        expect(replaced.status).toBe(200);
        const next = replaced.json as { address: string; unlock_mode: string; recovery_phrase: string; retired: { address: string; reason: string; keystore_file: string } };
        expect(next.address).not.toBe(legacy.address);
        expect(next.unlock_mode).toBe("auto");
        expect(next.recovery_phrase.split(" ")).toHaveLength(12);
        expect(next.retired).toMatchObject({ address: legacy.address, reason: "lost_password" });

        // the new wallet is open right away, protected, and waiting for its own backup check
        const now = (await api(second, token, "GET", "/v1/admin/wallet")).json;
        expect(now).toMatchObject({ address: next.address, unlocked: true });
        expect(now.health).toMatchObject({ protection: "auto", unlock_mode: "auto", auto_unlock_ok: true, backup: "missing", secret_protected: true });
        expect(JSON.stringify(now.health.retired_wallets)).toContain(legacy.address);

        // the old file is in retired/ byte for byte, and it is still the genuine article: the lost password would open it
        const kept = fs.readFileSync(path.join(dataDir, "retired", next.retired.keystore_file), "utf-8");
        expect(kept).toBe(legacyKeystore);
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, "wallet.json"), "utf-8")).address.toLowerCase().replace("0x", "")).toBe(next.address.toLowerCase().replace("0x", ""));
        expect((await EthersWallet.fromEncryptedJson(kept, lostPassword)).address).toBe(legacy.address);
        expect(fs.readdirSync(dataDir).filter((f) => f.startsWith("wallet-unlock-"))).toEqual(["wallet-unlock-" + next.address.toLowerCase() + ".secret"]);

        // keys, budgets and history are exactly as they were; old unknown payments still point at the old sender for reconcile
        const keys = (await api(second, token, "GET", "/v1/keys")).json as { keys: Array<{ id: string }> };
        expect(keys.keys.map((k) => k.id)).toEqual([key.id]);
        const usage = (await api(second, token, "GET", "/v1/admin/usage")).json as { payments: Array<{ id: string; status: string }> };
        expect(Object.fromEntries(usage.payments.map((p) => [p.id, p.status]))).toEqual({ "hist-settled": "settled", "hist-unknown": "unknown" });
        const retired = (await api(second, token, "GET", "/v1/admin/wallet/retired")).json;
        expect(retired.retired_wallets[0]).toMatchObject({ address: legacy.address, has_secret_file: false, replaced_by: next.address });

        // nothing secret in the process output: not the lost password, the new phrase, or the token
        for (const hidden of [lostPassword, next.recovery_phrase, token]) expect(second.output()).not.toContain(hidden);
        await second.stop();

        // --- and after another restart the new wallet is open again without any credential
        const third = await boot(dataDir);
        expect((await api(third, token, "GET", "/v1/admin/wallet")).json).toMatchObject({ address: next.address, unlocked: true, health: { protection: "auto", unlock_mode: "auto" } });
      } finally {
        fs.rmSync(emptyFile, { force: true });
      }
    }
  );

  it("replace -> restart: the new wallet comes back unlocked on its own, the old files stay in retired/, keys and history are still there", async () => {
    const dataDir = newDataDir();
    const first = await boot(dataDir);
    const token = first.adminToken!;
    const old = (await api(first, token, "POST", "/v1/admin/wallet/create", {})).json as { address: string };
    const key = (
      await api(first, token, "POST", "/v1/keys", { name: "agent", total_budget: "5", daily_budget: "1", per_request_limit: "0.5", allowed_hosts: ["api.example.com:443"] })
    ).json as { id: string };
    const replaced = await api(first, token, "POST", "/v1/admin/wallet/replace", { confirm_address: old.address, reason: "lost_password" });
    expect(replaced.status).toBe(200);
    const next = replaced.json as { address: string; retired: { keystore_file: string } };
    expect(next.address).not.toBe(old.address);
    await first.stop();

    const second = await boot(dataDir);
    const info = (await api(second, token, "GET", "/v1/admin/wallet")).json;
    expect(info).toMatchObject({ address: next.address, unlocked: true });
    expect(info.health.retired_wallets).toEqual([expect.objectContaining({ address: old.address, reason: "lost_password" })]);
    expect(fs.existsSync(path.join(dataDir, "retired", next.retired.keystore_file))).toBe(true);
    const keys = (await api(second, token, "GET", "/v1/keys")).json as { keys: Array<{ id: string }> };
    expect(keys.keys.map((k) => k.id)).toEqual([key.id]);
    const retired = (await api(second, token, "GET", "/v1/admin/wallet/retired")).json;
    expect(retired.retired_wallets[0]).toMatchObject({ address: old.address, usdc_balance: null, has_secret_file: true });
  });
});
