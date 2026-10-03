import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, schema, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startMockFacilitator } from "@moneyswitch/mock-facilitator";
import { spawn, type ChildProcess } from "node:child_process";
import { Wallet as EthersWallet } from "ethers";
import { eq } from "drizzle-orm";

/**
 * v0.4 (SPEC-v0.4 §C) offline end-to-end for child keys, over real HTTP:
 * MoneySwitch server (listening) -> demo-seller (402) -> x402 signing ->
 * mock-facilitator (real EIP-3009 signature verification) -> settle.
 */

const SELLER_PORT = 16021;
const MOCK_FACILITATOR_PORT = 16099;
const SERVER_PORT = 16020;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const SELLER = `http://127.0.0.1:${SELLER_PORT}`;
const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let mockFacilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
let sellerProc: ChildProcess;

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
    name: "employee",
    total_budget: "10",
    daily_budget: "1",
    per_request_limit: "1",
    allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
    max_payments_per_minute: 100,
    can_delegate: true,
    ...over,
  });
  expect(r.status).toBe(200);
  return r.json as { id: string; key: string; key_prefix?: string };
}

async function createChild(parentKey: string, over: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/keys/children", parentKey, {
    name: "agent",
    daily_budget: "1",
    total_budget: "10",
    per_request_limit: "1",
    ...over,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as { id: string; key: string; key_prefix: string };
}

function fetchVia(key: string, route: string, extra: Record<string, unknown> = {}) {
  return call("POST", "/v1/fetch", key, { url: `${SELLER}${route}`, ...extra });
}

async function adminKeys(): Promise<Record<string, any>> {
  const r = await call("GET", "/v1/keys", adminToken);
  return Object.fromEntries((r.json.keys as any[]).map((k) => [k.id, k]));
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
  await waitForHttp(`${SELLER}/free`).catch((e) => {
    throw new Error(`demo-seller did not start: ${e.message}\nlog:\n${sellerLog}`);
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-subkeys-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  const wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("subkeys-e2e-password");
  await wallet.unlock("subkeys-e2e-password");
  adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = {
    port: SERVER_PORT,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
    maxKeyDepth: 3,
  };
  const ctx: AppContext = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
}, 30000);

afterAll(async () => {
  await app?.close();
  sellerProc?.kill();
  await mockFacilitator?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("v0.4 child keys — end to end (SPEC-v0.4 §C)", () => {
  it("admin delegable root -> employee cuts child -> child pays -> parent/root usage up -> revoke root -> child KEY_REVOKED (ancestor)", async () => {
    const employee = await adminCreateKey({ name: "employee" });
    const agent = await createChild(employee.key, { name: "claude-code", daily_budget: "0.5", can_delegate: true });
    const sub = await createChild(agent.key, { name: "sub-agent", daily_budget: "0.2" });

    const paid = await fetchVia(sub.key, "/premium-report");
    expect(paid.status).toBe(200);
    expect(paid.json.status).toBe("ok");
    expect(paid.json.payment.amount).toBe("0.01");
    expect(paid.json.payment.mock).toBe(true);
    expect(paid.json.payment.tx_hash).toBeTruthy();
    expect(paid.json.remaining_today).toBe("0.19");

    const paid2 = await fetchVia(agent.key, "/premium-report");
    expect(paid2.json.status).toBe("ok");

    const keys = await adminKeys();
    expect(keys[sub.id].used_today).toBe("0.01");
    expect(keys[agent.id].used_today).toBe("0.02"); // own 0.01 + child 0.01
    expect(keys[agent.id].own_used_today).toBe("0.01");
    expect(keys[employee.id].used_today).toBe("0.02");
    expect(keys[employee.id].used_total).toBe("0.02");
    expect(keys[employee.id].own_used_today).toBe("0");

    const empStatus = await call("GET", "/v1/status", employee.key);
    expect(empStatus.json.remaining_today).toBe("0.98");

    const payRow = db.select().from(schema.payments).where(eq(schema.payments.keyId, sub.id)).all();
    expect(payRow.length).toBe(1);
    expect(payRow[0].status).toBe("settled");

    // Revoke the root (admin) -> every descendant is dead immediately.
    expect((await call("POST", `/v1/keys/${employee.id}/revoke`, adminToken)).status).toBe(200);
    for (const k of [agent, sub]) {
      const denied = await fetchVia(k.key, "/premium-report");
      expect(denied.status).toBe(401);
      expect(denied.json.code).toBe("KEY_REVOKED");
      expect(denied.json.limit_scope).toBe("ancestor");
      expect(denied.json.limit_key_prefix).toBe(keys[employee.id].key_prefix);
    }
    const after = db.select().from(schema.payments).all().filter((p) => [agent.id, sub.id].includes(p.keyId));
    expect(after.length).toBe(2); // no new reservation after revoke
    const tree = await call("GET", "/v1/admin/keys/tree", adminToken);
    const node = tree.json.tree.find((n: any) => n.id === employee.id);
    expect(node.status).toBe("revoked");
    expect(node.children[0].status).toBe("ancestor_revoked");
    expect(node.children[0].children[0].status).toBe("ancestor_revoked");
  });

  it("ancestor daily budget binds a child during a real payment: DAILY_BUDGET_EXCEEDED, limit_scope=ancestor, no reservation", async () => {
    const root = await adminCreateKey({ daily_budget: "0.02" });
    const a = await createChild(root.key, { daily_budget: "0.02" });
    const b = await createChild(root.key, { daily_budget: "0.02" });
    expect((await fetchVia(a.key, "/premium-report")).json.status).toBe("ok");
    expect((await fetchVia(a.key, "/premium-report")).json.status).toBe("ok");
    const rowsBefore = db.select().from(schema.payments).all().length;
    const denied = await fetchVia(b.key, "/premium-report");
    expect(denied.json.status).toBe("denied");
    expect(denied.json.code).toBe("DAILY_BUDGET_EXCEEDED");
    expect(denied.json.limit_scope).toBe("ancestor");
    expect(denied.json.remaining_today).toBe("0");
    expect(db.select().from(schema.payments).where(eq(schema.payments.keyId, b.id)).all().length).toBe(0);
    // The policy hook runs before the SDK signs: a denial leaves no payment row at all.
    expect(db.select().from(schema.payments).all().length).toBe(rowsBefore);
    // own-limit denial reports scope self
    const c = await adminCreateKey({ daily_budget: "1" });
    const small = await createChild(c.key, { daily_budget: "0.005" });
    const selfDenied = await fetchVia(small.key, "/premium-report");
    expect(selfDenied.json).toMatchObject({ code: "DAILY_BUDGET_EXCEEDED", limit_scope: "self", limit_key_prefix: small.key_prefix });
  });

  it("ancestor approval_threshold forces approval for a child; admin approves; retry pays", async () => {
    const root = await adminCreateKey({ approval_threshold: "0.10" });
    const child = await createChild(root.key); // no own threshold
    const first = await fetchVia(child.key, "/deep-report");
    expect(first.json.status).toBe("approval_required");
    const approvalId = first.json.approval_id;
    const pending = await call("GET", "/v1/approvals?status=pending", adminToken);
    expect(pending.json.approvals.find((a: any) => a.id === approvalId).key_id).toBe(child.id);
    expect((await call("POST", `/v1/approvals/${approvalId}/approve`, adminToken)).status).toBe(200);
    const retry = await fetchVia(child.key, "/deep-report", { approval_id: approvalId });
    expect(retry.json.status).toBe("ok");
    expect(retry.json.payment.amount).toBe("0.15");
  });

  it("concurrency over HTTP: parent daily=1.00, two children daily=1.00, 5 x 0.15 each at once -> exactly 6 paid tree-wide", async () => {
    const root = await adminCreateKey({ daily_budget: "1.00", per_request_limit: "1" });
    const a = await createChild(root.key, { daily_budget: "1.00" });
    const b = await createChild(root.key, { daily_budget: "1.00" });
    const results = await Promise.all(
      [a, b].flatMap((k) => Array.from({ length: 5 }, () => fetchVia(k.key, "/deep-report")))
    );
    const statuses = results.map((r) => r.json.code ?? r.json.status);
    expect(statuses.filter((s) => s === "ok").length).toBe(6);
    expect(statuses.filter((s) => s === "DAILY_BUDGET_EXCEEDED").length).toBe(4);
    const keys = await adminKeys();
    expect(keys[root.id].used_today).toBe("0.9");
    const rows = db
      .select()
      .from(schema.payments)
      .all()
      .filter((p) => [a.id, b.id].includes(p.keyId));
    expect(rows.length).toBe(6);
    expect(rows.every((p) => p.status === "settled")).toBe(true);
  });

});
