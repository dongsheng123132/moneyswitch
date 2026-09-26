import { describe, it, expect, afterEach } from "vitest";
import { schema } from "@moneyswitch/db";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/** v0.4 (SPEC-v0.4 §A): HTTP surface of child keys (no payments; see test/e2e/subkeys-flow.test.ts). */

let t: TestCtx;

afterEach(async () => {
  if (t) await cleanupTestApp(t);
});

async function adminKey(over: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: {
      name: "employee",
      total_budget: "10",
      daily_budget: "1",
      per_request_limit: "0.5",
      approval_threshold: "0.2",
      allowed_hosts: ["example.com:443", "api.test:8443"],
      allowed_models: ["m1", "m2"],
      max_payments_per_minute: 20,
      can_delegate: true,
      ...over,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; key: string; can_delegate: boolean; depth: number; parent_id: string | null };
}

function childPayload(over: Record<string, unknown> = {}) {
  return { name: "agent", daily_budget: "0.5", total_budget: "5", per_request_limit: "0.2", ...over };
}

async function createChild(parentKey: string, over: Record<string, unknown> = {}) {
  return t.app.inject({
    method: "POST",
    url: "/v1/keys/children",
    headers: { authorization: `Bearer ${parentKey}` },
    payload: childPayload(over),
  });
}

async function get(url: string, token: string) {
  return t.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

async function post(url: string, token: string) {
  return t.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } });
}

describe("POST /v1/keys (admin) — can_delegate", () => {
  it("returns can_delegate/depth/parent_id; defaults to can_delegate=false; rejects non-boolean", async () => {
    t = await buildTestApp();
    const k = await adminKey();
    expect([k.can_delegate, k.depth, k.parent_id]).toEqual([true, 0, null]);
    const k2 = await adminKey({ can_delegate: undefined });
    expect(k2.can_delegate).toBe(false);
    const bad = await t.app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { name: "x", total_budget: "1", daily_budget: "1", per_request_limit: "1", allowed_hosts: [], can_delegate: "yes" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("POST /v1/keys/children", () => {
  it("creates a child: full key once, parent-bound fields, audit key.child_create by key:<parent>", async () => {
    t = await buildTestApp();
    const parent = await adminKey();
    const res = await createChild(parent.key);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.key).toMatch(/^mk_live_/);
    expect(c.key_hash).toBeUndefined();
    expect(c.parent_id).toBe(parent.id);
    expect(c.depth).toBe(1);
    expect(c.can_delegate).toBe(false);
    expect(c.created_by).toBe(`key:${parent.id}`);
    expect(c.allowed_hosts).toEqual(["example.com:443", "api.test:8443"]); // inherited
    expect(c.allowed_models).toEqual(["m1", "m2"]); // inherited
    expect(c.max_payments_per_minute).toBe(20); // inherited
    expect(c.approval_threshold).toBeNull(); // parent's 0.2 still applies via the chain
    const audit = t.ctx.db.select().from(schema.auditLog).all().find((a) => a.action === "key.child_create");
    expect(audit?.actor).toBe(`key:${parent.id}`);
    expect(JSON.stringify(audit?.detail)).not.toContain("mk_live_");
    // the child key authenticates
    const st = await get("/v1/status", c.key);
    expect(st.statusCode).toBe(200);
    expect(st.json().is_child).toBe(true);
  });

  it.each([
    ["daily_budget", { daily_budget: "1.01" }, "1"],
    ["total_budget", { total_budget: "10.5" }, "10"],
    ["per_request_limit", { per_request_limit: "0.6" }, "0.5"],
    ["approval_threshold", { approval_threshold: "0.21" }, "0.2"],
    ["allowed_hosts", { allowed_hosts: ["example.com:443", "evil.com:443"] }, ["example.com:443", "api.test:8443"]],
    ["allowed_models", { allowed_models: ["m3"] }, ["m1", "m2"]],
    ["max_payments_per_minute", { max_payments_per_minute: 21 }, 20],
  ] as const)("%s beyond the parent -> 400 CHILD_EXCEEDS_PARENT with field + parent_value", async (field, over, parentValue) => {
    t = await buildTestApp();
    const parent = await adminKey();
    const res = await createChild(parent.key, over);
    expect(res.statusCode).toBe(400);
    const b = res.json();
    expect(b.error).toBe("CHILD_EXCEEDS_PARENT");
    expect(b.code).toBe("CHILD_EXCEEDS_PARENT");
    expect(b.field).toBe(field);
    expect(b.parent_value).toEqual(parentValue);
    expect(t.ctx.db.select().from(schema.moneyKeys).all().length).toBe(1);
  });

  it("expires_at later than parent's -> 400 CHILD_EXCEEDS_PARENT expires_at", async () => {
    t = await buildTestApp();
    const exp = new Date(Date.now() + 86_400_000).toISOString();
    const parent = await adminKey({ expires_at: exp });
    const res = await createChild(parent.key, { expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe("expires_at");
    expect(res.json().parent_value).toBe(exp);
    const ok = await createChild(parent.key);
    expect(ok.json().expires_at).toBe(exp);
  });

  it("missing / malformed fields -> 400 INVALID_REQUEST naming the field", async () => {
    t = await buildTestApp();
    const parent = await adminKey();
    for (const [over, field] of [
      [{ daily_budget: undefined }, "daily_budget"],
      [{ total_budget: "abc" }, "total_budget"],
      [{ per_request_limit: "-1" }, "per_request_limit"],
      [{ name: "" }, "name"],
      [{ allowed_hosts: "example.com:443" }, "allowed_hosts"],
      [{ can_delegate: "true" }, "can_delegate"],
      [{ expires_at: "soon" }, "expires_at"],
    ] as const) {
      const res = await createChild(parent.key, over as Record<string, unknown>);
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
      expect(res.json().code).toBe("INVALID_REQUEST");
      expect(res.json().field).toBe(field);
    }
    // numbers are accepted as amounts too
    expect((await createChild(parent.key, { daily_budget: 0.25 })).json().daily_budget).toBe("0.25");
  });

  it("parent without can_delegate -> 403 DELEGATION_NOT_ALLOWED", async () => {
    t = await buildTestApp();
    const parent = await adminKey({ can_delegate: false });
    const res = await createChild(parent.key);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("depth limit (default 3): depth-3 key -> 403 MAX_DEPTH_EXCEEDED; can_delegate at depth 3 rejected", async () => {
    t = await buildTestApp();
    const root = await adminKey();
    const d1 = (await createChild(root.key, { can_delegate: true })).json();
    const d2 = (await createChild(d1.key, { can_delegate: true })).json();
    expect(d2.depth).toBe(2);
    const bad = await createChild(d2.key, { can_delegate: true });
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ code: "MAX_DEPTH_EXCEEDED", field: "can_delegate" });
    const d3 = (await createChild(d2.key)).json();
    expect(d3.depth).toBe(3);
    // d3 cannot delegate
    const st = (await get("/v1/status", d3.key)).json();
    expect(st.can_create_children).toBe(false);
    expect(st.max_depth).toBe(3);
    expect((await createChild(d3.key)).json().code).toBe("DELEGATION_NOT_ALLOWED");
  });

  it("MONEYSWITCH_MAX_KEY_DEPTH=1 (config.maxKeyDepth) stops at depth 1", async () => {
    t = await buildTestApp();
    t.ctx.config.maxKeyDepth = 1;
    const root = await adminKey();
    const bad = await createChild(root.key, { can_delegate: true });
    expect(bad.json().code).toBe("MAX_DEPTH_EXCEEDED");
    const d1 = await createChild(root.key);
    expect(d1.json().depth).toBe(1);
    expect((await get("/v1/status", root.key)).json().can_create_children).toBe(true);
  });

  it("auth separation: admin token -> 401, no token -> 401; child keys cannot use admin routes (403)", async () => {
    t = await buildTestApp();
    const parent = await adminKey();
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/keys/children",
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: childPayload(),
    });
    expect(res.statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/v1/keys/children" })).statusCode).toBe(401);
    const c = (await createChild(parent.key)).json();
    for (const url of ["/v1/keys", "/v1/admin/keys/tree", "/v1/admin/usage"]) {
      expect((await get(url, c.key)).statusCode).toBe(403);
      expect((await get(url, parent.key)).statusCode).toBe(403);
    }
  });

  it("a revoked parent cannot create children (401 KEY_REVOKED)", async () => {
    t = await buildTestApp();
    const parent = await adminKey();
    await post(`/v1/keys/${parent.id}/revoke`, t.adminToken);
    const res = await createChild(parent.key);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "KEY_REVOKED", limit_scope: "self" });
  });
});

describe("GET /v1/keys/children, revoke, admin views", () => {
  it("lists only the caller's direct children, with usage and without secrets", async () => {
    t = await buildTestApp();
    const root = await adminKey();
    const a = (await createChild(root.key, { name: "a", can_delegate: true })).json();
    await createChild(root.key, { name: "b" });
    await createChild(a.key, { name: "a1" });
    const list = (await get("/v1/keys/children", root.key)).json().children;
    expect(list.map((k: { name: string }) => k.name)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ used_today: "0", used_total: "0", children_count: 1, status: "active", depth: 1 });
    expect(list[0].key).toBeUndefined();
    expect(list[0].key_hash).toBeUndefined();
    const aList = (await get("/v1/keys/children", a.key)).json().children;
    expect(aList.map((k: { name: string }) => k.name)).toEqual(["a1"]);
  });

  it("revoke: only strict descendants; others 404; cascade makes grandchildren fail auth with limit_scope=ancestor", async () => {
    t = await buildTestApp();
    const root = await adminKey();
    const otherRoot = await adminKey();
    const a = (await createChild(root.key, { can_delegate: true })).json();
    const b = (await createChild(root.key)).json();
    const a1 = (await createChild(a.key)).json();

    for (const [caller, target] of [
      [a.key, b.id], // sibling
      [a.key, root.id], // parent
      [a.key, a.id], // itself
      [a.key, otherRoot.id], // other tree
      [a1.key, a.id], // child -> parent
      [a.key, "nope"],
    ]) {
      const r = await post(`/v1/keys/children/${target}/revoke`, caller);
      expect(r.statusCode).toBe(404);
    }
    expect((await get("/v1/status", b.key)).statusCode).toBe(200);

    const r = await post(`/v1/keys/children/${a.id}/revoke`, root.key);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: a.id, revoked: true });
    const self = await get("/v1/status", a.key);
    expect(self.statusCode).toBe(401);
    expect(self.json()).toMatchObject({ code: "KEY_REVOKED", limit_scope: "self" });
    const gc = await get("/v1/status", a1.key);
    expect(gc.statusCode).toBe(401);
    expect(gc.json()).toMatchObject({ code: "KEY_REVOKED", limit_scope: "ancestor", limit_key_prefix: a.key_prefix });
    // OpenAI-shaped routes carry the same scope
    const models = await get("/v1/models", a1.key);
    expect(models.statusCode).toBe(403);
    expect(models.json().error).toMatchObject({ code: "KEY_REVOKED", limit_scope: "ancestor" });
    const audit = t.ctx.db.select().from(schema.auditLog).all().find((x) => x.action === "key.child_revoke");
    expect(audit?.actor).toBe(`key:${root.id}`);

    // root can revoke a grandchild directly
    const b1Parent = (await createChild(root.key, { can_delegate: true })).json();
    const b1 = (await createChild(b1Parent.key)).json();
    expect((await post(`/v1/keys/children/${b1.id}/revoke`, root.key)).statusCode).toBe(200);
  });

  it("admin GET /v1/keys exposes parent_id/depth/can_delegate/children_count/status; tree nests", async () => {
    t = await buildTestApp();
    const root = await adminKey({ name: "root" });
    const a = (await createChild(root.key, { name: "a", can_delegate: true })).json();
    await createChild(a.key, { name: "a1" });
    await adminKey({ name: "solo", can_delegate: false });
    await post(`/v1/keys/${root.id}/revoke`, t.adminToken);

    const keys = (await get("/v1/keys", t.adminToken)).json().keys as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(keys.map((k) => [k.name, k]));
    expect(byName.root).toMatchObject({ parent_id: null, depth: 0, can_delegate: true, children_count: 1, status: "revoked" });
    expect(byName.a).toMatchObject({ parent_id: root.id, depth: 1, can_delegate: true, children_count: 1, status: "ancestor_revoked", enabled: true });
    expect(byName.a1).toMatchObject({ depth: 2, children_count: 0, status: "ancestor_revoked" });
    expect(byName.solo).toMatchObject({ can_delegate: false, status: "active" });
    for (const k of keys) expect(k.key_hash).toBeUndefined();

    const tree = (await get("/v1/admin/keys/tree", t.adminToken)).json().tree;
    expect(tree.map((n: { name: string }) => n.name)).toEqual(["root", "solo"]);
    expect(tree[0].children[0].name).toBe("a");
    expect(tree[0].children[0].children[0].name).toBe("a1");
    expect(tree[0].children[0].children[0].children).toEqual([]);
  });

  it("/v1/status reports effective remaining (min over ancestors) and delegation info", async () => {
    t = await buildTestApp();
    const root = await adminKey({ daily_budget: "1" });
    const st = (await get("/v1/status", root.key)).json();
    expect(st).toMatchObject({
      remaining_today: "1",
      depth: 0,
      can_delegate: true,
      can_create_children: true,
      is_child: false,
      approval_threshold: "0.2",
    });
    const c = (await createChild(root.key, { daily_budget: "0.5", per_request_limit: "0.1" })).json();
    const cs = (await get("/v1/status", c.key)).json();
    expect(cs).toMatchObject({
      remaining_today: "0.5",
      remaining_today_scope: "self",
      per_request_limit: "0.1",
      approval_threshold: "0.2",
      can_create_children: false,
      is_child: true,
      depth: 1,
    });
  });
});
