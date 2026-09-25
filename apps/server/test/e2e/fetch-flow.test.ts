import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, formatMicrosToUsdc } from "@moneyswitch/core";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startMockFacilitator } from "@moneyswitch/mock-facilitator";
import { spawn, type ChildProcess } from "node:child_process";
import { Wallet as EthersWallet } from "ethers";
import http from "node:http";
import { schema } from "@moneyswitch/db";
import { eq } from "drizzle-orm";

/**
 * T2 (SPEC §9): fully offline end-to-end. Chain:
 *   MCP-shaped HTTP call -> server /v1/fetch -> demo-seller (402) ->
 *   x402 client signs -> mock-facilitator verifies (real viem signature
 *   check) / settles (fake 0xmock tx) -> 200 -> usage +amount.
 */

const SELLER_PORT = 14021;
const MOCK_FACILITATOR_PORT = 14099;
const SERVER_PORT = 14020;
const REDIRECT_SERVER_PORT = 14022;
const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let mockFacilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
let sellerProc: ChildProcess;
let redirectServer: http.Server;

async function waitForHttp(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

beforeAll(async () => {
  mockFacilitator = await startMockFacilitator(MOCK_FACILITATOR_PORT);

  const sellerEntry = path.resolve(__dirname, "../../../demo-seller/dist/index.js");
  sellerProc = spawn(process.execPath, [sellerEntry], {
    env: {
      ...process.env,
      DEMO_SELLER_PORT: String(SELLER_PORT),
      DEMO_SELLER_PAY_TO: PAY_TO,
      DEMO_SELLER_FACILITATOR_URL: mockFacilitator.url,
    },
    stdio: "pipe",
  });
  let sellerLog = "";
  sellerProc.stdout?.on("data", (d) => (sellerLog += d.toString()));
  sellerProc.stderr?.on("data", (d) => (sellerLog += d.toString()));
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`).catch((e) => {
    throw new Error(`demo-seller did not start: ${e.message}\nlog:\n${sellerLog}`);
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("e2e-test-password");
  await wallet.unlock("e2e-test-password");
  adminToken = bootstrapAdminToken(db)!;

  const config: ServerConfig = {
    port: SERVER_PORT,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
  };
  const ctx: AppContext = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.ready();

  // Minimal HTTP server standing in for a compromised/misbehaving
  // allow-listed host: some of its routes 302 to somewhere the agent
  // must NOT be sent (its own price is irrelevant; these routes are
  // unpriced so no 402 flow is ever involved — the exploit under test is
  // purely "does /v1/fetch follow the redirect and leak host-allowlist/SSRF
  // enforcement", not payment logic).
  redirectServer = http.createServer((req, res) => {
    if (req.url === "/redirect-to-admin") {
      res.writeHead(302, { Location: `http://127.0.0.1:${SERVER_PORT}/v1/keys` });
      res.end();
      return;
    }
    if (req.url === "/redirect-to-external-paid") {
      res.writeHead(302, { Location: `http://127.0.0.1:${SELLER_PORT}/greedy` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => redirectServer.listen(REDIRECT_SERVER_PORT, "127.0.0.1", resolve));
}, 30000);

afterAll(async () => {
  await app?.close();
  sellerProc?.kill();
  await mockFacilitator?.close();
  await new Promise((resolve) => redirectServer?.close(resolve));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createKey(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      name: "e2e",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
      ...overrides,
    },
  });
  return res.json().key as string;
}

describe("T2 offline e2e: MCP-shaped call -> server -> demo-seller -> mock-facilitator", () => {
  it("GET /free costs nothing and returns 200", async () => {
    const key = await createKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/free` },
    });
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.http_status).toBe(200);
    expect(body.payment).toBeNull();
  });

  it("GET /premium-report pays 0.01 via mock-facilitator and settles with a 0xmock tx", async () => {
    const key = await createKey();
    const statusBefore = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(statusBefore.json().remaining_today).toBe("5");

    const res = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/premium-report` },
    });
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.http_status).toBe(200);
    expect(body.payment).not.toBeNull();
    expect(body.payment.amount).toBe("0.01");
    expect(body.payment.tx_hash).toMatch(/^0xmock/);
    expect(body.remaining_today).toBe("4.99");

    const statusAfter = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(statusAfter.json().remaining_today).toBe("4.99");

    const history = await app.inject({
      method: "GET",
      url: "/v1/history",
      headers: { authorization: `Bearer ${key}` },
    });
    const historyBody = history.json();
    expect(historyBody.history[0].status).toBe("settled");
    expect(historyBody.history[0].tx_hash).toMatch(/^0xmock/);
  });

  it("GET /greedy (5.00) is blocked by per_request_limit=1 before any signature is created", async () => {
    const key = await createKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/greedy` },
    });
    const body = res.json();
    expect(body.status).toBe("denied");
    expect(body.code).toBe("PER_REQUEST_LIMIT_EXCEEDED");
  });

  it("GET /deep-report (0.15) with approval_threshold=0.10 triggers APPROVAL_REQUIRED, then succeeds after approve+retry", async () => {
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });

    const first = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/deep-report` },
    });
    const firstBody = first.json();
    expect(firstBody.status).toBe("approval_required");
    const approvalId = firstBody.approval_id as string;
    expect(approvalId).toBeTruthy();

    await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/deep-report`, approval_id: approvalId },
    });
    const secondBody = second.json();
    expect(secondBody.status).toBe("ok");
    expect(secondBody.payment.amount).toBe("0.15");
  });
});

describe("Security fix: outbound redirects are never followed", () => {
  let redirectKeyCounter = 0;

  async function createRedirectAwareKey(): Promise<{ key: string; id: string }> {
    redirectKeyCounter += 1;
    const res = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: `redirect-test-${redirectKeyCounter}`,
        total_budget: "10",
        daily_budget: "5",
        per_request_limit: "1",
        // Only the redirect-server host is allow-listed — NOT the admin
        // server's own 4020-equivalent port, NOT the seller's /greedy.
        allowed_hosts: [`127.0.0.1:${REDIRECT_SERVER_PORT}`],
      },
    });
    const body = res.json();
    return { key: body.key as string, id: body.id as string };
  }

  function countPaymentsForKeyId(keyId: string): number {
    return db.select().from(schema.payments).where(eq(schema.payments.keyId, keyId)).all().length;
  }

  it("(a) 302 to MoneySwitch's own admin API is returned as-is, not followed, no payment recorded", async () => {
    const { key, id } = await createRedirectAwareKey();

    const res = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${REDIRECT_SERVER_PORT}/redirect-to-admin` },
    });
    const body = res.json();

    // Not followed: raw 3xx comes back, with Location exposed but un-acted-on.
    expect(body.status).toBe("ok");
    expect(body.http_status).toBe(302);
    expect(body.headers.location).toBe(`http://127.0.0.1:${SERVER_PORT}/v1/keys`);
    expect(body.payment).toBeNull();

    // No payment was ever attempted for this call (unpriced redirect route).
    expect(countPaymentsForKeyId(id)).toBe(0);
  });

  it("(b) 302 to an allowlist-external paid route is returned as-is, not followed, no payment recorded", async () => {
    const { key, id } = await createRedirectAwareKey();

    const res = await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: `http://127.0.0.1:${REDIRECT_SERVER_PORT}/redirect-to-external-paid` },
    });
    const body = res.json();

    expect(body.status).toBe("ok");
    expect(body.http_status).toBe(302);
    expect(body.headers.location).toBe(`http://127.0.0.1:${SELLER_PORT}/greedy`);
    expect(body.payment).toBeNull();
    expect(countPaymentsForKeyId(id)).toBe(0);
  });

  it("policy-recorded host/url always equals the actually-requested URL (redirect target is never substituted)", async () => {
    // Sanity re-assertion for the normal paid path: the payment row's `url`
    // and `host` must equal the URL /v1/fetch was called with, never a
    // redirect target — this holds structurally once redirects are never
    // followed (performPaidFetch always reserves against `input.url`).
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "url-fidelity-check",
        total_budget: "10",
        daily_budget: "5",
        per_request_limit: "1",
        allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
      },
    });
    const created = createRes.json();
    const key = created.key as string;
    const requestedUrl = `http://127.0.0.1:${SELLER_PORT}/premium-report`;
    await app.inject({
      method: "POST",
      url: "/v1/fetch",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: requestedUrl },
    });
    const rows = db.select().from(schema.payments).where(eq(schema.payments.keyId, created.id)).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.url).toBe(requestedUrl);
      expect(row.host).toBe(`127.0.0.1:${SELLER_PORT}`);
    }
  });
});
