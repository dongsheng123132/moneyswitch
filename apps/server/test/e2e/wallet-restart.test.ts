import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
      MONEYSWITCH_NOTIFY_INTERVAL_MS: "0",
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
