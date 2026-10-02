import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { startMockFacilitator } from "@moneyswitch/mock-facilitator";
import { renderInstallPrompt, renderSkill, SKILL_BEGIN_MARKER, SKILL_END_MARKER } from "@moneyswitch/skill";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";

/**
 * The skill is only worth something if an agent can copy its examples and
 * they work. This boots a real HTTP server + demo seller + mock facilitator
 * (no chain, no real money), renders the PERSONALIZED skill for a freshly
 * created key, and runs the bash, PowerShell and Python examples exactly as
 * written (only the placeholder seller URL is swapped for the local one).
 * Interpreters that are not installed are skipped. It also walks the
 * approval flow the skill describes: approval_required -> poll
 * GET /v1/approvals/{id} -> approved -> resend with approval_id, including the
 * PowerShell 7 case (a body rebuilt in a NEW process must match the approved
 * one) and the "reset secret while a request is waiting for the seller" race.
 */

const SELLER_PORT = 19021;
const GATE_PORT = 19022;
const MOCK_FACILITATOR_PORT = 19099;
const SERVER_PORT = 19020;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const PAID_URL = `http://127.0.0.1:${SELLER_PORT}/premium-report`;
const EXAMPLE_URL = "https://api.example.com/paid-data";
const PAY_TO = EthersWallet.createRandom().address;

let tmpDir: string;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let mockFacilitator: Awaited<ReturnType<typeof startMockFacilitator>>;
let sellerProc: ChildProcess;

function has(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}
const BASH = has("bash", ["-c", "command -v curl"]);
const PYTHON = process.platform === "win32" ? has("python", ["--version"]) : has("python3", ["--version"]);
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";
const POWERSHELL = has("powershell", ["-NoProfile", "-Command", "exit 0"]) ? "powershell" : has("pwsh", ["-NoProfile", "-Command", "exit 0"]) ? "pwsh" : null;
// PowerShell 7 (.NET Core) randomizes hashtable key order per process; Windows PowerShell 5.1 does not.
const PWSH7 = has("pwsh", ["-NoProfile", "-Command", "exit 0"]) ? "pwsh" : null;

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
  await waitForHttp(`http://127.0.0.1:${SELLER_PORT}/free`);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-skill-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  const wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("e2e-test-password");
  await wallet.unlock("e2e-test-password");
  adminToken = bootstrapAdminToken(opened.db)!;
  const ctx: AppContext = {
    db: opened.db,
    sqlite: opened.sqlite as Database.Database,
    wallet,
    config: { port: SERVER_PORT, host: "127.0.0.1", dataDir: tmpDir, dbFilePath: ":memory:", walletPassword: null },
  };
  app = buildApp(ctx);
  await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
}, 40000);

afterAll(async () => {
  await app?.close();
  sellerProc?.kill();
  await mockFacilitator?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(method: string, url: string, token: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function newKey(name: string, over: Record<string, unknown> = {}) {
  const r = await api("POST", "/v1/keys", adminToken, {
    name,
    total_budget: "10",
    daily_budget: "5",
    per_request_limit: "1",
    allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
    ...over,
  });
  expect(r.status).toBe(200);
  return r.json as { id: string; key: string };
}

/** The first fenced block of a language in the rendered skill, with the placeholder seller URL swapped for the local demo seller. */
function codeBlock(skill: string, lang: string): string {
  const m = new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```").exec(skill);
  expect(m, `skill has a ${lang} block`).not.toBeNull();
  return m![1].split(EXAMPLE_URL).join(PAID_URL);
}

// Async on purpose: the server under test lives in THIS process, so a blocking spawnSync would starve it.
function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * A forwarding proxy in front of the demo seller that holds every request until `release()` is called. It stands in
 * for "a slow seller": MoneySwitch has authenticated the agent and is waiting for the seller's 402 when the admin acts.
 */
function startGate(upstreamPort: number, listenPort: number) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let arrived!: () => void;
  const firstRequest = new Promise<void>((r) => (arrived = r));
  const server = http.createServer(async (req, res) => {
    arrived();
    await released;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(k)) headers[k] = v;
      }
      const up = await fetch(`http://127.0.0.1:${upstreamPort}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      res.statusCode = up.status;
      up.headers.forEach((v, k) => {
        if (!["connection", "content-length", "transfer-encoding", "content-encoding"].includes(k)) res.setHeader(k, v);
      });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch {
      res.statusCode = 502;
      res.end();
    }
  });
  const listening = new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", () => r()));
  return {
    listening,
    firstRequest,
    release,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The skill's PowerShell block with its `$req = ...` line replaced by `reqBlock`, printing the reply as JSON. */
function powershellWithRequest(skill: string, reqBlock: string): string {
  const block = codeBlock(skill, "powershell");
  const swapped = block.replace(/^\$req = .*$/m, () => reqBlock);
  expect(swapped, "the skill's PowerShell block has a $req line to swap").not.toBe(block);
  return swapped.replace(/^Invoke-RestMethod/m, "$r = Invoke-RestMethod") + "\n$r | ConvertTo-Json -Depth 10\n";
}

describe("the examples in the personalized skill work as written", () => {
  it.skipIf(!BASH)("bash + curl", async () => {
    const k = await newKey("bash-agent");
    const skill = renderSkill({ baseUrl: BASE, key: k.key, keyName: "bash-agent" });
    const r = await run("bash", ["-c", codeBlock(skill, "bash")]);
    expect(r.code, r.out).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.status).toBe("ok");
    expect(body.payment.amount).toBe("0.01");
    expect(body.payment.tx_hash).toMatch(/^0xmock/);
  }, 60000);

  it.skipIf(!POWERSHELL)("Windows PowerShell (Invoke-RestMethod + ConvertTo-Json -Depth)", async () => {
    const k = await newKey("ps-agent");
    const skill = renderSkill({ baseUrl: BASE, key: k.key, keyName: "ps-agent" });
    const script = path.join(tmpDir, "example.ps1");
    // Same text as the skill, plus a final line to print the result as JSON so we can parse it here.
    fs.writeFileSync(script, codeBlock(skill, "powershell").replace(/^Invoke-RestMethod/m, "$r = Invoke-RestMethod") + "\n$r | ConvertTo-Json -Depth 10\n", "utf8");
    const r = await run(POWERSHELL!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]);
    expect(r.code, r.out).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.status).toBe("ok");
    expect(body.payment.amount).toBe("0.01");
  }, 90000);

  it.skipIf(!PYTHON)("Python standard library", async () => {
    const k = await newKey("py-agent");
    const skill = renderSkill({ baseUrl: BASE, key: k.key, keyName: "py-agent" });
    const r = await run(PYTHON_CMD, ["-c", codeBlock(skill, "python")]);
    expect(r.code, r.out).toBe(0);
    // the example prints: status, charged (absent on servers older than the charged field), code
    expect(r.out.trim().split(/\s+/)[0]).toBe("ok");
  }, 60000);

  it.skipIf(!PYTHON)("Python: a 401 still yields a JSON body the example can read", async () => {
    const skill = renderSkill({ baseUrl: BASE, key: "mk_live_" + "x".repeat(32) });
    const r = await run(PYTHON_CMD, ["-c", codeBlock(skill, "python")]);
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split(/\s+/)).toEqual(["error", "no", "KEY_INVALID"]);
  }, 60000);
});

describe("the flows the skill describes", () => {
  it("approval_required -> poll GET /v1/approvals/{id} -> approved -> resend the same request plus approval_id", async () => {
    const k = await newKey("approval-agent", { approval_threshold: "0.005" });
    const first = await api("POST", "/v1/fetch", k.key, { url: PAID_URL });
    expect(first.json.status).toBe("approval_required");
    const id = first.json.approval_id as string;
    expect(id).toBeTruthy();

    const pending = await api("GET", `/v1/approvals/${id}`, k.key);
    expect(pending.status).toBe(200);
    expect(pending.json).toMatchObject({ id, status: "pending", amount: "0.01", currency: "USDC", url: PAID_URL, method: "GET" });

    // another key cannot see it
    const other = await newKey("other-agent");
    expect((await api("GET", `/v1/approvals/${id}`, other.key)).status).toBe(404);

    expect((await api("POST", `/v1/approvals/${id}/approve`, adminToken)).status).toBe(200);
    expect((await api("GET", `/v1/approvals/${id}`, k.key)).json.status).toBe("approved");

    const again = await api("POST", "/v1/fetch", k.key, { url: PAID_URL, approval_id: id });
    expect(again.json.status).toBe("ok");
    expect(again.json.payment.amount).toBe("0.01");
    expect((await api("GET", `/v1/approvals/${id}`, k.key)).json.status).toBe("used");
  }, 30000);

  // The approval is tied to sha256(JSON.stringify(body)) in the key order that was sent. PowerShell 7 gives a plain
  // @{...} a different key order in every process, so the skill tells the agent to build objects with [ordered]@{...}.
  // Two separate pwsh processes (as when an agent resumes after the human approved) must therefore send the same body.
  it.skipIf(!PWSH7)("PowerShell 7: a nested [ordered] body approved by the human is accepted when a NEW process resends it", async () => {
    const k = await newKey("pwsh-approval", { approval_threshold: "0.005" });
    const skill = renderSkill({ baseUrl: BASE, key: k.key, keyName: "pwsh-approval" });
    const chatUrl = `http://127.0.0.1:${SELLER_PORT}/v1/chat/completions`;
    const reqBlock = (approvalId?: string) =>
      [
        "$req = [ordered]@{",
        `  url = "${chatUrl}"; method = "POST"`,
        '  headers = [ordered]@{ "content-type" = "application/json" }',
        '  body = [ordered]@{ model = "moneyswitch-demo-chat"; messages = @([ordered]@{ role = "user"; content = "hello" }); temperature = 0.2; max_tokens = 16; user = "e2e"; n = 1 }',
        "}",
        ...(approvalId ? [`$req.approval_id = "${approvalId}"`] : []),
      ].join("\n");
    const runOnce = async (name: string, approvalId?: string) => {
      const script = path.join(tmpDir, name);
      fs.writeFileSync(script, powershellWithRequest(skill, reqBlock(approvalId)), "utf8");
      const r = await run(PWSH7!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]);
      expect(r.code, r.out).toBe(0);
      return JSON.parse(r.out);
    };

    const first = await runOnce("pwsh-approval-1.ps1");
    expect(first.status).toBe("approval_required");
    const id = first.approval_id as string;
    expect(id).toBeTruthy();
    expect((await api("POST", `/v1/approvals/${id}/approve`, adminToken)).status).toBe(200);

    const second = await runOnce("pwsh-approval-2.ps1", id); // a brand-new pwsh process
    expect(second.status, JSON.stringify(second)).toBe("ok");
    expect(second.code).toBeNull();
    expect(second.payment.amount).toBe("0.01");
    expect((await api("GET", `/v1/approvals/${id}`, k.key)).json.status).toBe("used");
  }, 120000);

  // The old secret must stop working immediately - also for a request that authenticated with it just before the
  // reset and is still waiting for the seller's 402 (the seller can take up to 30 s). Revoke has always stopped that
  // request inside the policy transaction; a replaced secret needed the same.
  it("reset secret while a request is waiting for the seller: the old secret cannot pay, the new one can", async () => {
    const gate = startGate(SELLER_PORT, GATE_PORT);
    await gate.listening;
    try {
      const k = await newKey("rotate-inflight", { allowed_hosts: [`127.0.0.1:${GATE_PORT}`] });
      const viaGate = `http://127.0.0.1:${GATE_PORT}/premium-report`;

      // request authenticated with the OLD secret, now parked at the "slow seller"
      const inflight = api("POST", "/v1/fetch", k.key, { url: viaGate });
      await gate.firstRequest;

      const rotated = await api("POST", `/v1/keys/${k.id}/rotate`, adminToken);
      expect(rotated.status).toBe(200);
      gate.release(); // the seller finally answers 402 -> MoneySwitch is about to reserve + sign

      const res = (await inflight).json;
      expect(res.status, JSON.stringify(res)).toBe("error");
      expect(res.code).toBe("KEY_INVALID");
      expect(res.payment).toBeNull();

      // nothing was reserved, signed or settled for this key
      const history = await api("GET", "/v1/history", rotated.json.key as string);
      expect(history.json.history).toHaveLength(0);
      expect(Number((await api("GET", "/v1/status", rotated.json.key as string)).json.used_total)).toBe(0);

      // the new secret pays through the same seller
      const paid = await api("POST", "/v1/fetch", rotated.json.key as string, { url: viaGate });
      expect(paid.json.status, JSON.stringify(paid.json)).toBe("ok");
      expect(paid.json.payment.amount).toBe("0.01");
    } finally {
      gate.release();
      await gate.close();
    }
  }, 60000);

  it("a denied approval is visible to the polling agent as denied", async () => {
    const k = await newKey("deny-agent", { approval_threshold: "0.005" });
    const first = await api("POST", "/v1/fetch", k.key, { url: PAID_URL });
    const id = first.json.approval_id as string;
    await api("POST", `/v1/approvals/${id}/deny`, adminToken);
    expect((await api("GET", `/v1/approvals/${id}`, k.key)).json.status).toBe("denied");
  }, 30000);

  it("reset secret: the old key is dead, the new one pays, history stays, and the new install text carries it", async () => {
    const k = await newKey("rotate-agent");
    const paid = await api("POST", "/v1/fetch", k.key, { url: PAID_URL });
    expect(paid.json.status).toBe("ok");

    const rotated = await api("POST", `/v1/keys/${k.id}/rotate`, adminToken);
    expect(rotated.status).toBe(200);
    const newKeyValue = rotated.json.key as string;

    expect((await api("POST", "/v1/fetch", k.key, { url: PAID_URL })).json.code).toBe("KEY_INVALID");
    const history = await api("GET", "/v1/history", newKeyValue);
    expect(history.json.history).toHaveLength(1);
    expect(history.json.history[0].status).toBe("settled");
    const paidAgain = await api("POST", "/v1/fetch", newKeyValue, { url: PAID_URL });
    expect(paidAgain.json.status).toBe("ok");
    expect((await api("GET", "/v1/status", newKeyValue)).json.used_total).toBe("0.02");

    const prompt = renderInstallPrompt({ baseUrl: BASE, key: newKeyValue, keyName: "rotate-agent", agent: "codex" });
    const inner = prompt.slice(prompt.indexOf(SKILL_BEGIN_MARKER) + SKILL_BEGIN_MARKER.length, prompt.indexOf(SKILL_END_MARKER));
    expect(inner).toContain(newKeyValue);
    expect(inner).not.toContain(k.key);
  }, 30000);

  it("GET /skill.md over real HTTP is public, markdown, and has no key", async () => {
    const res = await fetch(`${BASE}/skill.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text).toContain(`\`${BASE}\``);
    expect(text).not.toMatch(/mk_live_[A-Za-z0-9]{8,}/);
  });
});
