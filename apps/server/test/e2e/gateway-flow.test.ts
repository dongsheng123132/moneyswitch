import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startMockFacilitator } from "@moneyswitch/mock-facilitator";
import { spawn, type ChildProcess } from "node:child_process";
import { Wallet as EthersWallet } from "ethers";
import OpenAI from "openai";

/**
 * SPEC-v0.2 §5: OpenAI-compatible gateway e2e, fully offline (echo-mode
 * demo-seller + mock-facilitator), driven by the real `openai` Node SDK
 * against a real listening MoneySwitch server (app.listen, not app.inject —
 * the SDK does real HTTP fetch).
 */

const SELLER_PORT = 15021;
const MOCK_FACILITATOR_PORT = 15099;
const SERVER_PORT = 15020;
const PAY_TO = EthersWallet.createRandom().address;
const DEMO_MODEL = "moneyswitch-demo-chat";

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
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

async function createChannel(models: string[] = [DEMO_MODEL]) {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/channels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Demo LLM (x402)",
      base_url: `http://127.0.0.1:${SELLER_PORT}/v1`,
      models,
    }),
  });
  return res.json();
}

async function createKey(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "gateway-e2e",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: [],
      ...overrides,
    }),
  });
  return res.json();
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
      // Echo mode: DEMO_LLM_UPSTREAM_KEY intentionally NOT set.
      DEMO_LLM_UPSTREAM_KEY: "",
    },
    stdio: "pipe",
  });
  let sellerLog = "";
  sellerProc.stdout?.on("data", (d) => (sellerLog += d.toString()));
  sellerProc.stderr?.on("data", (d) => (sellerLog += d.toString()));
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`).catch((e) => {
    throw new Error(`demo-seller did not start: ${e.message}\nlog:\n${sellerLog}`);
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-gateway-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("gateway-e2e-password");
  await wallet.unlock("gateway-e2e-password");
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
  await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
}, 30000);

afterAll(async () => {
  await app?.close();
  sellerProc?.kill();
  await mockFacilitator?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("OpenAI-compatible gateway (SPEC-v0.2 §2, §5)", () => {
  it("GET /v1/models lists only allowed models", async () => {
    await createChannel();
    const created = await createKey({ allowed_models: [DEMO_MODEL] });
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });
    const models = await client.models.list();
    expect(models.data.map((m) => m.id)).toContain(DEMO_MODEL);
  });

  it("models.list() excludes a model not in allowed_models", async () => {
    await createChannel();
    const created = await createKey({ allowed_models: ["some-other-model"] });
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });
    const models = await client.models.list();
    expect(models.data.map((m) => m.id)).not.toContain(DEMO_MODEL);
  });

  it("chat.completions.create (non-streaming) pays 0.01, returns moneyswitch fields, records kind=chat", async () => {
    await createChannel();
    const created = await createKey();
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });

    const completion = await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: "user", content: "hello moneyswitch" }],
    });

    expect(completion.choices[0].message.content).toContain("hello moneyswitch");
    const ms = (completion as unknown as { moneyswitch: Record<string, unknown> }).moneyswitch;
    expect(ms.cost).toBe("0.01");
    expect(ms.currency).toBe("USDC");
    expect(String(ms.tx_hash)).toMatch(/^0xmock/);

    const usageRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const usageBody = await usageRes.json();
    const row = usageBody.payments.find((p: any) => p.key_id === created.id);
    expect(row.kind).toBe("chat");
    expect(row.model).toBe(DEMO_MODEL);
    expect(row.status).toBe("settled");
  });

  it("chat.completions.create with stream:true iterates full content via SSE", async () => {
    await createChannel();
    const created = await createKey();
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });

    const stream = await client.chat.completions.create({
      model: DEMO_MODEL,
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    });

    let full = "";
    let sawFinish = false;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) full += delta;
      if (chunk.choices[0]?.finish_reason === "stop") sawFinish = true;
    }
    expect(full).toContain("stream please");
    expect(sawFinish).toBe(true);
  });

  it("model not in allowed_models -> 403 model_not_allowed", async () => {
    await createChannel();
    const created = await createKey({ allowed_models: ["other-model"] });
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });
    await expect(
      client.chat.completions.create({ model: DEMO_MODEL, messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("unknown model -> 404 model_not_found", async () => {
    const created = await createKey();
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });
    await expect(
      client.chat.completions.create({ model: "does-not-exist", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("insufficient daily budget -> 402 DAILY_BUDGET_EXCEEDED, no payment recorded", async () => {
    await createChannel();
    const created = await createKey({ daily_budget: "0.005", per_request_limit: "1" });
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });

    let caught: any;
    try {
      await client.chat.completions.create({ model: DEMO_MODEL, messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(402);
    expect(caught.error?.error?.code ?? caught.error?.code).toBe("DAILY_BUDGET_EXCEEDED");

    const usageRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const usageBody = await usageRes.json();
    const rows = usageBody.payments.filter((p: any) => p.key_id === created.id);
    expect(rows.length).toBe(0);
  });

  it("billing subscription/usage endpoints return correct numeric values", async () => {
    const created = await createKey({ total_budget: "10", daily_budget: "5" });
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: created.key });

    const sub = await client.get("/dashboard/billing/subscription");
    expect((sub as any).hard_limit_usd).toBe(10);
    expect((sub as any).soft_limit_usd).toBe(10);

    await createChannel();
    await client.chat.completions.create({ model: DEMO_MODEL, messages: [{ role: "user", content: "billing check" }] });

    const usage = await client.get("/dashboard/billing/usage");
    expect((usage as any).total_usage).toBe(1); // 0.01 USDC == 1 cent
  });
});

describe("GET /v1/admin/channels/probe-models (SPEC-v0.2 addendum: Dashboard 'pull models' proxy)", () => {
  it("returns the model ids served by an upstream's /models endpoint", async () => {
    const res = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/v1/admin/channels/probe-models?base_url=${encodeURIComponent(`http://127.0.0.1:${SELLER_PORT}/v1`)}`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([DEMO_MODEL]);
  });

  it("refuses to probe MoneySwitch's own port, even though it is 127.0.0.1", async () => {
    const res = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/v1/admin/channels/probe-models?base_url=${encodeURIComponent(`http://127.0.0.1:${SERVER_PORT}/v1`)}`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toBe("PROBE_FAILED");
  });

  it("returns PROBE_FAILED when the upstream host does not exist", async () => {
    const res = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/v1/admin/channels/probe-models?base_url=${encodeURIComponent("http://127.0.0.1:1/v1")}`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.error).toBe("PROBE_FAILED");
    expect(typeof body.message).toBe("string");
  });

  it("MoneyKey (not admin token) is rejected with 403", async () => {
    const created = await createKey();
    const res = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/v1/admin/channels/probe-models?base_url=${encodeURIComponent(`http://127.0.0.1:${SELLER_PORT}/v1`)}`,
      { headers: { authorization: `Bearer ${created.key}` } }
    );
    expect(res.status).toBe(403);
  });
});
