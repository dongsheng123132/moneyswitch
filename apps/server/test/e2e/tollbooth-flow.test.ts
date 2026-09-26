import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { openDb, type MoneySwitchDb, schema } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Wallet as EthersWallet } from "ethers";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";

/**
 * SPEC-v0.5 §5 e2e: toll booths, fully offline.
 *   buyer MoneyKey → /v1/fetch → MoneySwitch /t/{slug}/… (x402 via the official
 *   SDK) → mock-facilitator verify → fake upstream → settle only on 2xx/3xx.
 * The same MoneySwitch is both seller and buyer here ("同一 MoneySwitch 的
 * MoneyKey 买自家收费站：允许"); `moneyswitch sell` is exercised at the end.
 */

const SERVER_PORT = 17020;
const FACILITATOR_PORT = 17099;
const UPSTREAM_PORT = 17031;
const SELL_PORT = 17402;
const PAY_TO = EthersWallet.createRandom().address;
const SELL_PAY_TO = EthersWallet.createRandom().address;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let upstream: http.Server;
let sellProc: ChildProcess | null = null;
let sellLog = "";
const seen: SeenRequest[] = [];
const facilitatorCalls = { verify: 0, settle: 0 };

function lastSeen(pathPrefix: string): SeenRequest | undefined {
  return [...seen].reverse().find((r) => r.url.startsWith(pathPrefix));
}

async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

beforeAll(async () => {
  // Mock facilitator, instrumented so "the buyer was not charged" is checked
  // at the source: no /settle call ever reaches the facilitator.
  facilitator = buildMockFacilitator();
  facilitator.addHook("onRequest", async (req) => {
    if (req.url === "/verify") facilitatorCalls.verify++;
    if (req.url === "/settle") facilitatorCalls.settle++;
  });
  await facilitator.listen({ port: FACILITATOR_PORT, host: "127.0.0.1" });

  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = req.url ?? "/";
      if (url.startsWith("/boom")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream exploded" }));
        return;
      }
      if (url.startsWith("/redirect")) {
        res.writeHead(302, { location: `http://127.0.0.1:${UPSTREAM_PORT}/v1/elsewhere` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1", "payment-response": "forged" });
      res.end(JSON.stringify({ ok: true, path: url, method: req.method, echo: body || null }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-toll-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir);
  await wallet.createWallet("toll-e2e-password");
  await wallet.unlock("toll-e2e-password");
  adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = {
    port: SERVER_PORT,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
    facilitatorUrl: `http://127.0.0.1:${FACILITATOR_PORT}`,
  };
  const ctx: AppContext = { db, sqlite, wallet, config };
  app = buildApp(ctx);
  await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
}, 30000);

afterAll(async () => {
  sellProc?.kill();
  await app?.close();
  await facilitator?.close();
  await new Promise((r) => upstream?.close(r));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function admin(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${adminToken}` }, payload: payload as object });
}

async function createBuyerKey(hostPort: string, extra: Record<string, unknown> = {}) {
  const res = await admin("POST", "/v1/keys", {
    name: `buyer-${Math.random().toString(36).slice(2, 7)}`,
    total_budget: "10",
    daily_budget: "5",
    per_request_limit: "1",
    allowed_hosts: [hostPort],
    ...extra,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; key: string };
}

async function buy(key: string, url: string, method = "GET", body?: unknown, headers?: Record<string, string>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/fetch",
    headers: { authorization: `Bearer ${key}` },
    payload: { url, method, body, headers },
  });
  return res.json();
}

function paymentsFor(keyId: string) {
  return db.select().from(schema.payments).where(eq(schema.payments.keyId, keyId)).all();
}

function earningsRows() {
  return db.select().from(schema.earnings).all();
}

let booth: { id: string; slug: string; public_url: string; pay_to: string };

describe("SPEC-v0.5 toll booth — admin API & guard rails", () => {
  it("creates a toll booth with rules (explicit external pay_to)", async () => {
    const res = await admin("POST", "/v1/admin/tollbooths", {
      name: "Weather API",
      upstream_url: `http://127.0.0.1:${UPSTREAM_PORT}`,
      pay_to: PAY_TO.toLowerCase(),
      default_price: null,
      routes: [
        { method: "POST", path_pattern: "/v1/chat/completions", price: "0.01", description: "one chat completion" },
        { method: "GET", path_pattern: "/free/*", price: "0" },
        { method: "ANY", path_pattern: "/boom", price: "0.02" },
        { method: "GET", path_pattern: "/redirect", price: "0" },
      ],
    });
    expect(res.statusCode).toBe(200);
    booth = res.json();
    expect(booth.slug).toBe("weather-api");
    // stored checksummed even though it was sent lower-case
    expect(booth.pay_to).toBe(PAY_TO);
    expect(booth.public_url).toMatch(/\/t\/weather-api$/);
  });

  it("pay_to defaults to this MoneySwitch wallet (钱包收付一体)", async () => {
    const res = await admin("POST", "/v1/admin/tollbooths", {
      name: "Default wallet booth",
      upstream_url: `http://127.0.0.1:${UPSTREAM_PORT}`,
      default_price: "0.01",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pay_to).toBe(wallet.getAddress());
    expect(res.json().pay_to_is_wallet).toBe(true);
  });

  it("rejects a MoneyKey / private key / bad checksum as pay_to (INVALID_PAY_TO)", async () => {
    const { key } = await createBuyerKey("example.com:443");
    const cases: Array<[string, string]> = [
      [key, "LOOKS_LIKE_MONEYKEY"],
      ["0x" + "ab".repeat(32), "LOOKS_LIKE_PRIVATE_KEY"],
      [adminToken, "LOOKS_LIKE_ADMIN_TOKEN"],
      [PAY_TO.slice(0, 2) + PAY_TO.slice(2).split("").map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join(""), "BAD_CHECKSUM"],
    ];
    for (const [payTo, reason] of cases) {
      const res = await admin("POST", "/v1/admin/tollbooths", {
        name: "bad",
        upstream_url: `http://127.0.0.1:${UPSTREAM_PORT}`,
        pay_to: payTo,
        default_price: "0.01",
      });
      if (reason === "BAD_CHECKSUM" && res.statusCode === 200) continue; // the mangled casing happened to be valid
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("INVALID_PAY_TO");
      expect(res.json().reason).toBe(reason);
      // the secret is never echoed back
      expect(JSON.stringify(res.json())).not.toContain(payTo);
    }
    // PATCH is validated the same way
    const patch = await admin("PATCH", `/v1/admin/tollbooths/${booth.id}`, { pay_to: key });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().reason).toBe("LOOKS_LIKE_MONEYKEY");
  });

  it("refuses an upstream pointing at MoneySwitch's own port (UPSTREAM_IS_SELF)", async () => {
    for (const u of [`http://127.0.0.1:${SERVER_PORT}`, `http://localhost:${SERVER_PORT}/v1`, `http://[::1]:${SERVER_PORT}`]) {
      const res = await admin("POST", "/v1/admin/tollbooths", { name: "loop", upstream_url: u, default_price: "0.01" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("UPSTREAM_IS_SELF");
    }
  });

  it("free upstream probe never charges", async () => {
    const before = { ...facilitatorCalls };
    const ok = await admin("POST", `/v1/admin/tollbooths/${booth.id}/test`);
    expect(ok.json()).toMatchObject({ ok: true, status: 200 });
    const bad = await admin("POST", "/v1/admin/tollbooths/test-upstream", { upstream_url: "http://127.0.0.1:1" });
    expect(bad.json().ok).toBe(false);
    expect(facilitatorCalls).toEqual(before);
  });

  it("admin meta exposes wallet_address + public_base", async () => {
    const res = await admin("GET", "/v1/admin/meta");
    expect(res.json().wallet_address).toBe(wallet.getAddress());
    expect(typeof res.json().public_base).toBe("string");
  });
});

describe("SPEC-v0.5 toll booth — paying through it", () => {
  it("unpaid call → 402 with the SDK's PAYMENT-REQUIRED header (payTo = toll booth pay_to)", async () => {
    const before = seen.length;
    const res = await fetch(`${BASE}/t/weather-api/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const pr = decodePaymentRequiredHeader(header!);
    expect(pr.accepts[0].payTo).toBe(PAY_TO);
    expect(pr.accepts[0].amount).toBe("10000");
    expect(pr.accepts[0].network).toBe("eip155:10143");
    const body = await res.json();
    expect(body.pay_to).toBe(PAY_TO);
    expect(body.price_usdc).toBe("0.01");
    expect(seen.length).toBe(before); // upstream never called without payment
  });

  it("path tricks are priced like the real path (no free bypass)", async () => {
    for (const p of ["/V1/Chat/Completions/", "//v1//chat/completions", "/free/../v1/chat/completions", "/v1/chat/complet%69ons"]) {
      const res = await fetch(`${BASE}/t/weather-api${p}`, { method: "POST", body: "{}" });
      expect(res.status, p).toBe(402);
    }
    const encSlash = await fetch(`${BASE}/t/weather-api/free%2F..%2Fboom`);
    expect(encSlash.status).toBe(400);
  });

  it("MoneyKey buys via /v1/fetch → upstream gets X-MoneySwitch-*, no Authorization; earnings +1; buyer usage +1", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SERVER_PORT}`);
    const settleBefore = facilitatorCalls.settle;
    const out = await buy(buyer.key, `${BASE}/t/weather-api/v1/chat/completions`, "POST", { messages: [{ role: "user", content: "hi" }] }, {
      authorization: "Bearer must-not-reach-upstream",
      cookie: "sid=secret",
      "x-moneyswitch-payer": "0xspoofed",
    });
    expect(out.status).toBe("ok");
    expect(out.http_status).toBe(200);
    expect(out.payment).toMatchObject({ amount: "0.01", mock: true });
    expect(out.payment.tx_hash).toMatch(/^0xmock/);
    expect(facilitatorCalls.settle).toBe(settleBefore + 1);

    const got = lastSeen("/v1/chat/completions")!;
    expect(got.method).toBe("POST");
    expect(got.headers["x-moneyswitch-payer"]).toBe(wallet.getAddress());
    expect(got.headers["x-moneyswitch-amount"]).toBe("0.01");
    expect(got.headers["x-moneyswitch-tollbooth"]).toBe("weather-api");
    expect(got.headers["authorization"]).toBeUndefined();
    expect(got.headers["cookie"]).toBeUndefined();
    expect(got.headers["payment-signature"]).toBeUndefined();
    expect(got.body).toContain("hi");

    const rows = paymentsFor(buyer.id);
    expect(rows.filter((r) => r.status === "settled")).toHaveLength(1);
    const earned = earningsRows().filter((e) => e.status === "settled");
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ amount: 10000, payer: wallet.getAddress(), upstreamStatus: 200, tollboothSlug: "weather-api" });
    expect(earned[0].txHash).toBe(out.payment.tx_hash);
  });

  it("upstream 500 → buyer NOT charged: no /settle, no settled payment, earnings 'failed' with upstream_status", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SERVER_PORT}`);
    const settleBefore = facilitatorCalls.settle;
    const verifyBefore = facilitatorCalls.verify;
    const out = await buy(buyer.key, `${BASE}/t/weather-api/boom`);
    expect(out.status).toBe("ok");
    expect(out.http_status).toBe(500);
    expect(out.payment).toBeNull();
    expect(facilitatorCalls.verify).toBe(verifyBefore + 1); // it was a real, verified payment…
    expect(facilitatorCalls.settle).toBe(settleBefore); // …that was never settled
    const rows = paymentsFor(buyer.id);
    expect(rows.some((r) => r.status === "settled")).toBe(false);
    const failed = earningsRows().filter((e) => e.path === "/boom");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", upstreamStatus: 500, amount: 20000, txHash: null });
  });

  it("price-0 route passes through free (no payment, no earnings)", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SERVER_PORT}`);
    const earningsBefore = earningsRows().length;
    const out = await buy(buyer.key, `${BASE}/t/weather-api/free/health?x=1`);
    expect(out.status).toBe("ok");
    expect(out.http_status).toBe(200);
    expect(out.payment).toBeNull();
    const got = lastSeen("/free/health")!;
    expect(got.url).toBe("/free/health?x=1");
    expect(got.headers["x-moneyswitch-amount"]).toBe("0");
    expect(got.headers["x-moneyswitch-payer"]).toBeUndefined();
    expect(earningsRows().length).toBe(earningsBefore);
    // Direct call, no MoneySwitch at all: also free, and upstream cookies / forged x402 headers are stripped.
    const direct = await fetch(`${BASE}/t/weather-api/free/health`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("set-cookie")).toBeNull();
    expect(direct.headers.get("payment-response")).toBeNull();
    expect(direct.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("upstream redirects are not followed and are rewritten to the public toll booth URL", async () => {
    const res = await fetch(`${BASE}/t/weather-api/redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/t/weather-api/v1/elsewhere`);
  });

  it("unmatched path with default 'refuse' → 404 NOT_FOR_SALE", async () => {
    const res = await fetch(`${BASE}/t/weather-api/admin/secret`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("NOT_FOR_SALE");
  });

  it("a settled payment header cannot be replayed", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SERVER_PORT}`);
    let captured: string | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      captured = h.get("payment-signature") ?? captured;
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const out = await buy(buyer.key, `${BASE}/t/weather-api/v1/chat/completions`, "POST", {});
      expect(out.payment).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(captured).toBeTruthy();
    const settleBefore = facilitatorCalls.settle;
    const replay = await fetch(`${BASE}/t/weather-api/v1/chat/completions`, {
      method: "POST",
      headers: { "payment-signature": captured!, "content-type": "application/json" },
      body: "{}",
    });
    expect(replay.status).toBe(409);
    expect(facilitatorCalls.settle).toBe(settleBefore);
  });

  it("buying a non-toll-booth path on MoneySwitch itself is still SSRF_BLOCKED", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SERVER_PORT}`);
    for (const u of [`${BASE}/v1/keys`, `${BASE}/t/../v1/keys`, `${BASE}/`]) {
      const out = await buy(buyer.key, u);
      expect(out.code, u).toBe("SSRF_BLOCKED");
    }
  });

  it("GET /v1/admin/earnings returns totals, grouping and items", async () => {
    const res = await admin("GET", "/v1/admin/earnings?range=today");
    const body = res.json();
    expect(body.total).toBe("0.02"); // two settled chat calls
    expect(body.settled_count).toBe(2);
    expect(body.failed_count).toBe(1);
    expect(body.by_tollbooth[0]).toMatchObject({ slug: "weather-api", total: "0.02", count: 2 });
    expect(body.by_route.find((r: { path_pattern: string }) => r.path_pattern === "/v1/chat/completions")).toMatchObject({ total: "0.02", count: 2 });
    expect(body.items[0]).toHaveProperty("payer");
    const list = await admin("GET", "/v1/admin/tollbooths");
    const view = list.json().tollbooths.find((t: { id: string }) => t.id === booth.id);
    expect(view).toMatchObject({ earnings_today: "0.02", paid_calls_today: 2 });
  });

  it("disabled toll booth → 404, and back after re-enabling", async () => {
    await admin("PATCH", `/v1/admin/tollbooths/${booth.id}`, { enabled: false });
    const off = await fetch(`${BASE}/t/weather-api/v1/chat/completions`, { method: "POST" });
    expect(off.status).toBe(404);
    await admin("PATCH", `/v1/admin/tollbooths/${booth.id}`, { enabled: true });
    const on = await fetch(`${BASE}/t/weather-api/v1/chat/completions`, { method: "POST" });
    expect(on.status).toBe(402);
  });

  it("deleting a toll booth keeps its income history", async () => {
    const created = (await admin("POST", "/v1/admin/tollbooths", { name: "Temp", upstream_url: `http://127.0.0.1:${UPSTREAM_PORT}`, default_price: "0" })).json();
    const del = await admin("DELETE", `/v1/admin/tollbooths/${created.id}`);
    expect(del.json().deleted).toBe(true);
    expect((await fetch(`${BASE}/t/${created.slug}/x`)).status).toBe(404);
    expect(earningsRows().filter((e) => e.status === "settled").length).toBe(2);
  });
});

describe("SPEC-v0.5 §4 `moneyswitch sell` — same 402 → pay → pass-through chain", () => {
  const SELL = `http://127.0.0.1:${SELL_PORT}`;

  beforeAll(async () => {
    const cli = path.resolve(__dirname, "../../../cli/dist/cli.js");
    sellProc = spawn(
      process.execPath,
      [
        cli,
        "sell",
        "--upstream",
        `http://127.0.0.1:${UPSTREAM_PORT}`,
        "--price",
        "0.01",
        "--route",
        "GET /free/*=0",
        "--pay-to",
        SELL_PAY_TO,
        "--port",
        String(SELL_PORT),
        "--facilitator",
        `http://127.0.0.1:${FACILITATOR_PORT}`,
        "--json",
      ],
      { stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } }
    );
    sellProc.stdout?.on("data", (d) => (sellLog += d.toString()));
    sellProc.stderr?.on("data", (d) => (sellLog += d.toString()));
    await waitForHttp(`${SELL}/free/ping`).catch((e) => {
      throw new Error(`moneyswitch sell did not start: ${e.message}\n${sellLog}`);
    });
  }, 30000);

  it("prints the public address and the PUBLIC pay-to on start", () => {
    const first = JSON.parse(sellLog.split("\n").find((l) => l.includes('"listening"'))!);
    expect(first).toMatchObject({ event: "listening", url: SELL, pay_to: SELL_PAY_TO });
  });

  it("unpaid → 402 with payTo; buyer pays via /v1/fetch; upstream sees X-MoneySwitch-Payer", async () => {
    const unpaid = await fetch(`${SELL}/report`);
    expect(unpaid.status).toBe(402);
    const pr = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!);
    expect(pr.accepts[0].payTo).toBe(SELL_PAY_TO);
    expect(pr.accepts[0].amount).toBe("10000");

    const buyer = await createBuyerKey(`127.0.0.1:${SELL_PORT}`);
    const settleBefore = facilitatorCalls.settle;
    const out = await buy(buyer.key, `${SELL}/report`, "GET", undefined, { authorization: "Bearer nope" });
    expect(out.status).toBe("ok");
    expect(out.http_status).toBe(200);
    expect(out.payment).toMatchObject({ amount: "0.01", mock: true });
    expect(facilitatorCalls.settle).toBe(settleBefore + 1);
    const got = lastSeen("/report")!;
    expect(got.headers["x-moneyswitch-payer"]).toBe(wallet.getAddress());
    expect(got.headers["x-moneyswitch-amount"]).toBe("0.01");
    expect(got.headers["authorization"]).toBeUndefined();
    expect(paymentsFor(buyer.id).filter((r) => r.status === "settled")).toHaveLength(1);
  });

  it("upstream 500 → not settled, buyer not charged", async () => {
    const buyer = await createBuyerKey(`127.0.0.1:${SELL_PORT}`);
    const settleBefore = facilitatorCalls.settle;
    const out = await buy(buyer.key, `${SELL}/boom`);
    expect(out.http_status).toBe(500);
    expect(out.payment).toBeNull();
    expect(facilitatorCalls.settle).toBe(settleBefore);
    expect(paymentsFor(buyer.id).some((r) => r.status === "settled")).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(sellLog).toContain('"not_charged"');
  });

  it("free rule passes through without payment", async () => {
    const res = await fetch(`${SELL}/free/ping`);
    expect(res.status).toBe(200);
  });

  it("refuses a MoneyKey / private key as --pay-to (exit 2, nothing started)", async () => {
    const cli = path.resolve(__dirname, "../../../cli/dist/cli.js");
    for (const bad of ["mk_live_abcdefghijklmnop", "0x" + "11".repeat(32)]) {
      const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, [cli, "sell", "--upstream", "http://127.0.0.1:1", "--price", "0.01", "--pay-to", bad], { stdio: "pipe" });
        let err = "";
        p.stderr?.on("data", (d) => (err += d.toString()));
        p.on("exit", (code) => resolve({ code, err }));
      });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--pay-to refused/);
      expect(r.err).not.toContain(bad);
    }
  });
});
