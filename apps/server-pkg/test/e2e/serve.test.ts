import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the BUILT bundle (dist/cli.js, as published) against a throw-away data directory and checks what a person
 * gets from a first start through the real HTTP API, using only what the server prints (the one-time setup link).
 * Needs `pnpm build` first. There is no offline demo any more: the `demo` command must be refused.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "..", "dist", "cli.js");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let proc: ChildProcess;
let out = "";
let base = "";
let dataDir = "";
let adminToken = "";
let setupToken = "";

beforeAll(async () => {
  expect(fs.existsSync(cli), "run `pnpm build` first").toBe(true);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-serve-e2e-"));
  const port = await freePort();
  proc = spawn(process.execPath, [cli, "--data-dir", dataDir, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (c) => (out += c.toString()));
  proc.stderr!.on("data", (c) => (out += c.toString()));
  const start = Date.now();
  while (!/listening on/.test(out)) {
    if (Date.now() - start > 45_000 || proc.exitCode !== null) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const link = /(http:\/\/127\.0\.0\.1:\d+)\/login#(ms_setup_[A-Za-z0-9]+)/.exec(out);
  expect(link, out).toBeTruthy();
  base = link![1];
  setupToken = link![2];
  adminToken = /(ms_admin_[A-Za-z0-9]+)/.exec(out)![1];
}, 60_000);

afterAll(async () => {
  proc?.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function j(url: string, init: RequestInit = {}, token = adminToken) {
  const res = await fetch(`${base}${url}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text, headers: res.headers };
}

describe("moneyswitch-server (built bundle)", () => {
  it("is healthy, loopback only, and says nothing about a demo", async () => {
    expect((await j("/healthz", {}, "")).body).toEqual({ ok: true });
    expect(new URL(base).hostname).toBe("127.0.0.1");
    expect(out).not.toMatch(/demo/i);
  });

  it("the printed one-time setup link signs in exactly once, and the admin token it hands over is the printed one", async () => {
    expect((await j("/v1/setup/status", {}, "")).body).toEqual({ setup_link_active: true });
    const claim = await j("/v1/setup/claim", { method: "POST", body: JSON.stringify({ setup_token: setupToken }) }, "");
    expect(claim.status).toBe(200);
    expect(claim.body.admin_token).toBe(adminToken);
    const again = await j("/v1/setup/claim", { method: "POST", body: JSON.stringify({ setup_token: setupToken }) }, "");
    expect(again.status).toBe(410);
    expect([401, 403]).toContain((await j("/v1/keys", {}, "")).status);
    expect((await j("/v1/keys")).status).toBe(200);
  });

  it("a MoneyKey can be created, and the public skill never contains one", async () => {
    const created = await j("/v1/keys", {
      method: "POST",
      body: JSON.stringify({ name: "agent", total_budget: "5", daily_budget: "1", per_request_limit: "0.1", allowed_hosts: ["example.com:443"] }),
    });
    expect(created.status).toBe(200);
    expect(created.body.key).toMatch(/^mk_live_/);
    const status = await j("/v1/status", {}, created.body.key);
    expect(status.status).toBe(200);
    const skill = await j("/skill.md", {}, "");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(skill.text).not.toContain(created.body.key);
    expect(skill.text).not.toMatch(/mk_live_[A-Za-z0-9]{8,}/); // the format may be mentioned, a key never
  });

  it("the removed features are gone: no OpenAI gateway, no model channels, no CLI download", async () => {
    const key = (await j("/v1/keys")).body.keys[0];
    expect(key).toBeTruthy();
    for (const [method, url] of [
      ["POST", "/v1/chat/completions"],
      ["GET", "/v1/models"],
      ["GET", "/v1/admin/channels"],
      ["POST", "/v1/admin/channels"],
      ["GET", "/v1/admin/channels/probe-models"],
      ["GET", "/v1/dashboard/billing/usage"],
    ] as const) {
      const res = await j(url, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const dl = await j("/dl/moneyswitch.tgz", {}, "");
    expect(dl.headers.get("content-type") ?? "").not.toMatch(/gzip/);
    const meta = await j("/v1/admin/meta");
    expect(meta.body).not.toHaveProperty("demo");
    expect(meta.body).not.toHaveProperty("demo_seller_url");
    expect(meta.body).not.toHaveProperty("mcp_local_path");
  });

  it("`demo` is refused (exit code 2)", () => {
    const r = spawnSync(process.execPath, [cli, "demo"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/);
  });

  it("--version prints the version and nothing else (no startup banner); --help documents reset-admin-token", () => {
    const v = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 20_000 });
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
    const h = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 20_000 });
    expect(h.status).toBe(0);
    expect(h.stdout).toContain("reset-admin-token");
    expect(h.stdout).toContain("docker compose exec server node /app/dist/cli.js reset-admin-token");
    expect(h.stdout).not.toContain("outbound proxy");
  });
});

/**
 * SPEC.md §2: a lost administrator token is replaced by a command on the server itself - also inside the Docker image, where it is
 * `docker compose exec server node /app/dist/cli.js reset-admin-token` (the image sets MONEYSWITCH_DATA_DIR=/data, so no --data-dir).
 * These run the built bundle against the data directory of the server started above, which keeps running throughout. They come
 * last because the first one retires the token the tests above used.
 */
describe("moneyswitch-server reset-admin-token (built bundle, server running)", () => {
  const reset = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [cli, "reset-admin-token", ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } });
  const databaseBytes = () =>
    Buffer.concat(fs.readdirSync(dataDir).filter((f) => f.startsWith("moneyswitch.sqlite")).map((f) => fs.readFileSync(path.join(dataDir, f))));

  it("prints only the new token on stdout; the old token stops working at once, the new one works, no restart", async () => {
    const oldToken = adminToken;
    const r = reset(["--data-dir", dataDir]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ms_admin_[A-Za-z0-9]+\n$/);
    const fresh = r.stdout.trim();
    expect(fresh).not.toBe(oldToken);
    expect(r.stderr).not.toContain(fresh);

    expect((await j("/v1/keys", {}, oldToken)).status).toBe(403);
    expect((await j("/v1/keys", {}, fresh)).status).toBe(200);
    adminToken = fresh;
  });

  it("the new token is nowhere else: not in the server's output, not in the database files (only its hash is)", () => {
    expect(out).not.toContain(adminToken);
    expect(databaseBytes().includes(Buffer.from(adminToken))).toBe(false);
  });

  it("finds the data directory the way the Docker image sets it (MONEYSWITCH_DATA_DIR, no --data-dir)", async () => {
    const r = reset([], { MONEYSWITCH_DATA_DIR: dataDir });
    expect(r.status, r.stderr).toBe(0);
    const fresh = r.stdout.trim();
    expect(fresh).toMatch(/^ms_admin_/);
    expect((await j("/v1/keys", {}, adminToken)).status).toBe(403);
    expect((await j("/v1/keys", {}, fresh)).status).toBe(200);
    adminToken = fresh;
  });

  it("everything else is untouched: the keys are still there", async () => {
    expect((await j("/v1/keys")).body.keys.length).toBeGreaterThan(0);
  });

  it("refuses a data directory without a database: exit 1, a clear message, nothing on stdout, nothing created", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ms-reset-empty-"));
    try {
      const r = reset(["--data-dir", empty]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/No MoneySwitch database found at .*moneyswitch\.sqlite/);
      expect(r.stderr).toMatch(/Nothing was changed/);
      expect(fs.readdirSync(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not a database: exit 1, nothing on stdout, the file left as it was", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-reset-junk-"));
    try {
      const junk = Buffer.alloc(4096, 9);
      fs.writeFileSync(path.join(dir, "moneyswitch.sqlite"), junk);
      const r = reset(["--data-dir", dir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/Could not open the database/);
      expect(fs.readFileSync(path.join(dir, "moneyswitch.sqlite")).equals(junk)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("usage errors exit 2 and print nothing on stdout", () => {
    for (const args of [["--port", "5000"], ["now"], ["--data-dir"]]) {
      const r = reset(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/moneyswitch-server:/);
    }
  });
});
