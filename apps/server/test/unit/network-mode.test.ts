import { describe, it, expect, afterEach } from "vitest";
import { BASE, BASE_SEPOLIA, MAINNET, TESTNET } from "@moneyswitch/x402";
import { createMoneyKey, parseUsdcToMicros } from "@moneyswitch/core";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/**
 * SPEC.md §1, §6 (v0.7.2): a key is a testnet key or a mainnet key, chosen when it is issued and never changed.
 * Here: how it is issued (inferred, or NETWORK_MODE_REQUIRED), that a child key shares it, and what the key and admin views report.
 * What the mode does to a payment (the chain list the key may pay on) is in test/e2e/network-mode-flow.test.ts.
 */

let t: TestCtx;
const original = process.env.MONEYSWITCH_NETWORKS;
afterEach(async () => {
  if (original === undefined) delete process.env.MONEYSWITCH_NETWORKS;
  else process.env.MONEYSWITCH_NETWORKS = original;
  if (t) await cleanupTestApp(t);
});

const TESTNETS = `${TESTNET.caip2},${BASE_SEPOLIA.caip2}`;
const MIXED = `${TESTNET.caip2},${MAINNET.caip2},${BASE_SEPOLIA.caip2},${BASE.caip2}`;
const MAINNETS = `${MAINNET.caip2},${BASE.caip2}`;

const base = { name: "agent", total_budget: "10", daily_budget: "1", per_request_limit: "0.5", allowed_hosts: ["example.com:443"] };

async function issue(payload: Record<string, unknown> = {}) {
  return t.app.inject({ method: "POST", url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` }, payload: { ...base, ...payload } });
}
const countKeys = () => (t.ctx.sqlite.prepare("SELECT count(*) AS n FROM money_keys").get() as { n: number }).n;
const asKey = (key: string) => ({ authorization: `Bearer ${key}` });

describe("POST /v1/keys: the network type a key is issued with", () => {
  it("an instance with testnets only: omitted means testnet; the key view says so and lists the chains it can pay on", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = TESTNETS;
    const res = await issue();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
  });

  it("an instance with mainnets only: omitted means mainnet", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MAINNETS;
    expect((await issue()).json()).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
  });

  it("the default instance (nothing configured: the testnet only) behaves like an instance with testnets only", async () => {
    t = await buildTestApp();
    delete process.env.MONEYSWITCH_NETWORKS;
    expect((await issue()).json()).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2] });
  });

  it("both kinds enabled and no network_mode: 400 NETWORK_MODE_REQUIRED, and no key is created", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    for (const payload of [{}, { network_mode: null }]) {
      const res = await issue(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("NETWORK_MODE_REQUIRED");
      expect(typeof res.json().message).toBe("string");
    }
    expect(countKeys()).toBe(0);
  });

  it("both kinds enabled: either kind can be asked for, and the key can pay only on the chains of its kind (in the instance's order)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    expect((await issue({ network_mode: "testnet" })).json()).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
    expect((await issue({ network_mode: "mainnet" })).json()).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
    expect(countKeys()).toBe(2);
  });

  it("a kind the instance does not enable: 400 NETWORK_MODE_NOT_ENABLED, no key", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = TESTNETS;
    const mainnet = await issue({ network_mode: "mainnet" });
    expect(mainnet.statusCode).toBe(400);
    expect(mainnet.json().error).toBe("NETWORK_MODE_NOT_ENABLED");
    process.env.MONEYSWITCH_NETWORKS = MAINNETS;
    const testnet = await issue({ network_mode: "testnet" });
    expect(testnet.statusCode).toBe(400);
    expect(testnet.json().error).toBe("NETWORK_MODE_NOT_ENABLED");
    expect(countKeys()).toBe(0);
  });

  it("anything but \"testnet\" or \"mainnet\": 400 NETWORK_MODE_INVALID, no key", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    for (const network_mode of ["Testnet", "main", "", 1, true, {}, ["testnet"]]) {
      const res = await issue({ network_mode });
      expect(res.statusCode, JSON.stringify(network_mode)).toBe(400);
      expect(res.json().error).toBe("NETWORK_MODE_INVALID");
    }
    expect(countKeys()).toBe(0);
  });

  it("the network type is written into the audit log with the key", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const id = (await issue({ network_mode: "mainnet" })).json().id;
    const row = t.ctx.sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'key.create'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ keyId: id, networkMode: "mainnet" });
  });
});

describe("a key's network type never changes", () => {
  it("there is no route that changes it: PATCH / PUT / POST on the key with a network_mode do nothing to it", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const created = (await issue({ network_mode: "testnet" })).json();
    for (const method of ["PATCH", "PUT"] as const) {
      const res = await t.app.inject({ method, url: `/v1/keys/${created.id}`, headers: { authorization: `Bearer ${t.adminToken}` }, payload: { network_mode: "mainnet" } });
      expect(res.statusCode, method).toBe(404);
    }
    const row = t.ctx.sqlite.prepare("SELECT network_mode FROM money_keys WHERE id = ?").get(created.id) as { network_mode: string };
    expect(row.network_mode).toBe("testnet");
  });

  it("resetting the secret keeps the kind, and says it (the new skill paragraph is written for it)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const created = (await issue({ network_mode: "mainnet" })).json();
    const rotated = await t.app.inject({ method: "POST", url: `/v1/keys/${created.id}/rotate`, headers: { authorization: `Bearer ${t.adminToken}` } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ id: created.id, network_mode: "mainnet" });
  });
});

describe("GET /v1/keys and GET /v1/status report the network type and the chains the key can pay on", () => {
  it("each key in the admin list: network_mode and networks; a key from before v0.7.2 has network_mode null and, with both kinds enabled, the testnets only", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    await issue({ name: "tn", network_mode: "testnet" });
    await issue({ name: "mn", network_mode: "mainnet" });
    createMoneyKey(t.ctx.db, { name: "old", totalBudget: parseUsdcToMicros("5"), dailyBudget: parseUsdcToMicros("1"), perRequestLimit: parseUsdcToMicros("0.5"), allowedHosts: [] });
    const list = (await t.app.inject({ url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` } })).json().keys as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(list.map((k) => [k.name as string, k]));
    expect(byName.tn).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
    expect(byName.mn).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
    expect(byName.old).toMatchObject({ network_mode: null, networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
  });

  it("a key from before v0.7.2 on an instance with one kind: every enabled chain of it, as before", async () => {
    t = await buildTestApp();
    createMoneyKey(t.ctx.db, { name: "old", totalBudget: parseUsdcToMicros("5"), dailyBudget: parseUsdcToMicros("1"), perRequestLimit: parseUsdcToMicros("0.5"), allowedHosts: [] });
    const networksOf = async () => ((await t.app.inject({ url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` } })).json().keys as Array<{ networks: string[]; network_mode: unknown }>)[0];
    process.env.MONEYSWITCH_NETWORKS = MAINNETS;
    expect(await networksOf()).toMatchObject({ network_mode: null, networks: [MAINNET.caip2, BASE.caip2] });
    process.env.MONEYSWITCH_NETWORKS = TESTNETS;
    expect(await networksOf()).toMatchObject({ network_mode: null, networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
  });

  it("a key with no type of its own follows its parent in the views (effective network_mode and networks); two typed levels that differ show no network", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const parent = (await issue({ name: "parent", network_mode: "mainnet", can_delegate: true })).json();
    const child = (await t.app.inject({ method: "POST", url: "/v1/keys/children", headers: asKey(parent.key), payload: { name: "kid", daily_budget: "0.5", total_budget: "5", per_request_limit: "0.2" } })).json();
    t.ctx.sqlite.prepare("UPDATE money_keys SET network_mode = NULL WHERE id = ?").run(child.id); // a child of a key from before the column
    const list = async () => Object.fromEntries(((await t.app.inject({ url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` } })).json().keys as Array<Record<string, unknown>>).map((k) => [k.name as string, k]));
    expect((await list()).kid).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
    expect((await t.app.inject({ url: "/v1/status", headers: asKey(child.key) })).json()).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2], network: MAINNET.caip2 });
    t.ctx.sqlite.prepare("UPDATE money_keys SET network_mode = 'testnet' WHERE id = ?").run(child.id); // no code path does this
    expect((await list()).kid).toMatchObject({ network_mode: null, networks: [] });
    expect((await t.app.inject({ url: "/v1/status", headers: asKey(child.key) })).json()).toMatchObject({ network_mode: null, networks: [], network: null });
  });

  it("a key lists only the chains that are enabled now (the instance's setting can change after the key was issued)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const id = (await issue({ name: "tn", network_mode: "testnet" })).json().id;
    process.env.MONEYSWITCH_NETWORKS = `${MAINNET.caip2},${BASE_SEPOLIA.caip2}`;
    const list = (await t.app.inject({ url: "/v1/keys", headers: { authorization: `Bearer ${t.adminToken}` } })).json().keys as Array<{ id: string; networks: string[] }>;
    expect(list.find((k) => k.id === id)!.networks).toEqual([BASE_SEPOLIA.caip2]);
  });

  it("GET /v1/status (the key asks about itself): network_mode, the chains it can pay on, and a `network` that is one of them", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED; // the default network is the first: Monad testnet
    const testnetKey = (await issue({ network_mode: "testnet" })).json().key as string;
    const mainnetKey = (await issue({ network_mode: "mainnet" })).json().key as string;
    const testnet = (await t.app.inject({ url: "/v1/status", headers: asKey(testnetKey) })).json();
    expect(testnet).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2, BASE_SEPOLIA.caip2], network: TESTNET.caip2 });
    const mainnet = (await t.app.inject({ url: "/v1/status", headers: asKey(mainnetKey) })).json();
    expect(mainnet).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
    expect(mainnet.networks).toContain(mainnet.network);
    expect(mainnet.network).toBe(MAINNET.caip2);
  });

  it("GET /v1/status for a key from before v0.7.2: network_mode null; with both kinds enabled it pays on the testnets only, and `network` is one of them", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = `${MAINNET.caip2},${BASE_SEPOLIA.caip2},${TESTNET.caip2}`; // the default network is a mainnet
    const { plaintextKey } = createMoneyKey(t.ctx.db, { name: "old", totalBudget: parseUsdcToMicros("5"), dailyBudget: parseUsdcToMicros("1"), perRequestLimit: parseUsdcToMicros("0.5"), allowedHosts: [] });
    const status = (await t.app.inject({ url: "/v1/status", headers: asKey(plaintextKey) })).json();
    expect(status).toMatchObject({ network_mode: null, network: BASE_SEPOLIA.caip2, networks: [BASE_SEPOLIA.caip2, TESTNET.caip2] });
    process.env.MONEYSWITCH_NETWORKS = MAINNETS;
    expect((await t.app.inject({ url: "/v1/status", headers: asKey(plaintextKey) })).json()).toMatchObject({ network_mode: null, network: MAINNET.caip2, networks: [MAINNET.caip2, BASE.caip2] });
  });

  it("GET /v1/status: `network` is null when the key has no payable chain on this instance (a mainnet key where only testnets are enabled now)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const key = (await issue({ network_mode: "mainnet" })).json().key as string;
    process.env.MONEYSWITCH_NETWORKS = TESTNETS;
    const status = (await t.app.inject({ url: "/v1/status", headers: asKey(key) })).json();
    expect(status).toMatchObject({ network_mode: "mainnet", networks: [], network: null });
  });
});

describe("child keys (POST /v1/keys/children) share the network type of their parent", () => {
  const childPayload = (over: Record<string, unknown> = {}) => ({ name: "child", daily_budget: "0.5", total_budget: "5", per_request_limit: "0.2", ...over });
  const child = (parentKey: string, over: Record<string, unknown> = {}) =>
    t.app.inject({ method: "POST", url: "/v1/keys/children", headers: asKey(parentKey), payload: childPayload(over) });

  it("the child of a testnet key is a testnet key, the child of a mainnet key a mainnet key; the response says so", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const testnetParent = (await issue({ network_mode: "testnet", can_delegate: true })).json().key as string;
    const mainnetParent = (await issue({ network_mode: "mainnet", can_delegate: true })).json().key as string;
    const a = await child(testnetParent);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ network_mode: "testnet", networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
    const b = await child(mainnetParent);
    expect(b.json()).toMatchObject({ network_mode: "mainnet", networks: [MAINNET.caip2, BASE.caip2] });
    const rows = t.ctx.sqlite.prepare("SELECT name, network_mode FROM money_keys WHERE parent_id IS NOT NULL ORDER BY created_at").all();
    expect(rows).toEqual([{ name: "child", network_mode: "testnet" }, { name: "child", network_mode: "mainnet" }]);
  });

  it("naming the parent's own kind is accepted; naming the other kind is refused (400 INVALID_REQUEST, field network_mode) and no key is created", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const parent = (await issue({ network_mode: "testnet", can_delegate: true })).json().key as string;
    expect((await child(parent, { network_mode: "testnet" })).statusCode).toBe(200);
    const before = countKeys();
    const other = await child(parent, { network_mode: "mainnet" });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toMatchObject({ code: "INVALID_REQUEST", field: "network_mode", parent_value: "testnet" });
    const bad = await child(parent, { network_mode: "everything" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "INVALID_REQUEST", field: "network_mode" });
    expect(countKeys()).toBe(before);
  });

  it("the child of a key from before v0.7.2 has no network type either (and on a mixed instance pays on the testnets only), and cannot be given one", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const { plaintextKey } = createMoneyKey(t.ctx.db, {
      name: "old",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: ["example.com:443"],
      canDelegate: true,
    });
    const res = await child(plaintextKey);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ network_mode: null, networks: [TESTNET.caip2, BASE_SEPOLIA.caip2] });
    const named = await child(plaintextKey, { network_mode: "testnet" });
    expect(named.statusCode).toBe(400);
    expect(named.json()).toMatchObject({ code: "INVALID_REQUEST", field: "network_mode" });
  });

  it("a grandchild keeps the kind all the way down", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const root = (await issue({ network_mode: "mainnet", can_delegate: true })).json().key as string;
    const middle = (await child(root, { can_delegate: true })).json().key as string;
    const leaf = await child(middle);
    expect(leaf.json()).toMatchObject({ depth: 2, network_mode: "mainnet" });
  });
});

describe("the bills and the approvals say what kind of chain a row is on", () => {
  it("GET /v1/admin/usage: network_kind per payment, from the configuration table (a chain that is switched off now keeps its kind; an unknown chain is null)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = TESTNET.caip2;
    const keyId = (await issue()).json().id as string;
    const insert = t.ctx.sqlite.prepare(
      `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind)
       VALUES (?, ?, 'https://example.com/x', 'example.com:443', 'GET', ?, '0xa', '0xb', 10000, 'settled', ?, ?, 'fetch')`
    );
    const at = "2026-10-04T00:00:00.000Z";
    for (const [id, network] of [["a", TESTNET.caip2], ["b", MAINNET.caip2], ["c", BASE.caip2], ["d", BASE_SEPOLIA.caip2], ["e", "eip155:999"]]) insert.run(id, keyId, network, at, at);
    const rows = (await t.app.inject({ url: "/v1/admin/usage", headers: { authorization: `Bearer ${t.adminToken}` } })).json().payments as Array<{ id: string; network_kind: string | null }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.network_kind]))).toEqual({ a: "testnet", b: "mainnet", c: "mainnet", d: "testnet", e: null });
  });

  it("GET /v1/approvals: network_kind of a payment approval; null for a host approval (no chain yet)", async () => {
    t = await buildTestApp();
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const keyId = (await issue({ network_mode: "mainnet" })).json().id as string;
    const insert = t.ctx.sqlite.prepare(
      `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, created_at, kind)
       VALUES (?, ?, 'https://example.com/x', 'GET', 'sha', ?, ?, ?, ?, 'pending', ?, ?, ?)`
    );
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    insert.run("pay", keyId, MAINNET.caip2, "0xusdc", "0xpay", 150000, later, now, "payment");
    insert.run("host", keyId, "", "", "", 0, later, now, "host");
    const rows = (await t.app.inject({ url: "/v1/approvals", headers: { authorization: `Bearer ${t.adminToken}` } })).json().approvals as Array<{ id: string; network_kind: string | null }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.network_kind]))).toEqual({ pay: "mainnet", host: null });
  });
});

describe("GET /v1/admin/meta: the faucet is offered whenever a testnet is enabled", () => {
  it("testnets only or mixed: the faucet URL is there; mainnets only: it is not", async () => {
    t = await buildTestApp();
    const meta = async () => (await t.app.inject({ url: "/v1/admin/meta", headers: { authorization: `Bearer ${t.adminToken}` } })).json();
    process.env.MONEYSWITCH_NETWORKS = TESTNETS;
    expect((await meta()).faucet_url).toBe("https://faucet.circle.com/");
    process.env.MONEYSWITCH_NETWORKS = MIXED;
    const mixed = await meta();
    expect(mixed.faucet_url).toBe("https://faucet.circle.com/");
    expect(mixed.networks.map((n: { network: string; is_mainnet: boolean }) => [n.network, n.is_mainnet])).toEqual([
      [TESTNET.caip2, false], [MAINNET.caip2, true], [BASE_SEPOLIA.caip2, false], [BASE.caip2, true],
    ]);
    process.env.MONEYSWITCH_NETWORKS = MAINNETS;
    expect((await meta()).faucet_url).toBeNull();
  });
});
