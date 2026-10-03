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

describe("a payment in flight keeps the wallet from being replaced - for a bounded time", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  afterEach(() => {
    wallet.drainTimeoutMs = 60_000;
  });

  it("replace gives up with 409 WALLET_BUSY after the bound while a paid fetch is still in flight; the fetch completes untouched, and afterwards replace works", async () => {
    wallet.drainTimeoutMs = 300;
    seller.setBehavior({ paidDelayMs: 1500 }); // the money is in (settled), the answer takes a while
    const key = await createKey();
    const address = wallet.getAddress()!;
    const keystoreBefore = fs.readFileSync(walletFilePath(tmpDir), "utf-8");
    const filesBefore = fs.readdirSync(tmpDir).sort();

    const inFlight = fetchVia(key, { url: URL_ITEM() });
    await waitFor(() => seller.requests.some((r) => r.paid), "the paid request to reach the seller");
    expect(wallet.inFlight).toBe(1);

    const started = Date.now();
    const busy = await adminPost("/v1/admin/wallet/replace", { confirm_address: address });
    expect(Date.now() - started, "it waited for the bound before giving up").toBeGreaterThanOrEqual(250);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("WALLET_BUSY");
    expect(fs.readFileSync(walletFilePath(tmpDir), "utf-8")).toBe(keystoreBefore);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(filesBefore);
    expect(wallet.getAddress()).toBe(address);
    expect(wallet.isUnlocked()).toBe(true);

    const { body } = await inFlight;
    expect(body).toMatchObject({ status: "ok", charged: "yes" });
    expect(wallet.inFlight).toBe(0);

    const replaced = await adminPost("/v1/admin/wallet/replace", { confirm_address: address, reason: "lost_password" });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().address).not.toBe(address);
    expect(wallet.getAddress()).toBe(replaced.json().address);
  });

  it("with time to spare, replace WAITS for the fetch in flight and then goes through; a payment that starts meanwhile is refused (WALLET_BUSY, charged no, nothing signed)", async () => {
    wallet.drainTimeoutMs = 20_000;
    seller.setBehavior({ paidDelayMs: 1500 });
    const key = await createKey();
    const address = wallet.getAddress()!;

    const first = fetchVia(key, { url: URL_ITEM() });
    await waitFor(() => seller.requests.some((r) => r.paid), "the first paid request to reach the seller");
    let replaceAnswered = false;
    const replacing = adminPost("/v1/admin/wallet/replace", { confirm_address: address }).then((r) => {
      replaceAnswered = true;
      return r;
    });
    await sleep(250);
    expect(replaceAnswered, "the replace is waiting, not refusing").toBe(false);

    // a second payment during the wait: its probe is answered, but no lease is handed out for the payment
    const second = await fetchVia(key, { url: URL_ITEM() });
    expect(second.body).toMatchObject({ status: "error", code: "WALLET_BUSY", charged: "no" });
    expect(seller.requests.filter((r) => r.paid), "only the first payment ever reached the seller").toHaveLength(1);
    expect(await payments(key), "nothing was reserved for the refused one").toHaveLength(1);
    expect(usedTotal(db, keyIds.get(key)!)).toBe(10_000n);

    expect((await first).body).toMatchObject({ status: "ok", charged: "yes" });
    const replaced = await replacing;
    expect(replaced.statusCode).toBe(200);
    const newAddress = replaced.json().address as string;
    expect(newAddress).not.toBe(address);

    // afterwards payments work again, signed by the NEW wallet
    const third = await fetchVia(key, { url: URL_ITEM() });
    expect(third.body).toMatchObject({ status: "ok", charged: "yes" });
    const rows = await payments(key);
    expect(rows.map((r) => r.authFrom)).toContain(newAddress);
    expect(wallet.inFlight).toBe(0);
  });

  it("free requests and 402 probes do NOT hold the wallet: a replace is not held up by them (the lease is taken when a payment is about to be created)", async () => {
    const key = await createKey();
    const address = wallet.getAddress()!;

    // a free resource: no payment, so no lease at all
    seller.setBehavior({ free: true });
    const lease = vi.spyOn(wallet, "leaseSigner");
    const free = await fetchVia(key, { url: URL_ITEM() });
    expect(free.body).toMatchObject({ status: "ok", charged: "no" });
    expect(lease).not.toHaveBeenCalled();
    lease.mockRestore();

    // a request stuck in its unpaid probe for a long time: it holds nothing
    seller.reset();
    seller.setBehavior({ probeDelayMs: 2500 });
    let probeDone = false;
    const slow = fetchVia(key, { url: URL_ITEM() }).then((r) => {
      probeDone = true;
      return r;
    });
    await waitFor(() => seller.requests.length >= 1, "the probe to reach the seller");
    expect(wallet.inFlight, "a request that is only probing holds no lease").toBe(0);
    const started = Date.now();
    const replaced = await adminPost("/v1/admin/wallet/replace", { confirm_address: address });
    expect(replaced.statusCode).toBe(200);
    expect(Date.now() - started, "no waiting for the probe").toBeLessThan(2000);
    expect(probeDone, "the probe is still pending when the replace returns").toBe(false);

    // when its 402 finally arrives it pays with the wallet that is live NOW
    const result = await slow;
    expect(result.body).toMatchObject({ status: "ok", charged: "yes" });
    const row = (await payments(key)).find((r) => r.status === "settled")!;
    expect(row.authFrom).toBe(replaced.json().address);
  });

  it("the lease is given back whatever happens to the request: policy refusal after it was taken, an unusable max_price, an upstream that never answers", async () => {
    const poor = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "poor", total_budget: "0.001", daily_budget: "0.001", per_request_limit: "1", allowed_hosts: [`127.0.0.1:${seller.port}`] },
    });
    keyIds.set(poor.json().key, poor.json().id);
    const lease = vi.spyOn(wallet, "leaseSigner");
    const denied = await fetchVia(poor.json().key, { url: URL_ITEM() });
    expect(denied.body).toMatchObject({ status: "denied", charged: "no" });
    expect(lease, "the lease WAS taken (a payment was about to be created) ...").toHaveBeenCalled();
    expect(wallet.inFlight, "... and given back when the policy refused it").toBe(0);
    lease.mockRestore();

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
    const staleLease = wallet.leaseSigner()!;
    const stale = staleLease.signer;
    staleLease.release(); // given back at once: the replace below is allowed, and the signer outlives its wallet
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

