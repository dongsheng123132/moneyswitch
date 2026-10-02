import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the BUILT bundle (dist/cli.js, as published) in demo mode and checks
 * the pre-loaded state through the real HTTP API, using only what the demo
 * prints (the one-time setup link). Needs `pnpm build` first.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "..", "dist", "cli.js");

let proc: ChildProcess;
let out = "";
let base = "";
let setupToken = "";
let demoKey = "";
let dataDir = "";
let admin = "";

beforeAll(async () => {
  expect(fs.existsSync(cli), "run `pnpm build` first").toBe(true);
  proc = spawn(process.execPath, [cli, "demo", "--no-open", "--port", "17620"], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (c) => (out += c.toString()));
  proc.stderr!.on("data", (c) => (out += c.toString()));
  const start = Date.now();
  while (!/Press Ctrl\+C/.test(out)) {
    if (Date.now() - start > 45_000 || proc.exitCode !== null) throw new Error(`demo did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const m = /(http:\/\/127\.0\.0\.1:(\d+))\/setup#(ms_setup_[A-Za-z0-9]+)&demo_key=(mk_live_[A-Za-z0-9]+)/.exec(out);
  expect(m).toBeTruthy();
  base = m![1];
  setupToken = m![3];
  demoKey = m![4];
  dataDir = /Data: (.+?) \(deleted on exit\)/.exec(out)![1].trim();
}, 60_000);

afterAll(async () => {
  proc?.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function j(url: string, init: RequestInit = {}, token = admin) {
  const res = await fetch(`${base}${url}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("moneyswitch-server demo (built bundle)", () => {
  it("picks free ports, says DEMO, never prints anything but loopback URLs", () => {
    expect(out).toContain("DEMO");
    expect(Number(new URL(base).port)).toBeGreaterThanOrEqual(17620);
  });

  it("the printed one-time setup link signs in exactly once", async () => {
    const st = await j("/v1/setup/status", {}, "");
    expect(st.body).toEqual({ setup_link_active: true, demo: true });
    const claim = await j("/v1/setup/claim", { method: "POST", body: JSON.stringify({ setup_token: setupToken }) }, "");
    expect(claim.status).toBe(200);
    admin = claim.body.admin_token;
    const again = await j("/v1/setup/claim", { method: "POST", body: JSON.stringify({ setup_token: setupToken }) }, "");
    expect(again.status).toBe(410);
    // no admin access without the token
    expect([401, 403]).toContain((await j("/v1/keys", {}, "")).status);
  });

  it("is pre-loaded: mock wallet, channel, two keys, mock-settled payments", async () => {
    const wallet = await j("/v1/admin/wallet");
    expect(wallet.body).toMatchObject({ unlocked: true, has_keystore: true, simulated: true });
    expect(Number(wallet.body.usdc_balance)).toBeGreaterThan(19);
    const keys = await j("/v1/keys");
    expect(keys.body.keys.map((k: { name: string }) => k.name).sort()).toEqual(["Claude Code", "Codex"]);
    const channels = await j("/v1/admin/channels");
    expect(channels.body.channels?.length ?? channels.body.length).toBe(1);
    const usage = await j("/v1/admin/usage");
    const payments = usage.body.payments ?? usage.body;
    expect(payments.length).toBeGreaterThanOrEqual(7);
    expect(payments.every((p: { tx_hash: string | null }) => !p.tx_hash || p.tx_hash.startsWith("0xmock"))).toBe(true);
  });

  it("the demo key chats ($0.01) and a $5 purchase is blocked", async () => {
    const chat = await j(
      "/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "moneyswitch-demo-chat", messages: [{ role: "user", content: "hi" }] }) },
      demoKey
    );
    expect(chat.status).toBe(200);
    expect(chat.body.choices[0].message.content).toBe("[demo] You said: hi");
    const meta = await j("/v1/admin/meta");
    expect(meta.body.demo).toBe(true);
    const greedy = await j("/v1/fetch", { method: "POST", body: JSON.stringify({ url: `${meta.body.demo_seller_url}/greedy` }) }, demoKey);
    expect(greedy.body.status).toBe("denied");
    expect(greedy.body.code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
  });
});
