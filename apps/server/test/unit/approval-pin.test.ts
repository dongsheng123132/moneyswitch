import { describe, it, expect, afterEach, vi } from "vitest";
import { createApproval, createHostApproval, getApproval, listAudit, parseUsdcToMicros, APPROVAL_PIN_MAX_FAILURES } from "@moneyswitch/core";
import { schema } from "@moneyswitch/db";
import { eq } from "drizzle-orm";
import { buildTestApp, cleanupTestApp, type TestCtx } from "../helpers.js";

/**
 * SPEC.md §3: the person who holds a root key approves its requests (and its child keys') with a 4-6 digit PIN, from the approval link, with
 * no login; the administrator can still approve everything. The key itself never can. The PIN is stored salted and slow-hashed, five wrong
 * ones since it was set lock it (a right one resets nothing), and only the administrator setting a new one unlocks it. A PIN that is too easy to
 * guess is refused wherever one is set.
 */

// DNS is replaced (approving a new host looks its name up once): a name resolves to a public address, with no network.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

let t: TestCtx;

afterEach(async () => {
  vi.restoreAllMocks();
  if (t) await cleanupTestApp(t);
});

const asAdmin = () => ({ authorization: `Bearer ${t.adminToken}` });
const asKey = (key: string) => ({ authorization: `Bearer ${key}` });

type Created = { id: string; key: string; approval_pin: string; allowed_hosts: string[] };

async function createKey(over: Record<string, unknown> = {}): Promise<Created> {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/keys",
    headers: asAdmin(),
    payload: { name: "agent", total_budget: "5", daily_budget: "2", per_request_limit: "1", allowed_hosts: ["known.example:443"], can_delegate: true, ...over },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function makeApproval(keyId: string, amount = "0.15") {
  return createApproval(t.ctx.db, {
    keyId,
    url: "https://known.example/paid?x=1",
    method: "GET",
    body: undefined,
    network: "eip155:10143",
    asset: "0x0000000000000000000000000000000000000001",
    payTo: "0x0000000000000000000000000000000000000002",
    amount: parseUsdcToMicros(amount),
  });
}

const withPin = (id: string, decision: "approve" | "deny", pin: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: `/v1/approvals/${id}/${decision}`, headers, payload: { pin } });
const stored = (id: string) => t.ctx.db.select().from(schema.moneyKeys).where(eq(schema.moneyKeys.id, id)).get()!;
const audit = () => listAudit(t.ctx.db, 200);

describe("issuing a key: POST /v1/keys and the PIN", () => {
  it("without approval_pin a random 4-digit PIN is made and returned once; GET /v1/keys never shows it, and the database holds a salted hash, not the PIN", async () => {
    t = await buildTestApp();
    const k = await createKey();
    expect(k.approval_pin).toMatch(/^[0-9]{4}$/);
    expect(stored(k.id).approvalPin).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored(k.id).approvalPin).not.toContain(k.approval_pin);
    const list = (await t.app.inject({ method: "GET", url: "/v1/keys", headers: asAdmin() })).json().keys as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === k.id)).toMatchObject({ approval_pin_state: "set", approval_pin_failures: 0 });
    expect(JSON.stringify(list)).not.toContain(k.approval_pin);
    expect(JSON.stringify(list)).not.toContain("scrypt");
    expect(JSON.stringify(audit())).not.toContain(`"${k.approval_pin}"`);
  });

  it("the PIN the administrator typed (4 to 6 digits) is the one that is returned and works", async () => {
    t = await buildTestApp();
    for (const pin of ["0042", "13579", "246801"]) {
      const k = await createKey({ name: pin, approval_pin: pin });
      expect(k.approval_pin).toBe(pin);
      expect((await withPin(makeApproval(k.id).id, "approve", pin)).statusCode, pin).toBe(200);
    }
  });

  it("anything else is refused (400 APPROVAL_PIN_INVALID) and no key is made", async () => {
    t = await buildTestApp();
    for (const bad of ["123", "1234567", "12ab", "12 34", "", 1234, ["8426"]]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: asAdmin(),
        payload: { name: "bad", total_budget: "5", daily_budget: "2", per_request_limit: "1", allowed_hosts: [], approval_pin: bad },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error).toBe("APPROVAL_PIN_INVALID");
    }
    expect(t.ctx.db.select().from(schema.moneyKeys).all()).toHaveLength(0);
  });

  it("a PIN that is too easy to guess is refused (400 APPROVAL_PIN_WEAK) and no key is made; the random default is never one", async () => {
    t = await buildTestApp();
    for (const weak of ["1111", "000000", "1234", "2345", "4321", "0123", "123456", "654321", "1212", "1004", "2000", "6969", "1122", "2580", "1313", "1010", "0101", "5683", "0852", "2468", "1357"]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: asAdmin(),
        payload: { name: "weak", total_budget: "5", daily_budget: "2", per_request_limit: "1", allowed_hosts: [], approval_pin: weak },
      });
      expect(res.statusCode, weak).toBe(400);
      expect(res.json().error, weak).toBe("APPROVAL_PIN_WEAK");
      expect(res.json().message).toMatch(/too easy to guess/);
    }
    expect(t.ctx.db.select().from(schema.moneyKeys).all()).toHaveLength(0);
    for (let i = 0; i < 25; i++) expect((await createKey({ name: "random" + i })).approval_pin).toMatch(/^[0-9]{4}$/);
  });
});

describe("POST /v1/keys/:id/approval-pin (administrator): set, replace, unlock", () => {
  it("sets a new PIN (the old one stops working), returns it once, and audits the action without the PIN", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "4821" });
    const res = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "7396" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: k.id, approval_pin: "7396" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await withPin(makeApproval(k.id).id, "approve", "4821")).json().error).toBe("APPROVAL_PIN_WRONG");
    expect((await withPin(makeApproval(k.id).id, "approve", "7396")).statusCode).toBe(200);
    const set = audit().filter((e) => e.action === "key.approval_pin_set");
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ actor: "admin", detail: { keyId: k.id } });
    expect(JSON.stringify(audit())).not.toContain("7396");
  });

  it("a random 4-digit PIN when none is given; an invalid one is a 400 that changes nothing; an unknown key is 404", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "4821" });
    const random = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin() });
    expect(random.statusCode).toBe(200);
    expect(random.json().approval_pin).toMatch(/^[0-9]{4}$/);
    const before = stored(k.id).approvalPin;
    const bad = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "12" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("APPROVAL_PIN_INVALID");
    expect(stored(k.id).approvalPin).toBe(before);
    expect((await t.app.inject({ method: "POST", url: "/v1/keys/no-such-key/approval-pin", headers: asAdmin() })).statusCode).toBe(404);
  });

  it("a PIN that is too easy to guess is refused here too (400 APPROVAL_PIN_WEAK); the old PIN, its count and a lock stay as they were", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "4821" });
    await withPin(makeApproval(k.id).id, "approve", "0000"); // one wrong try
    const before = stored(k.id);
    for (const weak of ["1111", "654321", "1234", "2580", "6969"]) {
      const res = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: weak } });
      expect(res.statusCode, weak).toBe(400);
      expect(res.json().error, weak).toBe("APPROVAL_PIN_WEAK");
    }
    expect(stored(k.id).approvalPin).toBe(before.approvalPin);
    expect(stored(k.id).approvalPinFailures).toBe(1);
    for (let i = 0; i < 25; i++) {
      const random = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin() });
      expect(random.json().approval_pin).toMatch(/^[0-9]{4}$/);
    }
  });

  it("gives a key issued before v0.7.4 (no PIN) its first, and a PIN set after the lock unlocks it", async () => {
    t = await buildTestApp();
    const k = await createKey();
    t.ctx.db.update(schema.moneyKeys).set({ approvalPin: null }).where(eq(schema.moneyKeys.id, k.id)).run(); // as the migration leaves an old key
    const list = async () => ((await t.app.inject({ method: "GET", url: "/v1/keys", headers: asAdmin() })).json().keys as Array<{ id: string; approval_pin_state: string }>).find((x) => x.id === k.id)!;
    expect((await list()).approval_pin_state).toBe("none");
    expect((await withPin(makeApproval(k.id).id, "approve", "8426")).json().error).toBe("APPROVAL_PIN_NOT_SET");

    const set = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "8426" } });
    expect(set.statusCode).toBe(200);
    expect((await list()).approval_pin_state).toBe("set");
    for (let i = 0; i < APPROVAL_PIN_MAX_FAILURES; i++) await withPin(makeApproval(k.id).id, "approve", "0000");
    expect((await list()).approval_pin_state).toBe("locked");
    expect((await withPin(makeApproval(k.id).id, "approve", "8426")).json().error).toBe("APPROVAL_PIN_LOCKED");

    await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "8426" } });
    expect((await list()).approval_pin_state).toBe("set");
    expect((await withPin(makeApproval(k.id).id, "approve", "8426")).statusCode).toBe(200);
  });

  it("is administrator only: no credentials, a MoneyKey, a PIN in the body are all 403 and change nothing", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "4821" });
    const before = stored(k.id).approvalPin;
    for (const headers of [{}, asKey(k.key)]) {
      const res = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers, payload: { approval_pin: "7396", pin: "4821" } });
      expect(res.statusCode).toBe(403);
    }
    expect(stored(k.id).approvalPin).toBe(before);
  });

  it("a child key has none to set (400 APPROVAL_PIN_CHILD_KEY)", async () => {
    t = await buildTestApp();
    const root = await createKey();
    const child = await t.app.inject({
      method: "POST",
      url: "/v1/keys/children",
      headers: asKey(root.key),
      payload: { name: "kid", daily_budget: "1", total_budget: "2", per_request_limit: "0.5" },
    });
    expect(child.statusCode).toBe(200);
    const res = await t.app.inject({ method: "POST", url: `/v1/keys/${child.json().id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "8426" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("APPROVAL_PIN_CHILD_KEY");
    expect(stored(child.json().id).approvalPin).toBeNull();
  });

  it("resetting the key's secret does not change the PIN and does not return one", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "9035" });
    const before = stored(k.id).approvalPin;
    const rotated = await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/rotate`, headers: asAdmin() });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().approval_pin).toBeUndefined();
    expect(stored(k.id).approvalPin).toBe(before);
    expect((await withPin(makeApproval(k.id).id, "approve", "9035")).statusCode).toBe(200);
  });
});

describe("child keys (/v1/keys/children, an AI calls it) never get a PIN", () => {
  it("the response has none, the body cannot set one, the row has none, and the key list marks it null", async () => {
    t = await buildTestApp();
    const root = await createKey();
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/keys/children",
      headers: asKey(root.key),
      payload: { name: "kid", daily_budget: "1", total_budget: "2", per_request_limit: "0.5", approval_pin: "9999" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/pin|9999|scrypt/i);
    expect(stored(res.json().id).approvalPin).toBeNull();
    expect(JSON.stringify((await t.app.inject({ method: "GET", url: "/v1/keys/children", headers: asKey(root.key) })).json())).not.toMatch(/pin|scrypt/i);
    const kid = ((await t.app.inject({ method: "GET", url: "/v1/keys", headers: asAdmin() })).json().keys as Array<{ id: string; approval_pin_state: unknown }>).find((x) => x.id === res.json().id)!;
    expect(kid.approval_pin_state).toBeNull();
    expect((kid as unknown as { approval_pin_failures: unknown }).approval_pin_failures).toBeNull();
  });

  it("a child's request is approved with the ROOT key's PIN, and only with it", async () => {
    t = await buildTestApp();
    const root = await createKey({ approval_pin: "4821" });
    const other = await createKey({ name: "other", approval_pin: "7396" });
    const child = (
      await t.app.inject({ method: "POST", url: "/v1/keys/children", headers: asKey(root.key), payload: { name: "kid", daily_budget: "1", total_budget: "2", per_request_limit: "0.5" } })
    ).json();
    const ap = makeApproval(child.id);
    expect((await withPin(ap.id, "approve", "7396")).json().error).toBe("APPROVAL_PIN_WRONG"); // another root key's PIN
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
    expect((await withPin(ap.id, "approve", "4821")).statusCode).toBe(200);
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("approved");
    expect(audit().find((e) => e.action === "approval.approve")!.actor).toBe(`pin:${root.id}`);
    expect(stored(other.id).approvalPinFailures).toBe(0); // the wrong try counted against the root key whose request it was
    expect(stored(root.id).approvalPinFailures).toBe(1); // ... and the right one reset nothing
  });
});

describe("approve / deny with a PIN and no login", () => {
  it("approves and denies the one request; the audit names pin:<root key id>, never admin or the PIN", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const a = makeApproval(k.id);
    const b = makeApproval(k.id, "0.20");
    expect((await withPin(a.id, "approve", "8426")).json()).toEqual({ id: a.id, status: "approved" });
    expect((await withPin(b.id, "deny", "8426")).json()).toEqual({ id: b.id, status: "denied" });
    const rows = audit().filter((e) => e.action.startsWith("approval."));
    expect(rows.map((r) => [r.actor, r.action]).sort()).toEqual([[`pin:${k.id}`, "approval.approve"], [`pin:${k.id}`, "approval.deny"]]);
    expect(JSON.stringify(audit())).not.toContain("8426");
  });

  it("the key itself can never approve: no Authorization is a 403, and a MoneyKey is a 403 even with the right PIN in the body", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = makeApproval(k.id);
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/approve` })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/approve`, headers: asKey(k.key) })).statusCode).toBe(403);
    for (const decision of ["approve", "deny"] as const) {
      expect((await withPin(ap.id, decision, "8426", asKey(k.key))).statusCode).toBe(403);
      expect((await withPin(ap.id, decision, "8426", { authorization: "Bearer ms_admin_wrong" })).statusCode).toBe(403);
    }
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
    expect(stored(k.id).approvalPinFailures).toBe(0);
  });

  it("a malformed PIN is a 400 that costs no try; an unknown request is 404 and a decided one APPROVAL_NOT_PENDING, also without costing one", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = makeApproval(k.id);
    for (const bad of ["12", "abcd", "1234567", 1234, null]) expect((await withPin(ap.id, "approve", bad)).json().error, JSON.stringify(bad)).toBe("APPROVAL_PIN_INVALID");
    expect((await withPin("00000000-0000-4000-8000-000000000000", "approve", "9999")).statusCode).toBe(404);
    expect((await withPin(ap.id, "approve", "8426")).statusCode).toBe(200);
    const again = await withPin(ap.id, "approve", "9999");
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("APPROVAL_NOT_PENDING");
    expect(stored(k.id).approvalPinFailures).toBe(0);
  });

  it("an expired request is no longer pending: a PIN decides nothing and costs no try", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = makeApproval(k.id);
    t.ctx.db.update(schema.approvals).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.approvals.id, ap.id)).run();
    const res = await withPin(ap.id, "approve", "8426");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("APPROVAL_NOT_PENDING");
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("expired");
  });

  it("wrong PINs count (attempts_left 4, 3, 2, 1), the fifth locks, then even the right PIN is refused; the administrator still decides; counted tries are audited", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = makeApproval(k.id);
    const left: unknown[] = [];
    for (let i = 1; i < APPROVAL_PIN_MAX_FAILURES; i++) {
      const res = await withPin(ap.id, "approve", "0000");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("APPROVAL_PIN_WRONG");
      left.push(res.json().attempts_left);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await withPin(ap.id, "approve", "0000");
    expect(fifth.statusCode).toBe(403);
    expect(fifth.json().error).toBe("APPROVAL_PIN_LOCKED");
    for (const pin of ["8426", "0000"]) {
      const res = await withPin(ap.id, "approve", pin);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("APPROVAL_PIN_LOCKED");
    }
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
    // the lock covers the whole key: its other requests, and its children's
    expect((await withPin(makeApproval(k.id).id, "deny", "8426")).json().error).toBe("APPROVAL_PIN_LOCKED");
    // the administrator is not locked out
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/approve`, headers: asAdmin() })).statusCode).toBe(200);
    const wrongTries = audit().filter((e) => e.action === "approval.pin_wrong");
    expect(wrongTries).toHaveLength(APPROVAL_PIN_MAX_FAILURES); // refused-while-locked tries are not counted, so not audited
    expect(wrongTries.every((e) => e.actor === "anonymous" && (e.detail as any).keyId === k.id)).toBe(true);
    expect(wrongTries.filter((e) => (e.detail as any).locked)).toHaveLength(1);
  });

  it("the count is cumulative since the PIN was set: four wrong, one right, the next wrong one LOCKS (a right PIN resets nothing; the AI cannot keep guessing after a person approves)", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const approvals = Array.from({ length: 4 }, () => makeApproval(k.id));
    for (let i = 0; i < 4; i++) await withPin(approvals[0].id, "approve", "0000");
    expect(stored(k.id).approvalPinFailures).toBe(4);
    expect((await withPin(approvals[0].id, "approve", "8426")).statusCode).toBe(200);
    expect(stored(k.id).approvalPinFailures).toBe(4); // the success changed nothing
    const fifth = await withPin(approvals[1].id, "approve", "0000");
    expect(fifth.statusCode).toBe(403);
    expect(fifth.json().error).toBe("APPROVAL_PIN_LOCKED");
    expect(stored(k.id).approvalPinFailures).toBe(5);
    // locked for the right PIN too, on every request of the key
    for (const id of [approvals[1].id, approvals[2].id]) {
      const res = await withPin(id, "approve", "8426");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("APPROVAL_PIN_LOCKED");
    }
    expect(getApproval(t.ctx.db, approvals[1].id)!.status).toBe("pending");
    // only the administrator setting a PIN opens it again, with the count back at 0
    expect((await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "8426" } })).statusCode).toBe(200);
    expect(stored(k.id).approvalPinFailures).toBe(0);
    expect((await withPin(approvals[1].id, "approve", "8426")).statusCode).toBe(200);
  });

  it("another key's PIN does not approve this key's request, and the tries count against the key that was attacked", async () => {
    t = await buildTestApp();
    const a = await createKey({ name: "a", approval_pin: "4821" });
    const b = await createKey({ name: "b", approval_pin: "7396" });
    const ap = makeApproval(a.id);
    expect((await withPin(ap.id, "approve", "7396")).json().error).toBe("APPROVAL_PIN_WRONG");
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
    expect(stored(a.id).approvalPinFailures).toBe(1);
    expect(stored(b.id).approvalPinFailures).toBe(0);
  });

  it("a key with no PIN (issued before v0.7.4): APPROVAL_PIN_NOT_SET, nothing counted; the administrator still approves", async () => {
    t = await buildTestApp();
    const k = await createKey();
    t.ctx.db.update(schema.moneyKeys).set({ approvalPin: null }).where(eq(schema.moneyKeys.id, k.id)).run();
    const ap = makeApproval(k.id);
    const res = await withPin(ap.id, "approve", "8426");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("APPROVAL_PIN_NOT_SET");
    expect(stored(k.id).approvalPinFailures).toBe(0);
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/approve`, headers: asAdmin() })).statusCode).toBe(200);
  });

  it("a revoked key refuses the PIN (APPROVAL_KEY_NOT_ACTIVE), and so does one whose parent was revoked", async () => {
    t = await buildTestApp();
    const root = await createKey({ approval_pin: "8426" });
    const child = (
      await t.app.inject({ method: "POST", url: "/v1/keys/children", headers: asKey(root.key), payload: { name: "kid", daily_budget: "1", total_budget: "2", per_request_limit: "0.5" } })
    ).json();
    const rootAp = makeApproval(root.id);
    const childAp = makeApproval(child.id);
    await t.app.inject({ method: "POST", url: `/v1/keys/${root.id}/revoke`, headers: asAdmin() });
    for (const ap of [rootAp, childAp]) {
      const res = await withPin(ap.id, "approve", "8426");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("APPROVAL_KEY_NOT_ACTIVE");
      expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
    }
    expect(stored(root.id).approvalPinFailures).toBe(0);
  });

  it("the administrator's flow is unchanged: no PIN needed, audit actor admin, an unknown id is still APPROVAL_NOT_PENDING (400)", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const a = makeApproval(k.id);
    const b = makeApproval(k.id);
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${a.id}/approve`, headers: asAdmin() })).json()).toEqual({ id: a.id, status: "approved" });
    expect((await t.app.inject({ method: "POST", url: `/v1/approvals/${b.id}/deny`, headers: asAdmin() })).json()).toEqual({ id: b.id, status: "denied" });
    expect(audit().filter((e) => e.action.startsWith("approval.")).map((e) => e.actor)).toEqual(["admin", "admin"]);
    const none = await t.app.inject({ method: "POST", url: "/v1/approvals/nope/approve", headers: asAdmin() });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe("APPROVAL_NOT_PENDING");
  });
});

describe("a new host approved with the PIN", () => {
  const hostApproval = (keyId: string, url = "https://api.newhost.example/v1/data?x=1") =>
    createHostApproval(t.ctx.sqlite, t.ctx.db, { keyId, url, method: "GET", body: undefined });

  it("the host joins the key's list; the audit names pin:<key id> for both rows", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = hostApproval(k.id);
    const res = await withPin(ap.id, "approve", "8426");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ap.id, status: "approved" });
    expect(stored(k.id).allowedHosts).toEqual(["known.example:443", "api.newhost.example:443"]);
    const rows = audit().filter((e) => e.action === "key.allow_host" || e.action === "approval.approve");
    expect(rows.map((r) => [r.actor, r.action]).sort()).toEqual([[`pin:${k.id}`, "approval.approve"], [`pin:${k.id}`, "key.allow_host"]]);
  });

  it("a wrong PIN adds nothing; denying with the PIN adds nothing", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = hostApproval(k.id);
    expect((await withPin(ap.id, "approve", "0000")).statusCode).toBe(403);
    expect(stored(k.id).allowedHosts).toEqual(["known.example:443"]);
    expect((await withPin(ap.id, "deny", "8426")).statusCode).toBe(200);
    expect(stored(k.id).allowedHosts).toEqual(["known.example:443"]);
  });

  it("the rules do not change: a child key's list cannot be widened (ALLOW_HOST_CHILD_KEY), the approval stays pending", async () => {
    t = await buildTestApp();
    const root = await createKey({ approval_pin: "8426" });
    const child = (
      await t.app.inject({ method: "POST", url: "/v1/keys/children", headers: asKey(root.key), payload: { name: "kid", daily_budget: "1", total_budget: "2", per_request_limit: "0.5" } })
    ).json();
    const ap = hostApproval(child.id);
    const res = await withPin(ap.id, "approve", "8426");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ALLOW_HOST_CHILD_KEY");
    expect(getApproval(t.ctx.db, ap.id)!.status).toBe("pending");
  });
});

describe("GET /v1/approvals?id=<approval id>: the approval link, no login", () => {
  it("answers that one request (what the card shows), and no other request, no key id, no PIN or hash", async () => {
    t = await buildTestApp();
    const k = await createKey({ name: "Alice's agent", approval_pin: "8426" });
    const mine = makeApproval(k.id, "0.15");
    const other = makeApproval((await createKey({ name: "someone else" })).id, "0.30");
    const res = await t.app.inject({ method: "GET", url: `/v1/approvals?id=${mine.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      approval: {
        id: mine.id,
        key_name: "Alice's agent",
        url: "https://known.example/paid?x=1",
        method: "GET",
        network: "eip155:10143",
        network_kind: expect.stringMatching(/^(testnet|mainnet)$/),
        network_label: expect.any(String),
        asset: "0x0000000000000000000000000000000000000001",
        pay_to: "0x0000000000000000000000000000000000000002",
        amount: "0.15",
        status: "pending",
        kind: "payment",
        pin_state: "set",
        pin_failures: 0,
        expires_at: mine.expiresAt,
        decided_at: null,
        created_at: mine.createdAt,
      },
    });
    const text = res.body;
    expect(text).not.toContain(other.id);
    expect(text).not.toContain(k.id);
    expect(text).not.toMatch(/scrypt|1234|mk_live_/);
  });

  it("says what became of it: decided and expired requests are shown as such; a new host shows its host:port; pin_state tells locked and none", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "8426" });
    const ap = makeApproval(k.id);
    await withPin(ap.id, "deny", "8426");
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals?id=${ap.id}` })).json().approval).toMatchObject({ status: "denied", decided_at: expect.any(String) });

    const host = createHostApproval(t.ctx.sqlite, t.ctx.db, { keyId: k.id, url: "https://api.newhost.example/v1/data", method: "GET", body: undefined });
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals?id=${host.id}` })).json().approval).toMatchObject({ kind: "host", host: "api.newhost.example:443", amount: "0", status: "pending" });
    t.ctx.db.update(schema.approvals).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.approvals.id, host.id)).run();
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals?id=${host.id}` })).json().approval.status).toBe("expired");

    const pending = makeApproval(k.id);
    for (let i = 0; i < APPROVAL_PIN_MAX_FAILURES; i++) await withPin(pending.id, "approve", "0000");
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals?id=${pending.id}` })).json().approval.pin_state).toBe("locked");
    t.ctx.db.update(schema.moneyKeys).set({ approvalPin: null }).where(eq(schema.moneyKeys.id, k.id)).run();
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals?id=${pending.id}` })).json().approval.pin_state).toBe("none");
  });

  it("shows how many wrong tries the PIN has had since it was set (and keeps attempts_left in the wrong-PIN answer); a right PIN does not take them back", async () => {
    t = await buildTestApp();
    const k = await createKey({ approval_pin: "4821" });
    const ap = makeApproval(k.id);
    const failures = async () => (await t.app.inject({ method: "GET", url: `/v1/approvals?id=${ap.id}` })).json().approval.pin_failures;
    expect(await failures()).toBe(0);
    const wrong = await withPin(ap.id, "approve", "0000");
    expect(wrong.json()).toMatchObject({ error: "APPROVAL_PIN_WRONG", attempts_left: 4 });
    expect(await failures()).toBe(1);
    await withPin(ap.id, "approve", "0000");
    expect(await failures()).toBe(2);
    const other = makeApproval(k.id);
    expect((await withPin(other.id, "approve", "4821")).statusCode).toBe(200);
    expect(await failures()).toBe(2);
    const row = ((await t.app.inject({ method: "GET", url: "/v1/keys", headers: asAdmin() })).json().keys as Array<{ id: string; approval_pin_failures: number | null }>).find((x) => x.id === k.id)!;
    expect(row.approval_pin_failures).toBe(2);
    await t.app.inject({ method: "POST", url: `/v1/keys/${k.id}/approval-pin`, headers: asAdmin(), payload: { approval_pin: "4821" } });
    expect(await failures()).toBe(0);
  });

  it("an unknown id is 404; the list itself (no id) still needs the administrator", async () => {
    t = await buildTestApp();
    const k = await createKey();
    const ap = makeApproval(k.id);
    expect((await t.app.inject({ method: "GET", url: "/v1/approvals?id=00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: "/v1/approvals?id=a&id=b" })).statusCode).toBe(404);
    for (const url of ["/v1/approvals", "/v1/approvals?status=pending"]) {
      expect((await t.app.inject({ method: "GET", url })).statusCode, url).toBe(403);
      expect((await t.app.inject({ method: "GET", url, headers: asKey(k.key) })).statusCode, url).toBe(403);
    }
    const list = await t.app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: asAdmin() });
    expect(list.statusCode).toBe(200);
    expect(list.json().approvals).toEqual([expect.objectContaining({ id: ap.id, key_id: k.id, status: "pending", kind: "payment" })]);
  });

  it("the AI's own poll, GET /v1/approvals/:id with its key, is unchanged", async () => {
    t = await buildTestApp();
    const k = await createKey();
    const ap = makeApproval(k.id);
    const poll = await t.app.inject({ method: "GET", url: `/v1/approvals/${ap.id}`, headers: asKey(k.key) });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({ id: ap.id, status: "pending", kind: "payment", amount: "0.15", currency: "USDC" });
    expect(JSON.stringify(poll.json())).not.toMatch(/pin/i);
    expect((await t.app.inject({ method: "GET", url: `/v1/approvals/${ap.id}` })).statusCode).toBe(401);
  });
});
