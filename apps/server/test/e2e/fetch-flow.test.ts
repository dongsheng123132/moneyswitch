import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
 *   agent HTTP call (POST /v1/fetch) -> server -> demo-seller (402) ->
 *   x402 client signs -> mock-facilitator verifies (real viem signature
 *   check) / settles (fake 0xmock tx) -> 200 -> usage +amount.
 */

const SELLER_PORT = 14021;
const MOCK_FACILITATOR_PORT = 14099;
const SERVER_PORT = 14020;
// 14022 collided with a desktop app (WeChat) on the dev machine; any free port works.
const REDIRECT_SERVER_PORT = 14052;
const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let config: ServerConfig;
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir, { protect: false });
  await wallet.createWithPhrase(); // auto-unlock, like every wallet the server creates
  adminToken = bootstrapAdminToken(db)!;

  config = {
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

describe("T2 offline e2e: agent call -> server -> demo-seller -> mock-facilitator", () => {
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

  it("GET /always-rejected: facilitator /verify 400s the paid retry -> payment_failed/PAYMENT_REJECTED, budget held (not lost, not settled)", async () => {
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
      payload: { url: `http://127.0.0.1:${SELLER_PORT}/always-rejected` },
    });
    const body = res.json();
    expect(body.status).toBe("payment_failed");
    expect(body.code).toBe("PAYMENT_REJECTED");
    expect(body.payment).toBeNull();
    expect(typeof body.reason).toBe("string");
    expect(body.reason).toContain("insufficient_funds");
    expect(body.reserved_until_expiry).toBe(true);

    // Budget is HELD (reduced), not lost outright and not settled: the
    // signed authorization is still technically usable by the seller until
    // it expires.
    const statusAfter = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(Number(statusAfter.json().remaining_today)).toBeLessThan(5);

    const history = await app.inject({
      method: "GET",
      url: "/v1/history",
      headers: { authorization: `Bearer ${key}` },
    });
    const historyBody = history.json();
    expect(historyBody.history[0].status).toBe("unknown");
    expect(historyBody.history[0].error_code).toBe("PAYMENT_REJECTED");
    expect(historyBody.history[0].tx_hash).toBeNull();
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

describe("the approval link (SPEC.md §3)", () => {
  const DEEP = () => `http://127.0.0.1:${SELLER_PORT}/deep-report`;
  const ask = (key: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: DEEP(), ...extra } });

  afterEach(() => {
    config.publicUrl = null;
  });

  it("approval_required carries approve_url = {base}/approvals?id=<id>; the link holds no token, key or secret", async () => {
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });
    const first = (await ask(key)).json();
    expect(first.status).toBe("approval_required");
    expect(first.charged).toBe("no");
    const url = new URL(first.approve_url);
    expect(url.pathname).toBe("/approvals");
    expect([...url.searchParams.keys()]).toEqual(["id"]);
    expect(url.searchParams.get("id")).toBe(first.approval_id);
    expect(url.username + url.password + url.hash).toBe("");
    // without a public URL the link points at the address the server itself listens on
    expect(first.approve_url).toBe(`http://127.0.0.1:${SERVER_PORT}/approvals?id=${first.approval_id}`);
    for (const secret of [key, adminToken]) expect(first.approve_url).not.toContain(secret);
    expect(first.approve_url).not.toMatch(/mk_live_|ms_admin_|ms_setup_|token|secret|password/i);
  });

  it("MONEYSWITCH_PUBLIC_URL decides the base of the link", async () => {
    config.publicUrl = "https://pay.example.com";
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });
    const first = (await ask(key)).json();
    expect(first.approve_url).toBe(`https://pay.example.com/approvals?id=${first.approval_id}`);
  });

  it("a forged Host (or X-Forwarded-*) cannot steer the link: the skill tells the AI to forward it, so it must stay on this server", async () => {
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });
    const forged = { host: "phish.example", "x-forwarded-host": "phish.example", "x-forwarded-proto": "https" };
    const res = await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}`, ...forged }, payload: { url: DEEP() } });
    const first = res.json();
    expect(first.status).toBe("approval_required");
    expect(first.approve_url).toBe(`http://127.0.0.1:${SERVER_PORT}/approvals?id=${first.approval_id}`);
    expect(first.approve_url).not.toContain("phish.example");
    // and with a public URL configured, that one - still not the request's
    config.publicUrl = "https://pay.example.com";
    const again = (await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}`, ...forged }, payload: { url: DEEP() } })).json();
    expect(again.approve_url).toBe(`https://pay.example.com/approvals?id=${again.approval_id}`);
  });

  it("only the other statuses stay link-free", async () => {
    const key = await createKey();
    const ok = (await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: `http://127.0.0.1:${SELLER_PORT}/free` } })).json();
    expect(ok.status).toBe("ok");
    expect(ok).not.toHaveProperty("approve_url");
    const denied = (await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: `http://127.0.0.1:${SELLER_PORT}/greedy` } })).json();
    expect(denied.status).toBe("denied");
    expect(denied).not.toHaveProperty("approve_url");
  });

  it("holding the link (and the agent's own key) approves nothing: approving needs the administrator", async () => {
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });
    const first = (await ask(key)).json();
    const id = first.approval_id as string;
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer not-a-token" }, { authorization: `Bearer ${key}` }];
    for (const headers of attempts) {
      const approve = await app.inject({ method: "POST", url: `/v1/approvals/${id}/approve`, headers });
      expect(approve.statusCode, JSON.stringify(headers).slice(0, 40)).toBe(403);
      const deny = await app.inject({ method: "POST", url: `/v1/approvals/${id}/deny`, headers });
      expect(deny.statusCode).toBe(403);
    }
    // opening the link itself changes nothing (it is a page; the server never reads the id from it)
    await app.inject({ method: "GET", url: new URL(first.approve_url).pathname + new URL(first.approve_url).search });
    const poll = await app.inject({ method: "GET", url: `/v1/approvals/${id}`, headers: { authorization: `Bearer ${key}` } });
    expect(poll.json()).toMatchObject({ id, status: "pending" });
    // and a resend without a decision is still not allowed to pay
    const resend = (await ask(key, { approval_id: id })).json();
    expect(resend.status).not.toBe("ok");
    expect(resend.charged).toBe("no");
  });

  it("approving through the admin API the Approvals page uses lets the resend through exactly once", async () => {
    const key = await createKey({ approval_threshold: "0.10", per_request_limit: "1" });
    const first = (await ask(key)).json();
    const id = first.approval_id as string;
    const admin = { authorization: `Bearer ${adminToken}` };

    // the page opens the link, shows the pending list, and highlights this one
    const list = (await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: admin })).json() as { approvals: Array<{ id: string; status: string; url: string }> };
    expect(list.approvals.map((a) => a.id)).toContain(id);
    expect(list.approvals.find((a) => a.id === id)).toMatchObject({ status: "pending", url: DEEP() });

    const approve = await app.inject({ method: "POST", url: `/v1/approvals/${id}/approve`, headers: admin });
    expect(approve.statusCode).toBe(200);
    // the agent's poll sees it
    const poll = await app.inject({ method: "GET", url: `/v1/approvals/${id}`, headers: { authorization: `Bearer ${key}` } });
    expect(poll.json().status).toBe("approved");

    const paid = (await ask(key, { approval_id: id })).json();
    expect(paid.status).toBe("ok");
    expect(paid.charged).toBe("yes");
    expect(paid.payment.amount).toBe("0.15");
    // the approval is used up: sending it again does not pay a second time
    const again = (await ask(key, { approval_id: id })).json();
    expect(again.status).not.toBe("ok");
    expect(again.charged).toBe("no");
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
