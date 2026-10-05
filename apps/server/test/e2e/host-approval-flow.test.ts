import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, createChildKey, getApproval, listAudit, listHistoryForKey, parseUsdcToMicros, usedTotal } from "@moneyswitch/core";
import { buildMockFacilitator } from "@moneyswitch/mock-facilitator";
import { Wallet as EthersWallet } from "ethers";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";
import { startStubSeller, type StubSeller } from "../stub-seller.js";

/**
 * SPEC.md §3: a host outside the key's allowed list asks a person before anything is sent to it; approving adds it to the key's list,
 * the AI resends the request as it was, and the price the seller then quotes is checked as always.
 *
 * The local stub seller lives on 127.0.0.1, a private address, which the SSRF rules only allow when the key lists it explicitly. So these
 * tests use a public-looking name that is NOT in the key's list, and the only thing replaced is the outbound fetch: a request for that name
 * is sent to the stub seller instead (the production code path, wallet, policy engine and facilitator are all real). Nothing is relaxed
 * in the SSRF guard.
 */

// DNS is replaced too: approving a new host looks its name up once, and "api.newhost.example" must resolve to a public address here
// without the test depending on the network. The calls are recorded: the payment path must not look anything up.
const dns = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (name: string) => {
    dns.calls.push(name);
    return [{ address: "93.184.216.34", family: 4 }];
  }),
}));

const FAKE_HOST = "api.newhost.example";
const ITEM_URL = `https://${FAKE_HOST}/item`;
const PAY_TO = EthersWallet.createRandom().address;
const realFetch = globalThis.fetch.bind(globalThis);

let tmpDir: string;
let db: MoneySwitchDb;
let sqlite: Database.Database;
let wallet: LocalWalletDriver;
let app: ReturnType<typeof buildApp>;
let adminToken: string;
let facilitator: ReturnType<typeof buildMockFacilitator>;
let seller: StubSeller;
/** Every URL the server tried to send to FAKE_HOST (they are redirected to the stub seller). */
let sentToFakeHost: string[] = [];

beforeAll(async () => {
  facilitator = buildMockFacilitator();
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const facilitatorPort = (facilitator.server.address() as { port: number }).port;
  seller = await startStubSeller({ facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`, payTo: PAY_TO });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-host-approval-e2e-"));
  const opened = openDb({ filePath: ":memory:" });
  db = opened.db;
  sqlite = opened.sqlite;
  wallet = new LocalWalletDriver(tmpDir, { protect: false });
  await wallet.createWithPhrase(); // auto-unlock, like every wallet the server creates
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
  seller.reset();
  sentToFakeHost = [];
  dns.calls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const u = new URL(href);
    if (u.hostname !== FAKE_HOST) return realFetch(input as RequestInfo, init); // the stub seller's own call to the facilitator
    sentToFakeHost.push(href);
    const target = `${seller.url}${u.pathname}${u.search}`;
    let res: Response;
    if (input instanceof Request) {
      const req = input;
      res = await realFetch(
        new Request(target, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body, duplex: "half", redirect: "manual" } as RequestInit),
        init
      );
    } else {
      res = await realFetch(target, init);
    }
    // The server refuses a response that comes from another host than the one it asked (a production check, left as it is): the stub
    // seller's answer has to look like it came from the name that was asked.
    Object.defineProperty(res, "url", { value: href });
    return res;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const admin = () => ({ authorization: `Bearer ${adminToken}` });
const keyIds = new Map<string, string>();

async function createKey(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: admin(),
    payload: {
      name: "e2e",
      total_budget: "10",
      daily_budget: "5",
      per_request_limit: "1",
      allowed_hosts: ["other.example:443"],
      ...over,
    },
  });
  expect(res.statusCode).toBe(200);
  keyIds.set(res.json().key, res.json().id);
  return res.json().key as string;
}

async function fetchVia(key: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/v1/fetch", headers: { authorization: `Bearer ${key}` }, payload: { url: ITEM_URL, ...extra } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const approve = (id: string) => app.inject({ method: "POST", url: `/v1/approvals/${id}/approve`, headers: admin() });
const deny = (id: string) => app.inject({ method: "POST", url: `/v1/approvals/${id}/deny`, headers: admin() });
const hostsOf = async (key: string) =>
  ((await app.inject({ method: "GET", url: "/v1/keys", headers: admin() })).json().keys as Array<{ id: string; allowed_hosts: string[] }>).find((k) => k.id === keyIds.get(key))!.allowed_hosts;
const payments = (key: string) => listHistoryForKey(db, keyIds.get(key)!, 50);
const paidRequests = () => seller.requests.filter((r) => r.paid);
// (every test makes its own keys, so what is counted is what its own requests made)
const approvalsOf = (key: string) => (sqlite.prepare("SELECT count(*) AS n FROM approvals WHERE key_id = ?").get(keyIds.get(key)) as { n: number }).n;

describe("a host outside the key's list: ask first, send nothing", () => {
  it("answers approval_required and the seller (and the name) never hears anything; no payment row, no budget used, no DNS look", async () => {
    const key = await createKey();
    const body = await fetchVia(key);
    expect(body).toMatchObject({ status: "approval_required", code: "APPROVAL_REQUIRED", charged: "no", payment: null });
    expect(body.approve_url).toContain(`/approvals?id=${body.approval_id}`);
    expect(seller.requests).toHaveLength(0);
    expect(sentToFakeHost).toHaveLength(0);
    expect(dns.calls).toHaveLength(0);
    expect(payments(key)).toHaveLength(0);
    expect(usedTotal(db, keyIds.get(key)!)).toBe(0n);
    expect(wallet.inFlight).toBe(0);
    expect(getApproval(db, body.approval_id)).toMatchObject({ kind: "host", status: "pending", amount: 0n });
  });

  it("asking again returns the same approval_id, and still nothing is sent", async () => {
    const key = await createKey();
    const first = await fetchVia(key);
    const again = await fetchVia(key);
    const other = await fetchVia(key, { url: `https://${FAKE_HOST}/another/item?x=1` });
    expect(again.approval_id).toBe(first.approval_id);
    expect(other.approval_id).toBe(first.approval_id);
    expect(approvalsOf(key)).toBe(1);
    expect(seller.requests).toHaveLength(0);
    expect(sentToFakeHost).toHaveLength(0);
  });

  it("the sixth different new host is RATE_LIMITED (charged no); the five before it are untouched", async () => {
    const key = await createKey();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await fetchVia(key, { url: `https://h${i}.example/x` })).approval_id);
    expect(new Set(ids).size).toBe(5);
    expect(await fetchVia(key, { url: "https://h5.example/x" })).toMatchObject({ status: "denied", code: "RATE_LIMITED", charged: "no", approval_id: null });
    expect(approvalsOf(key)).toBe(5);
    expect((await fetchVia(key, { url: "https://h0.example/again" })).approval_id).toBe(ids[0]);
    expect(seller.requests).toHaveLength(0);
  });

  it("ftp:// and a literal 100.100.100.200 are HOST_NOT_ALLOWED and ask nobody; so does a child key's request", async () => {
    const key = await createKey({ can_delegate: true });
    expect(await fetchVia(key, { url: `ftp://${FAKE_HOST}/item` })).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    expect(await fetchVia(key, { url: "http://100.100.100.200/latest/meta-data" })).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    const child = createChildKey(db, keyIds.get(key)!, { name: "child", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") }, { maxDepth: 3 });
    expect(await fetchVia(child.plaintextKey)).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    expect(approvalsOf(key)).toBe(0);
    expect((sqlite.prepare("SELECT count(*) AS n FROM approvals WHERE key_id = ?").get(child.row.id) as { n: number }).n).toBe(0);
    expect(seller.requests).toHaveLength(0);
    expect(sentToFakeHost).toHaveLength(0);
  });

  it("denied: the host stays unlisted, nothing is sent, and the same request asks again with a new approval", async () => {
    const key = await createKey();
    const first = await fetchVia(key);
    expect((await deny(first.approval_id)).statusCode).toBe(200);
    const again = await fetchVia(key);
    // (the first one is decided, so it no longer stands for the host: a new one is made, and it is the one a person now sees pending)
    expect(again).toMatchObject({ status: "approval_required", charged: "no" });
    expect(again.approval_id).not.toBe(first.approval_id);
    expect(getApproval(db, first.approval_id)!.status).toBe("denied");
    expect(getApproval(db, again.approval_id)!.status).toBe("pending");
    expect(await hostsOf(key)).toEqual(["other.example:443"]);
    expect(seller.requests).toHaveLength(0);
    expect(sentToFakeHost).toHaveLength(0);
  });
});

describe("approve: the host joins the key's list, the AI resends the same request", () => {
  it("the resend carries no approval_id, goes out, pays the seller's price; the next request needs no question", async () => {
    const key = await createKey();
    const first = await fetchVia(key);
    const res = await approve(first.approval_id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: first.approval_id, status: "approved" });
    expect(dns.calls).toEqual([FAKE_HOST]); // the one look, made at approval
    expect(await hostsOf(key)).toEqual(["other.example:443", `${FAKE_HOST}:443`]);
    expect(listAudit(db).filter((e) => e.action === "key.allow_host" && (e.detail as any).keyId === keyIds.get(key)).map((e) => e.detail)).toEqual([
      { keyId: keyIds.get(key), host: `${FAKE_HOST}:443`, approvalId: first.approval_id },
    ]);
    expect(seller.requests).toHaveLength(0); // approving sent nothing either

    const paid = await fetchVia(key); // as it was: no approval_id
    expect(paid).toMatchObject({ status: "ok", charged: "yes" });
    expect(paid.payment.amount).toBe("0.01");
    expect(paid.approval_id, "a host approval is not a payment approval").toBeNull();
    expect(paidRequests()).toHaveLength(1);
    expect(sentToFakeHost.length).toBeGreaterThan(0);
    expect(payments(key)).toHaveLength(1);
    expect(dns.calls, "the payment path looks nothing up").toEqual([FAKE_HOST]);

    const next = await fetchVia(key);
    expect(next).toMatchObject({ status: "ok", charged: "yes" });
    expect(paidRequests()).toHaveLength(2);
    expect(approvalsOf(key)).toBe(1);
  });

  it("a resend that still carries the host approval's id works the same: the id is ignored", async () => {
    const key = await createKey();
    const first = await fetchVia(key);
    expect((await approve(first.approval_id)).statusCode).toBe(200);
    const paid = await fetchVia(key, { approval_id: first.approval_id });
    expect(paid).toMatchObject({ status: "ok", charged: "yes" });
    expect(paid.approval_id).toBeNull();
    expect(paidRequests()).toHaveLength(1);
    expect(getApproval(db, first.approval_id)!.status).toBe("approved"); // not spent: nothing ever needs it again
  });

  it("the price is still checked: a quote over the per-request limit is denied after the host was approved, nothing is signed", async () => {
    seller.setBehavior({ amount: "2000000" }); // 2 USDC > per_request_limit 1
    const key = await createKey();
    const first = await fetchVia(key);
    expect((await approve(first.approval_id)).statusCode).toBe(200);
    const body = await fetchVia(key);
    expect(body).toMatchObject({ status: "denied", code: "PER_REQUEST_LIMIT_EXCEEDED", charged: "no" });
    expect(paidRequests()).toHaveLength(0);
    expect(payments(key)).toHaveLength(0);
  });

  it("a price over the approval line asks once more, with a payment approval of its own; that one is resent with its approval_id", async () => {
    const key = await createKey({ approval_threshold: "0.005" }); // the stub quotes 0.01
    const hostAsk = await fetchVia(key);
    expect((await approve(hostAsk.approval_id)).statusCode).toBe(200);

    const priceAsk = await fetchVia(key); // the resend, as it was
    expect(priceAsk.status).toBe("approval_required");
    expect(priceAsk.approval_id).not.toBe(hostAsk.approval_id);
    expect(paidRequests()).toHaveLength(0); // the seller was asked its price (the unpaid probe) and nothing more
    const poll = await app.inject({ method: "GET", url: `/v1/approvals/${priceAsk.approval_id}`, headers: { authorization: `Bearer ${key}` } });
    expect(poll.json()).toMatchObject({ kind: "payment", amount: "0.01" });

    expect((await approve(priceAsk.approval_id)).statusCode).toBe(200);
    expect(await hostsOf(key)).toEqual(["other.example:443", `${FAKE_HOST}:443`]); // approving a price lists nothing
    expect(dns.calls).toEqual([FAKE_HOST]); // ... and looks nothing up
    const paid = await fetchVia(key, { approval_id: priceAsk.approval_id });
    expect(paid).toMatchObject({ status: "ok", charged: "yes", approval_id: priceAsk.approval_id });
    expect(paidRequests()).toHaveLength(1);
    expect(getApproval(db, priceAsk.approval_id)!.status).toBe("used");
  });

  it("a resend over the approval line that still carries the host approval's id: the id is ignored, so it asks for the price (not APPROVAL_INVALID); that one is paid with its own id", async () => {
    const key = await createKey({ approval_threshold: "0.005" }); // the stub quotes 0.01
    const hostAsk = await fetchVia(key);
    expect((await approve(hostAsk.approval_id)).statusCode).toBe(200);

    // (the only place the id could matter: the policy looks at an approval_id only when the price is at or over the line)
    const priceAsk = await fetchVia(key, { approval_id: hostAsk.approval_id });
    expect(priceAsk).toMatchObject({ status: "approval_required", code: "APPROVAL_REQUIRED", charged: "no", payment: null });
    expect(priceAsk.code).not.toBe("APPROVAL_INVALID");
    expect(priceAsk.approval_id).not.toBe(hostAsk.approval_id);
    expect(paidRequests()).toHaveLength(0);
    expect(payments(key)).toHaveLength(0);
    expect(getApproval(db, hostAsk.approval_id)!.status).toBe("approved"); // not spent
    const poll = await app.inject({ method: "GET", url: `/v1/approvals/${priceAsk.approval_id}`, headers: { authorization: `Bearer ${key}` } });
    expect(poll.json()).toMatchObject({ kind: "payment", amount: "0.01", status: "pending" });

    expect((await approve(priceAsk.approval_id)).statusCode).toBe(200);
    const paid = await fetchVia(key, { approval_id: priceAsk.approval_id });
    expect(paid).toMatchObject({ status: "ok", charged: "yes", approval_id: priceAsk.approval_id });
    expect(paidRequests()).toHaveLength(1);
    expect(getApproval(db, priceAsk.approval_id)!.status).toBe("used");
  });

  it("another key's host approval id is not ignored: over the approval line the resend is APPROVAL_INVALID, nothing is signed or paid", async () => {
    const owner = await createKey({ approval_threshold: "0.005" }); // the stub quotes 0.01
    const hostAsk = await fetchVia(owner);
    expect((await approve(hostAsk.approval_id)).statusCode).toBe(200);
    const other = await createKey({ approval_threshold: "0.005", allowed_hosts: ["other.example:443", `${FAKE_HOST}:443`] });

    expect(await fetchVia(other, { approval_id: hostAsk.approval_id })).toMatchObject({ status: "denied", code: "APPROVAL_INVALID", charged: "no", payment: null });
    expect(paidRequests()).toHaveLength(0);
    expect(payments(other)).toHaveLength(0);
    expect(usedTotal(db, keyIds.get(other)!)).toBe(0n);
    expect(getApproval(db, hostAsk.approval_id)!.status).toBe("approved"); // the owner's, untouched
    // without that id the other key just asks for its own price approval
    expect(await fetchVia(other)).toMatchObject({ status: "approval_required", charged: "no" });
  });

  it("the old flow is unchanged for a host the key already lists: over the line, approve, resend with approval_id, paid once", async () => {
    const key = await createKey({ allowed_hosts: [`${FAKE_HOST}:443`], approval_threshold: "0.005" });
    const ask = await fetchVia(key);
    expect(ask.status).toBe("approval_required");
    expect(getApproval(db, ask.approval_id)).toMatchObject({ kind: "payment", status: "pending" });
    expect((await approve(ask.approval_id)).statusCode).toBe(200);
    expect(dns.calls).toHaveLength(0);
    const paid = await fetchVia(key, { approval_id: ask.approval_id });
    expect(paid).toMatchObject({ status: "ok", charged: "yes", approval_id: ask.approval_id });
    expect(getApproval(db, ask.approval_id)!.status).toBe("used");
    expect(paidRequests()).toHaveLength(1);
    expect(await fetchVia(key, { approval_id: ask.approval_id })).toMatchObject({ status: "denied", code: "APPROVAL_INVALID", charged: "no" });
    expect(paidRequests()).toHaveLength(1);
  });
});
