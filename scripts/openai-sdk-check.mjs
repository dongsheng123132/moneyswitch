#!/usr/bin/env node
/**
 * Manual verification script for SPEC-v0.2 §2/§5: drives a throwaway,
 * fully-offline MoneySwitch instance (mock-facilitator + demo-seller in
 * ECHO mode, i.e. no DEMO_LLM_UPSTREAM_KEY) through the real `openai` Node
 * SDK, exercising: models.list(), chat.completions.create() non-streaming,
 * chat.completions.create() streaming, and the two OpenAI-style billing
 * endpoints. Prints raw request/response JSON to stdout.
 *
 * Uses high, repo-scoped-only ports (16020/16021/16099) and a throwaway
 * `.data/openai-sdk-check/` data dir — NEVER touches .data/testnet or the
 * live 4020/4021 instance.
 */
import path from "node:path";
import fs from "node:fs";
import { Wallet as EthersWallet } from "ethers";
import OpenAI from "openai";
import { REPO_ROOT, waitForHttp, spawnLogged, installShutdownHandlers } from "./lib/demo-common.mjs";

const DATA_DIR = path.join(REPO_ROOT, ".data", "openai-sdk-check");
const MOCK_FACILITATOR_PORT = 16099;
const SELLER_PORT = 16021;
const SERVER_PORT = 16020;
const WALLET_PASSWORD = "openai-sdk-check-password";

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const payTo = EthersWallet.createRandom().address;

async function main() {
  const children = [];

  console.log(`[check] starting mock-facilitator on :${MOCK_FACILITATOR_PORT}...`);
  const mockFacilitator = spawnLogged(
    "mock-facilitator",
    process.execPath,
    [path.join(REPO_ROOT, "packages", "mock-facilitator", "dist", "server.js")],
    { env: { ...process.env, MOCK_FACILITATOR_PORT: String(MOCK_FACILITATOR_PORT) }, cwd: REPO_ROOT },
    path.join(DATA_DIR, "mock-facilitator.log")
  );
  children.push(mockFacilitator);
  await waitForHttp(`http://127.0.0.1:${MOCK_FACILITATOR_PORT}/supported`);

  console.log(`[check] starting demo-seller (ECHO mode, no DEMO_LLM_UPSTREAM_KEY) on :${SELLER_PORT}...`);
  const demoSeller = spawnLogged(
    "demo-seller",
    process.execPath,
    [path.join(REPO_ROOT, "apps", "demo-seller", "dist", "index.js")],
    {
      env: {
        ...process.env,
        DEMO_SELLER_PORT: String(SELLER_PORT),
        DEMO_SELLER_PAY_TO: payTo,
        DEMO_SELLER_FACILITATOR_URL: `http://127.0.0.1:${MOCK_FACILITATOR_PORT}`,
        DEMO_LLM_UPSTREAM_KEY: "",
      },
      cwd: REPO_ROOT,
    },
    path.join(DATA_DIR, "demo-seller.log")
  );
  children.push(demoSeller);
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`);

  console.log(`[check] starting server on :${SERVER_PORT}...`);
  const serverLogPath = path.join(DATA_DIR, "server.log");
  const server = spawnLogged(
    "server",
    process.execPath,
    [path.join(REPO_ROOT, "apps", "server", "dist", "index.js")],
    {
      env: {
        ...process.env,
        MONEYSWITCH_PORT: String(SERVER_PORT),
        MONEYSWITCH_DATA_DIR: DATA_DIR,
        MONEYSWITCH_DB_PATH: path.join(DATA_DIR, "moneyswitch.sqlite"),
        MONEYSWITCH_WALLET_PASSWORD: WALLET_PASSWORD,
      },
      cwd: REPO_ROOT,
    },
    serverLogPath
  );
  children.push(server);
  installShutdownHandlers(children);

  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`);

  // The admin token is only ever printed once to the server's own stdout
  // (now captured in server.log). Wait briefly then grep it out.
  await new Promise((r) => setTimeout(r, 500));
  const serverLog = fs.readFileSync(serverLogPath, "utf-8");
  const tokenMatch = /(ms_admin_[A-Za-z0-9]+)/.exec(serverLog);
  if (!tokenMatch) throw new Error("could not find admin token in server.log");
  const adminToken = tokenMatch[1];
  console.log("[check] admin token acquired (not printed here; see .data/openai-sdk-check/server.log)");

  // Wallet needs an actual keystore to unlock. Create one, then let the
  // MONEYSWITCH_WALLET_PASSWORD env var pick it up on next... actually the
  // server already tried to unlock at boot and found no keystore. Create it
  // via the admin API now, which also unlocks it in-process for future runs.
  const createWalletRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/wallet/create`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password: WALLET_PASSWORD }),
  });
  console.log("[check] POST /v1/admin/wallet/create ->", createWalletRes.status, await createWalletRes.json());
  const unlockRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/wallet/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password: WALLET_PASSWORD }),
  });
  console.log("[check] POST /v1/admin/wallet/unlock ->", unlockRes.status, await unlockRes.json());

  console.log("\n[check] POST /v1/admin/channels (Demo LLM x402)");
  const channelRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/admin/channels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Demo LLM (x402)",
      base_url: `http://127.0.0.1:${SELLER_PORT}/v1`,
      models: ["moneyswitch-demo-chat"],
    }),
  });
  const channelBody = await channelRes.json();
  console.log(channelRes.status, JSON.stringify(channelBody, null, 2));

  console.log("\n[check] POST /v1/keys (MoneyKey for this run)");
  const keyRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "openai-sdk-check",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: [],
      allowed_models: ["moneyswitch-demo-chat"],
    }),
  });
  const keyBody = await keyRes.json();
  console.log(keyRes.status, JSON.stringify({ ...keyBody, key: "mk_live_[REDACTED-see-script-if-you-trust-this-shell]" }, null, 2));
  const moneyKey = keyBody.key;

  const client = new OpenAI({ baseURL: `http://127.0.0.1:${SERVER_PORT}/v1`, apiKey: moneyKey });

  console.log("\n[check] client.models.list()");
  const models = await client.models.list();
  console.log(JSON.stringify(models, null, 2));

  console.log("\n[check] client.chat.completions.create() non-streaming");
  const completion = await client.chat.completions.create({
    model: "moneyswitch-demo-chat",
    messages: [{ role: "user", content: "hello from openai-sdk-check.mjs" }],
  });
  console.log(JSON.stringify(completion, null, 2));

  console.log("\n[check] client.chat.completions.create() streaming");
  const stream = await client.chat.completions.create({
    model: "moneyswitch-demo-chat",
    messages: [{ role: "user", content: "hello streaming" }],
    stream: true,
  });
  let fullContent = "";
  for await (const chunk of stream) {
    console.log("chunk:", JSON.stringify(chunk));
    fullContent += chunk.choices?.[0]?.delta?.content ?? "";
  }
  console.log("assembled streamed content:", JSON.stringify(fullContent));

  console.log("\n[check] GET /v1/dashboard/billing/subscription");
  const sub = await client.get("/dashboard/billing/subscription");
  console.log(JSON.stringify(sub, null, 2));

  console.log("\n[check] GET /v1/dashboard/billing/usage");
  const usage = await client.get("/dashboard/billing/usage");
  console.log(JSON.stringify(usage, null, 2));

  console.log("\n[check] all calls completed. Shutting down child processes.");
  for (const child of children) child.kill();
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}

main().catch((e) => {
  console.error("[check] FAILED:", e);
  process.exit(1);
});
