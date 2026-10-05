import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { TESTNET } from "@moneyswitch/x402";
import { createApproval, createChildKey, createHostApproval, getApproval, listAudit, parseUsdcToMicros } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/**
 * SPEC.md §3: an http(s) host outside a root key's allowed list asks a person before anything is sent to it, and approving adds it to
 * the key's list. These tests never reach a seller: the global fetch is replaced by one that records the call and fails, so "nothing
 * was sent" is checked, not assumed. (The paid round trip is in test/e2e/host-approval-flow.test.ts.)
 */

// DNS is replaced: a name resolves to a public address unless a test says otherwise (no test here depends on the network), and the
// calls are recorded, because the payment path must not look anything up.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>(), failing: new Set<string>(), calls: [] as string[], hang: false }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (name: string) => {
    dns.calls.push(name);
    if (dns.hang) return new Promise(() => {});
    if (dns.failing.has(name)) throw Object.assign(new Error("getaddrinfo ENOTFOUND " + name), { code: "ENOTFOUND" });
    return (dns.answers.get(name) ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));

let t: TestCtx;

afterEach(async () => {
  dns.answers.clear();
  dns.failing.clear();
  dns.calls.length = 0;
  dns.hang = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (t) await cleanupTestApp(t);
});

const asAdmin = () => ({ authorization: `Bearer ${t.adminToken}` });
const asKey = (key: string) => ({ authorization: `Bearer ${key}` });

function noNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("no network in this test");
  });
}

/**
 * A seller that answers every unpaid request with a 402 quoting `amount` (atomic USDC): enough for a request to get past the host list,
 * the wallet gate and the approval_id handling to the price check. Nothing is ever paid with it (every price it quotes is over a line).
 */
function sellerQuoting(amount: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const required = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: href, description: "stub seller", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: TESTNET.caip2,
          amount,
          asset: TESTNET.usdcAddress,
          payTo: "0x000000000000000000000000000000000000dead",
          maxTimeoutSeconds: 60,
          extra: { name: TESTNET.usdcDomainName, version: TESTNET.usdcDomainVersion },
        },
      ],
    };
    const res = new Response(JSON.stringify(required), {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) },
    });
    Object.defineProperty(res, "url", { value: href }); // (the server refuses an answer that comes from another url than the one it asked)
    return res;
  });
}

/** What os.networkInterfaces() answers: this machine has exactly these addresses. */
const machineHas = (...addresses: string[]) =>
  vi.spyOn(os, "networkInterfaces").mockReturnValue({
    eth0: addresses.map((address) => ({ address, netmask: "255.255.255.0", family: address.includes(":") ? "IPv6" : "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null })),
  } as never);

async function createKey(over: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: asAdmin(),
    payload: {
      name: "agent",
      total_budget: "5",
      daily_budget: "2",
      per_request_limit: "1",
      allowed_hosts: ["known.example:443"],
      can_delegate: true,
      ...over,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; key: string; allowed_hosts: string[] };
}

async function fetchVia(key: string, payload: Record<string, unknown>) {
  const res = await t.app.inject({ method: "POST", url: "/v1/fetch", headers: asKey(key), payload });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const approve = (id: string, payload?: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: `/v1/approvals/${id}/approve`, headers: asAdmin(), ...(payload ? { payload } : {}) });
const deny = (id: string) => t.app.inject({ method: "POST", url: `/v1/approvals/${id}/deny`, headers: asAdmin() });
const keyHosts = async (id: string) =>
  ((await t.app.inject({ method: "GET", url: "/v1/keys", headers: asAdmin() })).json().keys as Array<{ id: string; allowed_hosts: string[] }>).find((k) => k.id === id)!
    .allowed_hosts;
const adminApprovals = async () => (await t.app.inject({ method: "GET", url: "/v1/approvals", headers: asAdmin() })).json().approvals as Array<Record<string, any>>;
const allowHostAudit = () => listAudit(t.ctx.db).filter((e) => e.action === "key.allow_host");

const NEW_URL = "https://api.newhost.example/v1/data?x=1";

describe("/v1/fetch to a host outside the key's allowed list", () => {
  it("returns approval_required in the usual envelope and sends nothing; the approval is a pending 'host' approval bound to the request", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey();
    const body = await fetchVia(k.key, { url: NEW_URL, method: "POST", body: { q: 1 } });
    expect(body).toMatchObject({ status: "approval_required", code: "APPROVAL_REQUIRED", charged: "no", http_status: null, payment: null });
    expect(body.approve_url).toBe(`http://127.0.0.1:4020/approvals?id=${body.approval_id}`);
    expect(Object.keys(body).sort()).toEqual(
      ["approval_id", "approve_url", "body", "charged", "code", "headers", "http_status", "payment", "remaining_today", "remaining_total", "status"].sort()
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dns.calls, "no DNS look on the payment path").toEqual([]);

    const row = getApproval(t.ctx.db, body.approval_id)!;
    expect(row).toMatchObject({ keyId: k.id, url: NEW_URL, method: "POST", kind: "host", status: "pending", network: "", asset: "", payTo: "", amount: 0n });
    expect(new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()).toBe(10 * 60 * 1000);
    // no payment of any kind was started, and the key's list is untouched
    expect(t.ctx.sqlite.prepare("SELECT count(*) AS n FROM payments").get()).toEqual({ n: 0 });
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
  });

  it("an empty list stops even a free request the same way", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey({ allowed_hosts: [] });
    expect(await fetchVia(k.key, { url: "https://example.com/free" })).toMatchObject({ status: "approval_required", charged: "no", http_status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asking again for the same host:port returns the same approval_id, whatever the path, case or method", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    expect((await fetchVia(k.key, { url: NEW_URL })).approval_id).toBe(first.approval_id);
    expect((await fetchVia(k.key, { url: "https://API.NewHost.example/other/path" })).approval_id).toBe(first.approval_id);
    expect((await fetchVia(k.key, { url: "https://api.newhost.example:443/x", method: "POST", body: { q: 1 } })).approval_id).toBe(first.approval_id);
    // a trailing dot is the same host
    expect((await fetchVia(k.key, { url: "https://api.newhost.example./x" })).approval_id).toBe(first.approval_id);
    expect((await fetchVia(k.key, { url: "https://API.NewHost.example.:443/x" })).approval_id).toBe(first.approval_id);
    expect(await adminApprovals()).toHaveLength(1);
    // another port is another host
    const other = await fetchVia(k.key, { url: "https://api.newhost.example:8443/x" });
    expect(other.status).toBe("approval_required");
    expect(other.approval_id).not.toBe(first.approval_id);
    // another key is another approval
    const second = await createKey({ name: "second" });
    expect((await fetchVia(second.key, { url: NEW_URL })).approval_id).not.toBe(first.approval_id);
    expect(await adminApprovals()).toHaveLength(3);
  });

  it("a key with 5 new hosts waiting gets RATE_LIMITED for a 6th, charged no, and nothing is created; a host already waiting still answers", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const body = await fetchVia(k.key, { url: `https://h${i}.example/x` });
      expect(body.status).toBe("approval_required");
      ids.push(body.approval_id);
    }
    const sixth = await fetchVia(k.key, { url: "https://h5.example/x" });
    expect(sixth).toMatchObject({ status: "denied", code: "RATE_LIMITED", charged: "no", approval_id: null, limit_scope: "self", limit_key_prefix: k.key.slice(0, 12) });
    expect(await adminApprovals()).toHaveLength(5);
    expect((await fetchVia(k.key, { url: "https://h2.example/other" })).approval_id).toBe(ids[2]);
    // a place frees up when one is decided
    expect((await deny(ids[0])).statusCode).toBe(200);
    expect((await fetchVia(k.key, { url: "https://h5.example/x" })).status).toBe("approval_required");
    // the limit is the key's, not the server's
    const other = await createKey({ name: "other" });
    expect((await fetchVia(other.key, { url: "https://h6.example/x" })).status).toBe("approval_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the key sees kind 'host' (amount 0) when it polls; the admin list carries kind too; a payment approval says 'payment'", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const body = await fetchVia(k.key, { url: NEW_URL });
    const poll = await t.app.inject({ method: "GET", url: `/v1/approvals/${body.approval_id}`, headers: asKey(k.key) });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({ id: body.approval_id, status: "pending", kind: "host", amount: "0", currency: "USDC", url: NEW_URL, method: "GET", host: "api.newhost.example:443" });

    const pay = createApproval(t.ctx.db, {
      keyId: k.id,
      url: "https://known.example/paid",
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0xasset",
      payTo: "0xpay",
      amount: parseUsdcToMicros("0.15"),
    });
    const list = await adminApprovals();
    expect(list.find((a) => a.id === body.approval_id)).toMatchObject({ kind: "host", status: "pending", url: NEW_URL, host: "api.newhost.example:443" });
    expect(list.find((a) => a.id === pay.id)).toMatchObject({ kind: "payment", amount: "0.15" });
    // a payment approval has no host field, in the list or for the key that polls it
    expect(list.find((a) => a.id === pay.id)).not.toHaveProperty("host");
    const payPoll = await t.app.inject({ method: "GET", url: `/v1/approvals/${pay.id}`, headers: asKey(k.key) });
    expect(payPoll.json()).toMatchObject({ kind: "payment" });
    expect(payPoll.json()).not.toHaveProperty("host");
  });

  it("the host in the admin list and in the key's poll is the host:port that approving lists, worked out once on the server: IDN, upper case and a trailing dot included", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const url = "https://BÜCHER.Example.:8443/Path?x=1";
    const asked = await fetchVia(k.key, { url });
    expect(asked.status).toBe("approval_required");
    const listed = (await adminApprovals()).find((a) => a.id === asked.approval_id)!;
    const poll = (await t.app.inject({ method: "GET", url: `/v1/approvals/${asked.approval_id}`, headers: asKey(k.key) })).json();
    expect(listed.host).toBe("xn--bcher-kva.example:8443"); // punycode, lower case, no trailing dot
    expect(poll.host).toBe(listed.host);
    expect(listed.url).toBe(url); // the url itself stays as it was asked

    expect((await approve(asked.approval_id)).statusCode).toBe(200);
    // what the page showed is what was listed, and what was audited, and what was looked up (without the dot)
    expect(await keyHosts(k.id)).toEqual(["known.example:443", listed.host]);
    expect(allowHostAudit().map((e) => e.detail)).toEqual([{ keyId: k.id, host: listed.host, approvalId: asked.approval_id }]);
    expect(dns.calls).toEqual(["xn--bcher-kva.example"]);
    // the host is then allowed however it is spelled (the locked wallet is the next thing that stops each of these)
    for (const u of ["https://xn--bcher-kva.example:8443/x", "https://BÜCHER.Example.:8443/y", "https://xn--bcher-kva.example.:8443/z"]) {
      expect(await fetchVia(k.key, { url: u }), u).toMatchObject({ status: "error", code: "WALLET_LOCKED", charged: "no" });
    }
    // the decided approval still says it
    expect((await adminApprovals()).find((a) => a.id === asked.approval_id)).toMatchObject({ status: "approved", host: listed.host });
  });

  it("every non-http(s) URL is HOST_NOT_ALLOWED and creates no approval", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey();
    for (const url of ["ftp://api.newhost.example/x", "file:///etc/passwd", "gopher://api.newhost.example/", "ftp://known.example/x"]) {
      const body = await fetchVia(k.key, { url });
      expect(body, url).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    }
    expect(await adminApprovals()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a literal address that is not public unicast is HOST_NOT_ALLOWED and creates no approval", async () => {
    t = await buildTestApp({ port: 4020 });
    const fetchSpy = noNetwork();
    const k = await createKey();
    for (const url of [
      "http://100.100.100.200/latest/meta-data",
      "http://127.0.0.1:4021/free",
      "http://127.0.0.1:4020/v1/status",
      "http://10.1.2.3/x",
      "http://169.254.169.254/latest/meta-data",
      "http://172.16.0.1/x",
      "http://192.168.1.1/x",
      "http://198.18.0.1/x",
      "http://192.0.2.1/x",
      "http://224.0.0.1/x",
      "http://255.255.255.255/x",
      "http://0.0.0.0/x",
      "http://2130706433/x", // the URL parser turns this into 127.0.0.1
      "http://[::1]:4021/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "http://[ff02::1]/x",
      "http://[2001:db8::1]/x",
      "http://[::ffff:10.0.0.1]/x",
      "http://[64:ff9b::a00:1]/x",
      "http://[2002:0a00:0001::]/x",
      "http://[::ffff:0:a00:1]/x", // SIIT: the IPv4 inside is 10.0.0.1
      "http://[100::1]/x",
      "http://[2001::1]/x", // Teredo
      "http://[3fff::1]/x",
      "http://[64:ff9b:1::808:808]/x", // local-use NAT64: refused whole
      "http://localhost:4021/free",
      "http://svc.localhost:8080/x",
    ]) {
      const body = await fetchVia(k.key, { url });
      expect(body, url).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    }
    expect(await adminApprovals()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dns.calls).toEqual([]);
  });

  it("a non-public literal address that the key lists explicitly is unchanged: it passes the host check", async () => {
    t = await buildTestApp({ port: 4020 });
    noNetwork();
    const k = await createKey({ allowed_hosts: ["100.100.100.200:80", "127.0.0.1:4021"] });
    // past the host list and the SSRF guard: the (locked) wallet is the next thing that stops it
    expect(await fetchVia(k.key, { url: "http://100.100.100.200/x" })).toMatchObject({ status: "error", code: "WALLET_LOCKED", charged: "no" });
    expect(await fetchVia(k.key, { url: "http://127.0.0.1:4021/x" })).toMatchObject({ status: "error", code: "WALLET_LOCKED", charged: "no" });
    // listed own address on the server's own port: still the SSRF guard
    const own = await createKey({ name: "own", allowed_hosts: ["127.0.0.1:4020"] });
    expect(await fetchVia(own.key, { url: "http://127.0.0.1:4020/v1/status" })).toMatchObject({ status: "denied", code: "SSRF_BLOCKED", charged: "no" });
    expect(await adminApprovals()).toHaveLength(0);
  });

  it("a child key gets HOST_NOT_ALLOWED and no approval", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const parent = await createKey();
    const child = createChildKey(
      t.ctx.db,
      parent.id,
      { name: "child", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") },
      { maxDepth: 3 }
    );
    expect(await fetchVia(child.plaintextKey, { url: NEW_URL })).toMatchObject({ status: "denied", code: "HOST_NOT_ALLOWED", charged: "no", approval_id: null });
    expect(await adminApprovals()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an approval_id that is not a non-empty string names no approval: the request just asks (again), nothing sent", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    for (const approval_id of [5, "", {}, [], false, "no-such-approval"]) {
      const body = await fetchVia(k.key, { url: NEW_URL, approval_id });
      expect(body, JSON.stringify(approval_id)).toMatchObject({ status: "approval_required", charged: "no", approval_id: first.approval_id });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an approval that has expired no longer stands for its host: the next request makes a new one", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    t.ctx.sqlite.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), first.approval_id);
    const second = await fetchVia(k.key, { url: NEW_URL });
    expect(second.status).toBe("approval_required");
    expect(second.approval_id).not.toBe(first.approval_id);
  });

  // The two tests below really reach the approval_id handling: that happens only after the wallet gate, and the policy engine looks at an
  // approval_id only when the seller's price is at or over the approval line. So the wallet is unlocked and the seller quotes 0.01 USDC
  // to a key whose approval line is 0.005.
  it("once the host is listed, an approval_id that names THIS key's own host approval is ignored: the price asks for its own approval, not APPROVAL_INVALID", async () => {
    t = await buildTestApp({ unlockWallet: true });
    const seller = sellerQuoting("10000");
    const k = await createKey({ approval_threshold: "0.005" });
    const first = await fetchVia(k.key, { url: NEW_URL });
    expect((await approve(first.approval_id)).statusCode).toBe(200);
    expect(seller).not.toHaveBeenCalled();

    const seen = new Set<string>([first.approval_id]);
    for (const payload of [
      { url: NEW_URL, approval_id: first.approval_id },
      { url: "https://api.newhost.example/another/path", method: "POST", body: { q: 1 }, approval_id: first.approval_id }, // whatever request it was made for
    ]) {
      const body = await fetchVia(k.key, payload);
      expect(body, JSON.stringify(payload)).toMatchObject({ status: "approval_required", code: "APPROVAL_REQUIRED", charged: "no", payment: null });
      expect(seen.has(body.approval_id), "a payment approval of its own").toBe(false);
      seen.add(body.approval_id);
      expect(getApproval(t.ctx.db, body.approval_id)).toMatchObject({ kind: "payment", keyId: k.id, status: "pending", amount: 10000n });
    }
    expect(seller).toHaveBeenCalled(); // (the seller was asked its price; nothing was paid)
    expect(getApproval(t.ctx.db, first.approval_id)!.status).toBe("approved"); // not spent
    expect(t.ctx.sqlite.prepare("SELECT count(*) AS n FROM payments").get()).toEqual({ n: 0 });
  });

  it("an approval_id that names ANOTHER key's host approval is not ignored: over the line it is APPROVAL_INVALID (charged no, nothing asked)", async () => {
    t = await buildTestApp({ unlockWallet: true });
    sellerQuoting("10000");
    const k = await createKey({ approval_threshold: "0.005" });
    const other = await createKey({ name: "other", approval_threshold: "0.005", allowed_hosts: ["known.example:443", "api.newhost.example:443"] });
    const approved = await fetchVia(k.key, { url: NEW_URL });
    expect((await approve(approved.approval_id)).statusCode).toBe(200);
    const pending = await fetchVia((await createKey({ name: "third" })).key, { url: "https://elsewhere.example/x" });
    expect(getApproval(t.ctx.db, pending.approval_id)).toMatchObject({ kind: "host", status: "pending" });
    const before = await adminApprovals();

    for (const approval_id of [approved.approval_id, pending.approval_id]) {
      // `other` lists the host already, so the request gets as far as the price; an id that is not its own host approval is judged as any other id
      expect(await fetchVia(other.key, { url: NEW_URL, approval_id }), approval_id).toMatchObject({ status: "denied", code: "APPROVAL_INVALID", charged: "no", approval_id: null });
    }
    expect(await adminApprovals()).toHaveLength(before.length); // no approval was made for it
    expect(getApproval(t.ctx.db, approved.approval_id)!.status).toBe("approved");
    expect(getApproval(t.ctx.db, pending.approval_id)!.status).toBe("pending");
  });

  it("denying a host approval leaves the host unlisted: the same request makes a new approval", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    expect((await deny(first.approval_id)).json()).toEqual({ id: first.approval_id, status: "denied" });
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    const again = await fetchVia(k.key, { url: NEW_URL });
    expect(again).toMatchObject({ status: "approval_required", charged: "no" });
    expect(again.approval_id).not.toBe(first.approval_id);
    expect(getApproval(t.ctx.db, again.approval_id)).toMatchObject({ kind: "host", status: "pending" });
    expect(allowHostAudit()).toHaveLength(0);
  });
});

describe("POST /v1/approvals/:id/approve for a new host", () => {
  it("looks the host up once, approves, and adds host:port to the root key's list in the same step; audit rows written; nothing sent", async () => {
    t = await buildTestApp();
    const fetchSpy = noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: "https://API.NewHost.example:8443/v1/data" });
    expect(dns.calls).toEqual([]);
    const res = await approve(first.approval_id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: first.approval_id, status: "approved" });
    expect(dns.calls).toEqual(["api.newhost.example"]);
    expect(await keyHosts(k.id)).toEqual(["known.example:443", "api.newhost.example:8443"]);
    expect(getApproval(t.ctx.db, first.approval_id)!.status).toBe("approved");
    const audit = listAudit(t.ctx.db);
    expect(audit.filter((e) => e.action === "key.allow_host").map((e) => [e.actor, e.detail])).toEqual([
      ["admin", { keyId: k.id, host: "api.newhost.example:8443", approvalId: first.approval_id }],
    ]);
    expect(audit.filter((e) => e.action === "approval.approve").map((e) => e.detail)).toEqual([{ approvalId: first.approval_id }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // the poll now says approved
    const poll = await t.app.inject({ method: "GET", url: `/v1/approvals/${first.approval_id}`, headers: asKey(k.key) });
    expect(poll.json()).toMatchObject({ status: "approved", kind: "host" });
  });

  it("needs no request body, and an allow_host parameter is gone: sending one changes nothing", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const a = await fetchVia(k.key, { url: NEW_URL });
    const b = await fetchVia(k.key, { url: "https://other.newhost.example/x" });
    expect((await approve(a.approval_id)).json()).toEqual({ id: a.approval_id, status: "approved" });
    expect((await approve(b.approval_id, { allow_host: false })).json()).toEqual({ id: b.approval_id, status: "approved" });
    expect(await keyHosts(k.id)).toEqual(["known.example:443", "api.newhost.example:443", "other.newhost.example:443"]);
  });

  it("is idempotent: a second approval for a host that is already listed does not list it twice", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const a = await fetchVia(k.key, { url: NEW_URL });
    expect((await approve(a.approval_id)).statusCode).toBe(200);
    // (a request for a listed host makes no approval any more; one written straight into the database is still handled)
    const again = createHostApproval(t.ctx.sqlite, t.ctx.db, { keyId: k.id, url: "https://API.NewHost.example/v1/other", method: "GET", body: undefined });
    expect((await approve(again.id)).statusCode).toBe(200);
    expect(await keyHosts(k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
    expect(getApproval(t.ctx.db, again.id)!.status).toBe("approved");
  });

  it("a name that resolves to a private address is refused: 400 ALLOW_HOST_PRIVATE_HOST with the reason, the approval is still pending, nothing is added", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    dns.answers.set("rebind.attacker.example", ["127.0.0.1"]);
    dns.answers.set("meta.attacker.example", ["169.254.169.254"]);
    dns.answers.set("cgnat.attacker.example", ["100.100.100.200"]);
    dns.answers.set("mapped.attacker.example", ["::ffff:10.0.0.1"]);
    dns.answers.set("mixed.attacker.example", ["93.184.216.34", "10.0.0.7"]);
    for (const url of [
      "https://rebind.attacker.example/x",
      "http://meta.attacker.example/latest/meta-data/",
      "http://cgnat.attacker.example/x",
      "http://mapped.attacker.example/x",
      "http://mixed.attacker.example/x",
    ]) {
      const first = await fetchVia(k.key, { url });
      expect(first, url).toMatchObject({ status: "approval_required", charged: "no" }); // asking looks nothing up
      const res = await approve(first.approval_id);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ error: "ALLOW_HOST_PRIVATE_HOST" });
      expect(res.json().message, url).toContain(new URL(url).hostname);
      expect(getApproval(t.ctx.db, first.approval_id)!.status, url).toBe("pending");
    }
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);
    expect(listAudit(t.ctx.db).filter((e) => e.action === "approval.approve")).toHaveLength(0);
  });

  it("a name that resolves to an address of this machine's own network interfaces is refused: 400 ALLOW_HOST_PRIVATE_HOST, still pending; the payment path looks nothing up", async () => {
    t = await buildTestApp();
    noNetwork();
    machineHas("151.101.1.69", "2606:4700:4700::1111"); // public addresses: only the interface list says they are this machine's
    const k = await createKey();
    dns.answers.set("api.newhost.example", ["93.184.216.34", "151.101.1.69"]);
    dns.answers.set("v6.newhost.example", ["2606:4700:4700::1111"]);
    for (const url of [NEW_URL, "https://v6.newhost.example/x"]) {
      const first = await fetchVia(k.key, { url });
      expect(first, url).toMatchObject({ status: "approval_required", charged: "no" });
      expect(dns.calls, "asking looks nothing up").toEqual([]);
      const res = await approve(first.approval_id);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ error: "ALLOW_HOST_PRIVATE_HOST" });
      expect(res.json().message).toContain("this machine's own");
      expect(getApproval(t.ctx.db, first.approval_id)!.status, url).toBe("pending");
      dns.calls.length = 0;
    }
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);

    // a host the key lists itself is never looked up on the way to a payment
    const lists = await createKey({ name: "lists", allowed_hosts: ["api.newhost.example:443"] });
    expect(await fetchVia(lists.key, { url: NEW_URL })).toMatchObject({ status: "error", code: "WALLET_LOCKED", charged: "no" });
    expect(dns.calls).toEqual([]);
  });

  it("a failed DNS look fails closed: 400 ALLOW_HOST_UNRESOLVED, still pending; once the name resolves it can be approved", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    dns.failing.add("api.newhost.example");
    const first = await fetchVia(k.key, { url: NEW_URL });
    const res = await approve(first.approval_id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ALLOW_HOST_UNRESOLVED" });
    expect(res.json().message).toContain("could not be resolved (lookup failed, empty, or over 3 s)");
    expect(getApproval(t.ctx.db, first.approval_id)!.status).toBe("pending");
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);

    dns.failing.clear();
    expect((await approve(first.approval_id)).statusCode).toBe(200);
    expect(await keyHosts(k.id)).toEqual(["known.example:443", "api.newhost.example:443"]);
  });

  it("a DNS look that never answers is a failure after 3 seconds: 400 ALLOW_HOST_UNRESOLVED, still pending", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    dns.hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = approve(first.approval_id);
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ALLOW_HOST_UNRESOLVED" });
    expect(getApproval(t.ctx.db, first.approval_id)!.status).toBe("pending");
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
  });

  it("a child key's approval is refused: 400 ALLOW_HOST_CHILD_KEY, still pending, no list changes, no DNS look", async () => {
    t = await buildTestApp();
    noNetwork();
    const parent = await createKey();
    const child = createChildKey(
      t.ctx.db,
      parent.id,
      { name: "child", dailyBudget: parseUsdcToMicros("1"), totalBudget: parseUsdcToMicros("2"), perRequestLimit: parseUsdcToMicros("0.5") },
      { maxDepth: 3 }
    );
    // (a request never makes one for a child key; this is one written straight into the database)
    const a = createHostApproval(t.ctx.sqlite, t.ctx.db, { keyId: child.row.id, url: NEW_URL, method: "GET", body: undefined });
    const refused = await approve(a.id);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "ALLOW_HOST_CHILD_KEY" });
    expect(getApproval(t.ctx.db, a.id)!.status).toBe("pending");
    expect(await keyHosts(parent.id)).toEqual(["known.example:443"]);
    expect(await keyHosts(child.row.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);
    expect(dns.calls).toEqual([]);
  });

  it("a revoked key: 400 ALLOW_HOST_KEY_NOT_ACTIVE; an already decided or unknown approval: 400 APPROVAL_NOT_PENDING; nothing changes", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const first = await fetchVia(k.key, { url: NEW_URL });
    expect((await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/revoke`, headers: asAdmin() })).statusCode).toBe(200);
    const revoked = await approve(first.approval_id);
    expect(revoked.statusCode).toBe(400);
    expect(revoked.json()).toMatchObject({ error: "ALLOW_HOST_KEY_NOT_ACTIVE" });
    expect(getApproval(t.ctx.db, first.approval_id)!.status).toBe("pending");

    const live = await createKey({ name: "live" });
    const a = await fetchVia(live.key, { url: NEW_URL });
    expect((await deny(a.approval_id)).statusCode).toBe(200);
    const late = await approve(a.approval_id);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ error: "APPROVAL_NOT_PENDING" });
    expect(getApproval(t.ctx.db, a.approval_id)!.status).toBe("denied");

    const unknown = await approve("no-such-approval");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "APPROVAL_NOT_PENDING" }); // (there is no APPROVAL_NOT_FOUND on this route)
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(await keyHosts(live.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);
  });

  it("a payment approval is approved exactly as before: no DNS look, no list change, no key.allow_host audit", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const pay = createApproval(t.ctx.db, {
      keyId: k.id,
      url: "https://known.example/paid",
      method: "GET",
      body: undefined,
      network: "eip155:10143",
      asset: "0xasset",
      payTo: "0xpay",
      amount: parseUsdcToMicros("0.15"),
    });
    const res = await approve(pay.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: pay.id, status: "approved" });
    expect(getApproval(t.ctx.db, pay.id)!.status).toBe("approved");
    expect(dns.calls).toEqual([]);
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(allowHostAudit()).toHaveLength(0);
    expect(listAudit(t.ctx.db).filter((e) => e.action === "approval.approve").map((e) => e.detail)).toEqual([{ approvalId: pay.id }]);
    // deciding it again is refused, as before
    expect((await approve(pay.id)).json()).toEqual({ error: "APPROVAL_NOT_PENDING" });
  });

  it("still needs the administrator: a MoneyKey cannot approve, and nothing changes", async () => {
    t = await buildTestApp();
    noNetwork();
    const k = await createKey();
    const a = await fetchVia(k.key, { url: NEW_URL });
    const res = await t.app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/approve`, headers: asKey(k.key) });
    expect(res.statusCode).toBe(403);
    expect(getApproval(t.ctx.db, a.approval_id)!.status).toBe("pending");
    expect(await keyHosts(k.id)).toEqual(["known.example:443"]);
    expect(dns.calls).toEqual([]);
  });
});
