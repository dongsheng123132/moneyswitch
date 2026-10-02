import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import {
  bootstrapAdminToken,
  evaluateAndReserve,
  markUnknown,
  recordPaymentAuthorization,
  getMoneyKeyById,
  type AuthorizationReader,
} from "@moneyswitch/core";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";

/**
 * v0.5 (SPEC-v0.5 §"unknown 付款的链上对账"): a buyer signs an EIP-3009
 * authorization, but the seller-side toll booth's own upstream 500s AND its
 * cancellation call to the facilitator also fails — so the buyer never gets
 * ANY settlement info back (client.ts's existing NO_SETTLE_HEADER path,
 * unchanged by this feature) and the payment sits at status=unknown,
 * conservatively holding the key's quota.
 *
 * Reproducing that exact double-failure (flaky facilitator mid-cancellation)
 * over a real HTTP handshake is out of scope for this test's harness; instead
 * this test starts from that already-documented, already-tested outcome
 * directly (reserve -> markUnknown -> recordPaymentAuthorization, exactly
 * what performPaidFetch's onAfterPaymentCreation + NO_SETTLE_HEADER branch
 * produce) and exercises what's new here end-to-end over real HTTP: the
 * authorization expires, a fake on-chain reader is injected (no real RPC is
 * ever touched), and POST /v1/admin/reconcile is what recovers the buyer's
 * quota.
 */

const SERVER_PORT = 18020;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const SELLER_HOST = "127.0.0.1:18021"; // never actually dialed in this test

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let ctx: AppContext;
let adminToken: string;

async function call(method: string, url: string, token: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function adminCreateKey(over: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/keys", adminToken, {
    name: "buyer",
    total_budget: "10",
    daily_budget: "1",
    per_request_limit: "1",
    allowed_hosts: [SELLER_HOST],
    max_payments_per_minute: 100,
    ...over,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { id: string; key: string };
}

async function getKeyView(id: string) {
  const r = await call("GET", "/v1/keys", adminToken);
  expect(r.status).toBe(200);
  return (r.json.keys as Array<Record<string, unknown>>).find((k) => k.id === id)!;
}

function fakeReader(overrides: Partial<AuthorizationReader> = {}): AuthorizationReader {
  return {
    authorizationState: vi.fn(async () => false),
    findAuthorizationUsedTx: vi.fn(async () => null),
    ...overrides,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-reconcile-e2e-"));
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
  // No chainReader set yet — each test injects its own fake before calling
  // reconcile, so this suite never dials a real RPC endpoint (in particular
  // never the running dev testnet instances on :4020/:4021).
  ctx = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
});

afterAll(async () => {
  await app?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("v0.5: unknown-payment reconciliation over HTTP", () => {
  it("expired, never-used authorization -> POST /v1/admin/reconcile releases the buyer's quota", async () => {
    const key = await adminCreateKey({ daily_budget: "1", per_request_limit: "0.5" });

    // Load the freshly-created MoneyKey row straight from the DB core layer
    // (same DB the running server uses) to reserve+mark-unknown a payment
    // exactly like performPaidFetch would.
    const keyRow = getMoneyKeyById(db, key.id)!;

    const { paymentId } = evaluateAndReserve(db, keyRow, {
      url: `http://${SELLER_HOST}/premium-report`,
      host: SELLER_HOST,
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      payTo: "0x000000000000000000000000000000000000bb",
      amount: 10_000n, // 0.01 USDC in micro-USDC
    });
    markUnknown(db, paymentId, "NO_SETTLE_HEADER");
    const validBefore = Math.floor(Date.now() / 1000) - 3600; // already expired an hour ago
    recordPaymentAuthorization(db, paymentId, {
      from: "0x000000000000000000000000000000000000aa",
      nonce: "0x" + "22".repeat(32),
      validBefore,
    });

    const before = await getKeyView(key.id);
    expect(before.used_today).toBe("0.01");

    // Inject a fake reader confirming the authorization was never used
    // on-chain — no real RPC endpoint is ever contacted.
    ctx.chainReader = fakeReader({ authorizationState: vi.fn(async () => false) });

    const r = await call("POST", "/v1/admin/reconcile", adminToken);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.scanned).toBe(1);
    expect(r.json.failed).toBe(1);
    expect(r.json.reconciled_payment_ids).toEqual([paymentId]);

    const after = await getKeyView(key.id);
    expect(after.used_today).toBe("0");

    const usage = await call("GET", "/v1/admin/usage", adminToken);
    const row = (usage.json.payments as Array<Record<string, unknown>>).find((p) => p.id === paymentId);
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("NOT_SETTLED_EXPIRED");
  });

  it("expired authorization that WAS used on-chain -> settled with tx_hash, quota stays counted", async () => {
    const key = await adminCreateKey({ daily_budget: "1", per_request_limit: "0.5" });
    const keyRow = getMoneyKeyById(db, key.id)!;

    const { paymentId } = evaluateAndReserve(db, keyRow, {
      url: `http://${SELLER_HOST}/premium-report`,
      host: SELLER_HOST,
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      payTo: "0x000000000000000000000000000000000000bb",
      amount: 10_000n,
    });
    markUnknown(db, paymentId, "NO_SETTLE_HEADER");
    recordPaymentAuthorization(db, paymentId, {
      from: "0x000000000000000000000000000000000000aa",
      nonce: "0x" + "33".repeat(32),
      validBefore: Math.floor(Date.now() / 1000) - 3600,
    });

    ctx.chainReader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => "0xdeadbeefcafe"),
    });

    const r = await call("POST", "/v1/admin/reconcile", adminToken);
    expect(r.status).toBe(200);
    expect(r.json.settled_with_tx).toBe(1);

    const after = await getKeyView(key.id);
    // still counted (settled counts against quota too, unlike failed).
    expect(after.used_today).toBe("0.01");

    const usage = await call("GET", "/v1/admin/usage", adminToken);
    const row = (usage.json.payments as Array<Record<string, unknown>>).find((p) => p.id === paymentId);
    expect(row?.status).toBe("settled");
    expect(row?.tx_hash).toBe("0xdeadbeefcafe");
  });

  it("a row settled earlier WITHOUT a tx hash (SETTLED_TX_UNKNOWN) gets its hash when the lookup works later (POST /v1/admin/reconcile backfills on demand)", async () => {
    const key = await adminCreateKey({ daily_budget: "1", per_request_limit: "0.5" });
    const keyRow = getMoneyKeyById(db, key.id)!;
    const { paymentId } = evaluateAndReserve(db, keyRow, {
      url: `http://${SELLER_HOST}/premium-report`,
      host: SELLER_HOST,
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      payTo: "0x000000000000000000000000000000000000bb",
      amount: 10_000n,
    });
    markUnknown(db, paymentId, "TIMEOUT_AFTER_PAYMENT");
    recordPaymentAuthorization(db, paymentId, {
      from: "0x000000000000000000000000000000000000aa",
      nonce: "0x" + "44".repeat(32),
      validBefore: Math.floor(Date.now() / 1000) - 3600,
    });

    // first pass: the authorization was used, but the AuthorizationUsed lookup is rate limited
    ctx.chainReader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => {
        throw new Error("429 Too Many Requests");
      }),
    });
    const first = await call("POST", "/v1/admin/reconcile", adminToken);
    expect(first.status).toBe(200);
    expect(first.json.settled_tx_unknown).toBe(1);
    let usage = await call("GET", "/v1/admin/usage", adminToken);
    let row = (usage.json.payments as Array<Record<string, unknown>>).find((p) => p.id === paymentId);
    expect(row?.status).toBe("settled");
    expect(row?.tx_hash).toBeNull();
    expect(row?.error_code).toBe("SETTLED_TX_UNKNOWN");

    // later the lookup works: the same endpoint now backfills the hash
    ctx.chainReader = fakeReader({
      authorizationState: vi.fn(async () => true),
      findAuthorizationUsedTx: vi.fn(async () => "0x20b9a9edf1e2"),
    });
    const second = await call("POST", "/v1/admin/reconcile", adminToken);
    expect(second.status).toBe(200);
    expect(second.json.scanned).toBe(0);
    expect(second.json.tx_backfill_scanned).toBe(1);
    expect(second.json.tx_backfilled).toBe(1);
    usage = await call("GET", "/v1/admin/usage", adminToken);
    row = (usage.json.payments as Array<Record<string, unknown>>).find((p) => p.id === paymentId);
    expect(row?.status).toBe("settled");
    expect(row?.tx_hash).toBe("0x20b9a9edf1e2");
    expect(row?.error_code).toBeNull();

    // nothing left to do
    const third = await call("POST", "/v1/admin/reconcile", adminToken);
    expect(third.json.tx_backfill_scanned).toBe(0);
  });

  it("POST /v1/admin/reconcile requires admin auth", async () => {
    const r = await fetch(`${BASE}/v1/admin/reconcile`, { method: "POST" });
    expect(r.status).toBe(403);
  });
});
