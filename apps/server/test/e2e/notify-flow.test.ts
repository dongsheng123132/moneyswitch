import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Wallet as EthersWallet } from "ethers";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, createApproval, createMoneyKey } from "@moneyswitch/core";
import { startMockFacilitator } from "@moneyswitch/mock-facilitator";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { startNotifyLoop } from "../../src/notify/outbox.js";
import { startServer } from "../../src/start.js";

/**
 * Approval push notification, end to end and offline:
 *   agent -> POST /v1/fetch -> demo-seller (402) -> amount >= approval threshold
 *   -> approval row (pending) -> outbox loop -> fake webhook receives exactly one event.
 */

// Ports are picked at runtime (several worktrees / sessions run these suites on one machine, fixed ports collide).
let SELLER_PORT = 0;
let MOCK_FACILITATOR_PORT = 0;
let SERVER_PORT = 0;
let WEBHOOK_PORT = 0;
const PUBLIC_URL = "https://pay.example.com";
const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let app: ReturnType<typeof buildApp>;
let ctx: AppContext;
let adminToken: string;
let mockFacilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
let sellerProc: ChildProcess;
let webhookServer: http.Server;
let loop: ReturnType<typeof startNotifyLoop>;

/** What the fake webhook receiver saw, and how it should answer. */
const received: any[] = [];
let webhookMode: "ok" | "fail" | "hang" = "ok";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks the OS for a currently free loopback port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
async function waitFor(cond: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

async function waitForHttp(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

beforeAll(async () => {
  [SELLER_PORT, MOCK_FACILITATOR_PORT, SERVER_PORT, WEBHOOK_PORT] = [await freePort(), await freePort(), await freePort(), await freePort()];
  mockFacilitator = await startMockFacilitator(MOCK_FACILITATOR_PORT);
  const sellerEntry = path.resolve(__dirname, "../../../demo-seller/dist/index.js");
  sellerProc = spawn(process.execPath, [sellerEntry], {
    env: {
      ...process.env,
      DEMO_SELLER_PORT: String(SELLER_PORT),
      DEMO_SELLER_PAY_TO: PAY_TO,
      DEMO_SELLER_FACILITATOR_URL: mockFacilitator.url,
      DEMO_SELLER_TEST_ROUTES: "1",
    },
    stdio: "pipe",
  });
  let sellerLog = "";
  sellerProc.stdout?.on("data", (d) => (sellerLog += d.toString()));
  sellerProc.stderr?.on("data", (d) => (sellerLog += d.toString()));
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`).catch((e) => {
    throw new Error(`demo-seller did not start: ${e.message}\nlog:\n${sellerLog}`);
  });

  webhookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      if (webhookMode === "hang") return; // never answer
      res.writeHead(webhookMode === "fail" ? 500 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => webhookServer.listen(WEBHOOK_PORT, "127.0.0.1", resolve));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  const wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("e2e-test-password");
  await wallet.unlock("e2e-test-password");
  adminToken = bootstrapAdminToken(db)!;

  ctx = {
    db,
    sqlite,
    wallet,
    config: { port: SERVER_PORT, host: "127.0.0.1", dataDir: tmpDir, dbFilePath: ":memory:", walletPassword: null, publicUrl: PUBLIC_URL },
    notify: {
      env: { MONEYSWITCH_NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${WEBHOOK_PORT}/ms-hook` },
      log: { info: () => undefined, warn: () => undefined },
      sendTimeoutMs: 20_000,
    },
  };
  app = buildApp(ctx);
  await app.ready();
  loop = startNotifyLoop(ctx, 50);
}, 40000);

afterAll(async () => {
  const t0 = Date.now();
  await loop?.stop();
  const stopMs = Date.now() - t0;
  await app?.close();
  sellerProc?.kill();
  await mockFacilitator?.close();
  webhookServer?.closeAllConnections();
  await new Promise((resolve) => webhookServer?.close(resolve));
  sqlite?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  // a hanging send must not hold the shutdown hostage
  expect(stopMs).toBeLessThan(3000);
});

async function createKey(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      name: "Codex",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
      approval_threshold: "0.10",
      ...overrides,
    },
  });
  const body = res.json();
  return { key: body.key as string, id: body.id as string };
}

async function fetchVia(key: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload });
  return res.json();
}

describe("approval push notification e2e", () => {
  it("a payment over the approval threshold makes the webhook receive exactly one event with the right fields", async () => {
    webhookMode = "ok";
    received.length = 0;
    const { key } = await createKey();

    const first = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report?token=QUERYSECRET` });
    expect(first.status).toBe("approval_required");
    const approvalId = first.approval_id as string;

    await waitFor(() => received.length >= 1);
    // give the loop plenty of ticks (50ms each) to prove it does not send twice
    await sleep(600);
    expect(received).toHaveLength(1);

    const ev = received[0];
    expect(ev.url).toBe("/ms-hook");
    expect(ev.body).toEqual({
      event: "approval_required",
      approval: {
        id: approvalId,
        key_name: "Codex",
        key_prefix: expect.stringMatching(/^mk_live_/),
        amount: "0.15",
        currency: "USDC",
        host: `127.0.0.1:${SELLER_PORT}`,
        path: "/deep-report",
        method: "GET",
        expires_at: expect.any(String),
      },
      approve_url: `${PUBLIC_URL}/approvals`,
    });
    expect(ev.body.approval.key_prefix.length).toBe(12);
    expect(JSON.stringify(ev.body)).not.toContain("QUERYSECRET");
    const msLeft = new Date(ev.body.approval.expires_at).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(8 * 60_000);
    expect(msLeft).toBeLessThanOrEqual(10 * 60_000);

    // approve + retry completes the payment and does not produce another event
    const approve = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(approve.statusCode).toBe(200);
    const second = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report?token=QUERYSECRET`, approval_id: approvalId });
    expect(second.status).toBe("ok");
    await sleep(300);
    expect(received).toHaveLength(1);
  });

  it("a payment below the threshold sends nothing", async () => {
    received.length = 0;
    const { key } = await createKey({ approval_threshold: "0.50", per_request_limit: "1" });
    const r = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report` });
    expect(r.status).toBe("ok");
    await sleep(400);
    expect(received).toHaveLength(0);
  });

  it("a failing webhook never fails or slows the payment path; the failed delivery is recorded for retry", async () => {
    webhookMode = "fail";
    received.length = 0;
    const { key } = await createKey();
    const t0 = Date.now();
    const r = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report` });
    expect(r.status).toBe("approval_required");
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitFor(() => received.length >= 1);
    await sleep(300);
    const row = sqlite
      .prepare(
        `SELECT a.notified_at AS notified_at, d.attempts AS attempts, d.delivered_at AS delivered_at
           FROM approvals a JOIN approval_notify_deliveries d ON d.approval_id = a.id AND d.channel = 'webhook' WHERE a.id = ?`
      )
      .get(r.approval_id) as { notified_at: string | null; attempts: number; delivered_at: string | null };
    expect(row.notified_at).toBeNull();
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(received).toHaveLength(1); // back-off: not hammered
  });

  it("a hanging webhook never blocks the payment path either (and shutdown aborts it, see afterAll)", async () => {
    webhookMode = "hang";
    received.length = 0;
    const { key } = await createKey();
    const t0 = Date.now();
    const r = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report` });
    expect(r.status).toBe("approval_required");
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitFor(() => received.length >= 1); // the request reached the (silent) receiver
    // a second approval-needing payment is also unaffected while the first send is stuck
    const r2 = await fetchVia(key, { url: `http://127.0.0.1:${SELLER_PORT}/deep-report?x=2` });
    expect(r2.status).toBe("approval_required");
  });

  it("startServer runs the outbox loop (MONEYSWITCH_NOTIFY_WEBHOOK_URL from the environment) but not in offline demo mode", async () => {
    const saved = process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL;
    process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}/from-start`;
    webhookMode = "ok";
    const dirs: string[] = [];
    const boot = async (demo: boolean) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-start-"));
      dirs.push(dir);
      const running = await startServer({
        port: await freePort(),
        host: "127.0.0.1",
        dataDir: dir,
        dbFilePath: path.join(dir, "ms.sqlite"),
        walletPassword: null,
        reconcileIntervalMs: 0,
        notifyIntervalMs: 50,
        ...(demo ? { demo: { startingBalanceMicros: 0 } } : {}),
      });
      const { row: key } = createMoneyKey(running.ctx.db, {
        name: demo ? "demo-key" : "real-key",
        totalBudget: 10_000_000n,
        dailyBudget: 5_000_000n,
        perRequestLimit: 1_000_000n,
        approvalThreshold: 100_000n,
        allowedHosts: ["api.example.com"],
      });
      createApproval(running.ctx.db, {
        keyId: key.id,
        url: "https://api.example.com/x",
        method: "GET",
        body: undefined,
        network: "eip155:10143",
        asset: "0xusdc",
        payTo: "0xpay",
        amount: 150_000n,
      });
      return running;
    };
    try {
      received.length = 0;
      const real = await boot(false);
      await waitFor(() => received.some((r) => r.url === "/from-start"));
      expect(received.filter((r) => r.url === "/from-start").map((r) => r.body.approval.key_name)).toEqual(["real-key"]);
      const t0 = Date.now();
      await real.close();
      expect(Date.now() - t0).toBeLessThan(3000);

      received.length = 0;
      const demo = await boot(true);
      await sleep(500);
      expect(received).toHaveLength(0);
      await demo.close();
    } finally {
      if (saved === undefined) delete process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL;
      else process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL = saved;
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("offline demo: ignores MONEYSWITCH_NOTIFY_* from the environment, but delivers to a channel saved in the demo's own database", async () => {
    const saved = process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL;
    process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}/from-env`;
    webhookMode = "ok";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-demo-"));
    let demoAdmin = "";
    let running: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      running = await startServer(
        {
          port: await freePort(),
          host: "127.0.0.1",
          dataDir: dir,
          dbFilePath: path.join(dir, "ms.sqlite"),
          walletPassword: null,
          reconcileIntervalMs: 0,
          notifyIntervalMs: 50,
          demo: { startingBalanceMicros: 0 },
        },
        { onFirstRun: (s) => (demoAdmin = s.adminToken) }
      );
      const auth = { authorization: `Bearer ${demoAdmin}` };
      // the environment's webhook is not part of the demo: it is neither used nor shown
      const before = await running.app.inject({ method: "GET", url: "/v1/admin/notify", headers: auth });
      expect(before.json().channels.webhook).toMatchObject({ configured: false, url: { set: false } });

      // what the Dashboard does: save a channel
      const put = await running.app.inject({
        method: "PUT",
        url: "/v1/admin/notify",
        headers: auth,
        payload: { webhook: { url: `http://127.0.0.1:${WEBHOOK_PORT}/from-demo-db` } },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().channels.webhook).toMatchObject({ configured: true, url: { set: true, source: "db" } });

      received.length = 0;
      const { row: key } = createMoneyKey(running.ctx.db, {
        name: "demo-key",
        totalBudget: 10_000_000n,
        dailyBudget: 5_000_000n,
        perRequestLimit: 1_000_000n,
        approvalThreshold: 100_000n,
        allowedHosts: ["api.example.com"],
      });
      createApproval(running.ctx.db, {
        keyId: key.id,
        url: "https://api.example.com/x",
        method: "GET",
        body: undefined,
        network: "eip155:10143",
        asset: "0xusdc",
        payTo: "0xpay",
        amount: 150_000n,
      });
      await waitFor(() => received.some((r) => r.url === "/from-demo-db"));
      await sleep(400);
      expect(received.filter((r) => r.url === "/from-demo-db").map((r) => r.body.approval.key_name)).toEqual(["demo-key"]);
      expect(received.filter((r) => r.url === "/from-env")).toHaveLength(0);
    } finally {
      await running?.close();
      if (saved === undefined) delete process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL;
      else process.env.MONEYSWITCH_NOTIFY_WEBHOOK_URL = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
