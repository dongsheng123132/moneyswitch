import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver, walletFilePath } from "@moneyswitch/wallet";
import { bootstrapAdminToken, listHistoryForKey, usedTotal } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * M5: a payment in flight and the wallet. Fully offline (stub seller + mock facilitator with real EIP-3009 signature
 * verification), the production payment path:
 *  - while a request holds the signer (a lease taken before the first byte goes out, given back in a `finally`),
 *    replace answers 409 WALLET_BUSY and touches nothing;
 *  - a signer that outlived its wallet (replaced after it was taken) refuses to sign: charged "no", the reservation is
 *    released, and the seller never sees a payment.
 */

const PAY_TO = EthersWallet.createRandom().address;
const FAST = { scrypt: { N: 2 ** 10, r: 8, p: 1 }, protect: false } as const;

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

beforeAll(async () => {
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorPort = (facilitator.server.address() as { port: number }).port;
  seller = await startStubSeller({ facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`, payTo: PAY_TO });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-inflight-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir, FAST);
  await wallet.createWithPhrase(); // auto-unlock, the default
  adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = { port: 0, host: "127.0.0.1", dataDir: tmpDir, dbFilePath: ":memory:", walletPassword: null };
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
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const keyIds = new Map<string, string>();

async function createKey() {
  const res = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: "e2e", total_budget: "10", daily_budget: "5", per_request_limit: "1", allowed_hosts: [`127.0.0.1:${seller.port}`] },
  });
  expect(res.statusCode).toBe(200);
  keyIds.set(res.json().key, res.json().id);
  return res.json().key as string;
}

const fetchVia = async (key: string, payload: Record<string, unknown>) => {
  const res = await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload });
  return { res, body: res.json() };
};
const adminPost = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${adminToken}` }, payload: payload as object });
const payments = (key: string) => listHistoryForKey(db, keyIds.get(key)!, 50);
const URL_ITEM = () => `${seller.url}/item`;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("a payment in flight keeps the wallet from being replaced", () => {
  it("replace is refused with 409 WALLET_BUSY while a paid fetch is in flight, the fetch completes untouched, and afterwards replace works", async () => {
    seller.setBehavior({ paidDelayMs: 1500 }); // the money is in (settled), the answer takes a while
    const key = await createKey();
    const address = wallet.getAddress()!;
    const keystoreBefore = fs.readFileSync(walletFilePath(tmpDir), "utf-8");
    const filesBefore = fs.readdirSync(tmpDir).sort();

    const inFlight = fetchVia(key, { url: URL_ITEM() });
    await waitFor(() => seller.requests.some((r) => r.paid), "the paid request to reach the seller");
    expect(wallet.inFlight).toBe(1);

    const busy = await adminPost("/v1/admin/wallet/replace", { confirm_address: address });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("WALLET_BUSY");
    expect(fs.readFileSync(walletFilePath(tmpDir), "utf-8")).toBe(keystoreBefore);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(filesBefore);
    expect(wallet.getAddress()).toBe(address);
    expect(() => wallet.lock()).toThrow(/in flight/);
    expect(wallet.isUnlocked()).toBe(true);

    const { body } = await inFlight;
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    expect(wallet.inFlight).toBe(0);

    const replaced = await adminPost("/v1/admin/wallet/replace", { confirm_address: address, reason: "lost_password" });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().address).not.toBe(address);
    expect(wallet.getAddress()).toBe(replaced.json().address);
  });

  it("the lease is given back whatever happens to the request: policy refusal, an unusable max_price, an upstream that never answers", async () => {
    const key = await createKey();
    expect((await fetchVia(key, { url: `http://127.0.0.1:${seller.port + 1}/nope` })).body.status).toBe("denied"); // host not allowed
    expect(wallet.inFlight).toBe(0);
    await fetchVia(key, { url: URL_ITEM(), max_price: "not-a-number" });
    expect(wallet.inFlight).toBe(0);

    process.env.MONEYSWITCH_PROBE_TIMEOUT_MS = "300";
    seller.setBehavior({ probeDelayMs: Infinity });
    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body).toMatchObject({ status: "error", charged: "no" });
    expect(wallet.inFlight).toBe(0);
  });
});

describe("a signer that outlived its wallet refuses to sign", () => {
  it("charged no, the reservation is released, the seller never sees a payment, and the next request signs with the new wallet", async () => {
    const key = await createKey();
    const stale = wallet.getSigner()!;
    const oldAddress = wallet.getAddress()!;
    // no lease is open here, so the replace is allowed: this is the "guard bypassed" situation the epoch check exists for
    const replaced = await adminPost("/v1/admin/wallet/replace", { confirm_address: oldAddress });
    expect(replaced.statusCode).toBe(200);
    vi.spyOn(wallet, "leaseSigner").mockReturnValue({ signer: stale, release: () => undefined });

    const { body } = await fetchVia(key, { url: URL_ITEM() });
    expect(body).toMatchObject({ status: "error", code: "WALLET_LOCKED", charged: "no" });
    const rows = await payments(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", errorCode: "WALLET_CHANGED" });
    expect(seller.requests.filter((r) => r.paid)).toHaveLength(0);
    expect(usedTotal(db, keyIds.get(key)!)).toBe(0n); // the budget is free again

    vi.restoreAllMocks();
    const again = await fetchVia(key, { url: URL_ITEM() });
    expect(again.body).toMatchObject({ status: "ok", charged: "yes" });
    expect(seller.requests.filter((r) => r.paid)).toHaveLength(1);
  });
});

describe("the OpenAI-compatible gateway holds the lease too", () => {
  const chat = (key: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: "stub-model", messages: [{ role: "user", content: "hi" }] },
    });

  it("replace is refused while a chat completion is in flight; a signer that outlived its wallet answers 503 WALLET_LOCKED with nothing paid", async () => {
    const channel = await app.inject({
      method: "POST",
      url: "/v1/admin/channels",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "stub (x402)", base_url: `${seller.url}/v1`, models: ["stub-model"] },
    });
    expect(channel.statusCode).toBeLessThan(300);
    const key = await createKey();

    // 1. in flight: the lease is held until the paid answer is back
    seller.setBehavior({ paidDelayMs: 1500 });
    const inFlight = chat(key);
    await waitFor(() => seller.requests.some((r) => r.paid), "the paid chat request to reach the seller");
    expect(wallet.inFlight).toBe(1);
    const busy = await adminPost("/v1/admin/wallet/replace", { confirm_address: wallet.getAddress() });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("WALLET_BUSY");
    expect((await inFlight).statusCode).toBe(200);
    expect(wallet.inFlight).toBe(0);

    // 2. a stale signer (replaced after it was taken) refuses to sign: 503, nothing paid, reservation released
    seller.reset();
    const stale = wallet.getSigner()!;
    expect((await adminPost("/v1/admin/wallet/replace", { confirm_address: wallet.getAddress() })).statusCode).toBe(200);
    vi.spyOn(wallet, "leaseSigner").mockReturnValue({ signer: stale, release: () => undefined });
    const refused = await chat(key);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("WALLET_LOCKED");
    expect(seller.requests.filter((r) => r.paid)).toHaveLength(0);
    const rows = (await payments(key)).filter((p) => p.errorCode === "WALLET_CHANGED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", kind: "chat" });
    expect(wallet.inFlight).toBe(0);
  });
});
