import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, listHistoryForKey, listUnknownPaymentsToReconcile, getPayment } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * "Paid but no delivery" (incident: a slow LLM seller took >30s on Monad
 * testnet, we aborted AFTER signing, the seller still settled, the agent got a
 * retryable-looking UPSTREAM_ERROR). Fully offline: the scriptable stub seller
 * + the mock facilitator (real EIP-3009 signature verification). Deadlines are
 * shrunk through the real env knobs, which performPaidFetch reads per call.
 */

const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let seller: StubSeller;

const ENV_KEYS = ["MONEYSWITCH_PROBE_TIMEOUT_MS", "MONEYSWITCH_PAID_TIMEOUT_MS"] as const;
const savedEnv: Record<string, string | undefined> = {};

function setTimeouts(probeMs: number, paidMs: number) {
  process.env.MONEYSWITCH_PROBE_TIMEOUT_MS = String(probeMs);
  process.env.MONEYSWITCH_PAID_TIMEOUT_MS = String(paidMs);
}

beforeAll(async () => {
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorPort = (facilitator.server.address() as { port: number }).port;
  seller = await startStubSeller({ facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`, payTo: PAY_TO });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-paid-timeout-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("e2e-test-password");
  await wallet.unlock("e2e-test-password");
  adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
  };
  const ctx: AppContext = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.ready();
}, 30000);

afterAll(async () => {
  await app?.close();
  await seller?.close();
  await facilitator?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  seller.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const keyIds = new Map<string, string>();

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
      allowed_hosts: [`127.0.0.1:${seller.port}`],
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(200);
  keyIds.set(res.json().key, res.json().id);
  return res.json().key as string;
}

async function fetchVia(key: string, payload: Record<string, unknown>) {
  const started = Date.now();
  const res = await app.inject({
    method: "POST",
    url: "/v1/fetch",
    headers: { authorization: `Bearer ${key}` },
    payload,
  });
  return { res, body: res.json(), ms: Date.now() - started };
}

async function status(key: string) {
  const res = await app.inject({ method: "GET", url: "/v1/status", headers: { authorization: `Bearer ${key}` } });
  return res.json() as { remaining_today: string; remaining_total: string; used_total: string };
}

/** The payments row(s) of a key, newest first. */
async function payments(key: string) {
  return listHistoryForKey(db, keyIds.get(key)!, 50);
}

const URL_ITEM = () => `${seller.url}/item`;

describe("two-phase deadline", () => {
  it("seller slower than the PROBE timeout but within the PAID timeout after payment -> ok, charged yes", async () => {
    setTimeouts(600, 5000);
    seller.setBehavior({ paidDelayMs: 1500 }); // 2.5x the probe deadline, settled before the delay
    const key = await createKey();
    const { body, ms } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("ok");
    expect(body.charged).toBe("yes");
    expect(body.http_status).toBe(200);
    expect(JSON.parse(body.body).delivered).toBe(true);
    expect(body.payment.amount).toBe("0.01");
    expect(body.payment.tx_hash).toMatch(/^0xmock/);
    expect(ms).toBeGreaterThanOrEqual(1400);

    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(rows[0].txHash).toBe(body.payment.tx_hash);
    expect(seller.requests.map((r) => r.paid)).toEqual([false, true]);
  });

  it("seller exceeds the PAID timeout after payment -> payment_unknown / TIMEOUT_AFTER_PAYMENT, charged maybe, row unknown, budget still reserved", async () => {
    setTimeouts(600, 800);
    seller.setBehavior({ paidDelayMs: 4000 }); // the seller settles at once, then answers far too late (the incident)
    const key = await createKey();
    const before = await status(key);

    const { body, ms } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("payment_unknown");
    expect(body.code).toBe("TIMEOUT_AFTER_PAYMENT");
    expect(body.charged).toBe("maybe");
    expect(body.payment).toEqual({ amount: "0.01", tx_hash: null, network: expect.stringMatching(/^eip155:/) });
    expect(body.reason).toMatch(/Do NOT retry automatically/);
    expect(body.reason).toMatch(/may have been charged/);
    expect(body.reserved_until_expiry).toBe(true);
    // old fields kept for backward compatibility
    expect(body).toHaveProperty("http_status");
    expect(body).toHaveProperty("headers");
    expect(body).toHaveProperty("body");
    expect(body).toHaveProperty("approval_id");
    expect(body).toHaveProperty("remaining_today");
    expect(ms).toBeLessThan(3500); // gave up at the paid deadline, not when the seller finally answered
    expect(seller.settleCalls()).toBe(1); // the seller really did settle

    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].errorCode).toBe("TIMEOUT_AFTER_PAYMENT");
    expect(rows[0].txHash).toBeNull();
    expect(rows[0].authNonce).toBeTruthy(); // authorization captured before sending => reconcilable
    expect(rows[0].authFrom).toBeTruthy();

    // the budget stays reserved (0.01 held) ...
    const after = await status(key);
    expect(Number(before.remaining_total) - Number(after.remaining_total)).toBeCloseTo(0.01, 6);
    expect(after.used_total).toBe("0.01");
    // ... and reconcile will pick the row up once the authorization has expired
    const cutoffInTheFuture = Math.floor(Date.now() / 1000) + 3600;
    expect(listUnknownPaymentsToReconcile(db, cutoffInTheFuture).map((p) => p.id)).toContain(rows[0].id);
    expect(getPayment(db, rows[0].id)!.status).toBe("unknown");
  });

  it("a non-timeout failure after payment (connection cut before any response) -> payment_unknown / UPSTREAM_ERROR_AFTER_PAYMENT, charged maybe, row unknown", async () => {
    setTimeouts(600, 5000);
    seller.setBehavior({ response: "destroy-before-headers" });
    const key = await createKey();
    const { body, ms } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("payment_unknown");
    expect(body.code).toBe("UPSTREAM_ERROR_AFTER_PAYMENT");
    expect(body.charged).toBe("maybe");
    expect(body.payment).toEqual({ amount: "0.01", tx_hash: null, network: expect.stringMatching(/^eip155:/) });
    expect(body.reason).toMatch(/Do NOT retry automatically/);
    expect(ms).toBeLessThan(4000); // failed fast, did not wait for a deadline
    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].errorCode).toBe("UPSTREAM_ERROR_AFTER_PAYMENT");
    expect(rows[0].authNonce).toBeTruthy();
    expect((await status(key)).used_total).toBe("0.01");
  });

  it("unpaid probe never answers -> error UPSTREAM_ERROR, charged no, no payment row, gives up at the PROBE deadline", async () => {
    setTimeouts(500, 60000);
    seller.setBehavior({ probeDelayMs: Infinity });
    const key = await createKey();
    const { body, ms } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("error");
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.charged).toBe("no");
    expect(body.payment).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(3000);
    expect(await payments(key)).toHaveLength(0);
    expect(seller.settleCalls()).toBe(0);
  });

  it("invalid timeout env values fall back to the defaults instead of disabling the deadline or aborting at once", async () => {
    process.env.MONEYSWITCH_PROBE_TIMEOUT_MS = "0";
    process.env.MONEYSWITCH_PAID_TIMEOUT_MS = "banana";
    seller.setBehavior({ paidDelayMs: 300 });
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("ok");
    expect(body.charged).toBe("yes");
  });
});

describe("settlement is recorded from the headers before the body is read", () => {
  it("settled header, then the connection is cut mid-body -> error UPSTREAM_BODY_INCOMPLETE, charged yes, payment settled WITH its tx hash", async () => {
    setTimeouts(600, 5000);
    seller.setBehavior({ response: "headers-then-destroy" });
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("error");
    expect(body.code).toBe("UPSTREAM_BODY_INCOMPLETE");
    expect(body.charged).toBe("yes");
    expect(body.payment.amount).toBe("0.01");
    expect(body.payment.tx_hash).toMatch(/^0xmock/);
    expect(body.reason).toMatch(/Do NOT retry automatically/);
    expect(body.reason).toContain(body.payment.tx_hash);

    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(rows[0].txHash).toBe(body.payment.tx_hash);
    expect(rows[0].errorCode).toBeNull();
    expect((await status(key)).used_total).toBe("0.01");
  });

  it("settled header, then the body stalls past the PAID deadline -> same outcome (the paid deadline bounds the body read)", async () => {
    setTimeouts(600, 900);
    seller.setBehavior({ response: "headers-then-stall" });
    const key = await createKey();
    const { body, ms } = await fetchVia(key, { url: URL_ITEM() });

    expect(body.status).toBe("error");
    expect(body.code).toBe("UPSTREAM_BODY_INCOMPLETE");
    expect(body.charged).toBe("yes");
    expect(body.payment.tx_hash).toMatch(/^0xmock/);
    expect(ms).toBeLessThan(5000);
    const rows = await payments(key);
    expect(rows[0].status).toBe("settled");
    expect(rows[0].txHash).toBe(body.payment.tx_hash);
  });
});

describe("`charged` on every /v1/fetch envelope", () => {
  it("free resource -> ok, charged no, payment null", async () => {
    seller.setBehavior({ free: true });
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("ok");
    expect(body.charged).toBe("no");
    expect(body.payment).toBeNull();
  });

  it("host not allowed -> denied, charged no", async () => {
    const key = await createKey({ allowed_hosts: ["127.0.0.1:1"] });
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("denied");
    expect(body.code).toBe("HOST_NOT_ALLOWED");
    expect(body.charged).toBe("no");
  });

  it("over the per-request limit -> denied, charged no", async () => {
    seller.setBehavior({ amount: "2000000" }); // 2 USDC > per_request_limit 1
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("denied");
    expect(body.charged).toBe("no");
    expect(await payments(key)).toHaveLength(0);
  });

  it("invalid URL -> error FORBIDDEN, charged no", async () => {
    const key = await createKey();
    const { res, body } = await fetchVia(key, { url: "not a url" });
    expect(res.statusCode).toBe(400);
    expect(body.status).toBe("error");
    expect(body.charged).toBe("no");
  });

  it("bad / missing MoneyKey (401 from the auth guard) -> charged no", async () => {
    const bad = await app.inject({
      method: "POST", url: "/v1/fetch", headers: { authorization: "Bearer mk_live_doesnotexist" }, payload: { url: URL_ITEM() },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ status: "error", code: "KEY_INVALID", charged: "no" });
    const missing = await app.inject({ method: "POST", url: "/v1/fetch", payload: { url: URL_ITEM() } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ status: "error", code: "KEY_INVALID", charged: "no" });
  });

  it("approval_required -> charged no", async () => {
    const key = await createKey({ approval_threshold: "0.005" });
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("approval_required");
    expect(body.charged).toBe("no");
  });

  it("seller answers 402 again after our payment -> payment_failed / PAYMENT_REJECTED, charged maybe (reserved_until_expiry)", async () => {
    seller.setBehavior({ response: "reject-402" });
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("payment_failed");
    expect(body.code).toBe("PAYMENT_REJECTED");
    expect(body.charged).toBe("maybe");
    expect(body.reserved_until_expiry).toBe(true);
    expect((await payments(key))[0].status).toBe("unknown");
  });

  it("200 without a settlement header -> ok, but charged maybe and the row is unknown/NO_SETTLE_HEADER", async () => {
    seller.setBehavior({ response: "ok-no-settle-header" });
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body.status).toBe("ok");
    expect(body.charged).toBe("maybe");
    expect(body.payment).toBeNull();
    const rows = await payments(key);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].errorCode).toBe("NO_SETTLE_HEADER");
  });
});

describe("request body encoding (CONTRACT)", () => {
  function paidRequest() {
    const r = seller.requests.filter((x) => x.paid);
    expect(r).toHaveLength(1);
    return r[0];
  }

  it("object body -> JSON bytes with content-type application/json (probe and paid request alike)", async () => {
    const key = await createKey();
    const { body } = await fetchVia(key, { url: URL_ITEM(), method: "POST", body: { q: "hello", n: 2 } });
    expect(body.charged).toBe("yes");
    for (const r of seller.requests) {
      expect(r.body).toBe('{"q":"hello","n":2}');
      expect(r.headers["content-type"]).toBe("application/json");
    }
    expect(seller.requests).toHaveLength(2);
  });

  it("array body -> JSON", async () => {
    const key = await createKey();
    await fetchVia(key, { url: URL_ITEM(), method: "POST", body: [1, "two"] });
    expect(paidRequest().body).toBe('[1,"two"]');
    expect(paidRequest().headers["content-type"]).toBe("application/json");
  });

  it("object body keeps a caller-supplied content-type (any casing)", async () => {
    const key = await createKey();
    await fetchVia(key, {
      url: URL_ITEM(), method: "POST", body: { a: 1 }, headers: { "Content-Type": "application/vnd.api+json" },
    });
    expect(paidRequest().body).toBe('{"a":1}');
    expect(paidRequest().headers["content-type"]).toBe("application/vnd.api+json");
  });

  it("string body -> sent verbatim, NOT JSON-quoted", async () => {
    const key = await createKey();
    await fetchVia(key, {
      url: URL_ITEM(), method: "POST", body: "a=1&b=two", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(paidRequest().body).toBe("a=1&b=two");
    expect(paidRequest().headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("a string that happens to be JSON text is sent as-is (no double encoding)", async () => {
    const key = await createKey();
    await fetchVia(key, { url: URL_ITEM(), method: "POST", body: '{"already":"json"}' });
    expect(paidRequest().body).toBe('{"already":"json"}');
    // we do not invent a content-type for a string body
    expect(paidRequest().headers["content-type"]).not.toBe("application/json");
  });
});

describe("approval body binding follows the wire bytes", () => {
  async function approve(id: string) {
    const r = await app.inject({
      method: "POST",
      url: `/v1/approvals/${id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
  }

  for (const [label, requestBody, otherBody] of [
    ["object body", { prompt: "do the thing", n: 3 }, { prompt: "do the thing", n: 4 }],
    ["string body", "prompt=do+the+thing&n=3", "prompt=do+the+thing&n=4"],
  ] as const) {
    it(`${label}: the approved retry with the same body matches and pays; a changed body is APPROVAL_INVALID`, async () => {
      const key = await createKey({ approval_threshold: "0.005" });
      const call = { url: URL_ITEM(), method: "POST" };

      const first = (await fetchVia(key, { ...call, body: requestBody })).body;
      expect(first.status).toBe("approval_required");
      expect(first.charged).toBe("no");
      await approve(first.approval_id);

      // a different body must not ride on this approval
      const tampered = (await fetchVia(key, { ...call, body: otherBody, approval_id: first.approval_id })).body;
      expect(tampered.status).toBe("denied");
      expect(tampered.code).toBe("APPROVAL_INVALID");
      expect(tampered.charged).toBe("no");

      const retry = (await fetchVia(key, { ...call, body: requestBody, approval_id: first.approval_id })).body;
      expect(retry.status).toBe("ok");
      expect(retry.charged).toBe("yes");
      expect(retry.approval_id).toBe(first.approval_id);
      expect(retry.payment.tx_hash).toMatch(/^0xmock/);
    });
  }
});

describe("OpenAI-compatible gateway maps the new outcomes", () => {
  const MODEL = "stub-model";

  async function channelAndKey() {
    const ch = await app.inject({
      method: "POST",
      url: "/v1/admin/channels",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "stub", base_url: `${seller.url}/v1`, models: [MODEL] },
    });
    expect(ch.statusCode).toBeLessThan(300);
    return createKey();
  }
  async function chat(key: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    });
    return { res, body: res.json() };
  }

  it("payment signed, seller too slow -> non-retryable error that says it may have been charged, with moneyswitch_charged=maybe", async () => {
    setTimeouts(600, 800);
    seller.setBehavior({ paidDelayMs: 4000 });
    const key = await channelAndKey();
    const { res, body } = await chat(key);

    expect(res.statusCode).toBe(402); // not 5xx/408/409/429: OpenAI clients must not auto-retry a possibly-paid call
    expect(res.headers["x-should-retry"]).toBe("false");
    expect(body.error.code).toBe("TIMEOUT_AFTER_PAYMENT");
    expect(body.error.moneyswitch_charged).toBe("maybe");
    expect(body.error.message).toMatch(/may have been charged/);
    expect(body.error.message).toMatch(/Do not retry blindly/i);
    expect(body.error.payment).toEqual({ amount: "0.01", tx_hash: null, network: expect.stringMatching(/^eip155:/) });
    const rows = await payments(key);
    expect(rows[0].status).toBe("unknown");
    expect(rows[0].errorCode).toBe("TIMEOUT_AFTER_PAYMENT");
    expect(rows[0].kind).toBe("chat");
  });

  it("settled but the body is cut -> UPSTREAM_BODY_INCOMPLETE, moneyswitch_charged=yes, tx hash included", async () => {
    setTimeouts(600, 5000);
    seller.setBehavior({ response: "headers-then-destroy" });
    const key = await channelAndKey();
    const { res, body } = await chat(key);

    expect(res.statusCode).toBe(402);
    expect(res.headers["x-should-retry"]).toBe("false");
    expect(body.error.code).toBe("UPSTREAM_BODY_INCOMPLETE");
    expect(body.error.moneyswitch_charged).toBe("yes");
    expect(body.error.payment.tx_hash).toMatch(/^0xmock/);
    expect(body.error.message).toMatch(/have been charged/);
    expect((await payments(key))[0].status).toBe("settled");
  });

  it("normal completion carries moneyswitch.charged=yes; PAYMENT_REJECTED carries moneyswitch_charged=maybe", async () => {
    const key = await channelAndKey();
    const ok = await chat(key);
    expect(ok.res.statusCode).toBe(200);
    expect(ok.body.moneyswitch.charged).toBe("yes");

    seller.setBehavior({ response: "reject-402" });
    const rejected = await chat(key);
    expect(rejected.res.statusCode).toBe(402);
    expect(rejected.body.error.code).toBe("PAYMENT_REJECTED");
    expect(rejected.body.error.moneyswitch_charged).toBe("maybe");
  });
});
