// The "Reset secret and copy skill" state transition and its API call, without a DOM.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { RotateKeyResponse } from "../src/api.ts";
import { handoffFromCreated, handoffFromRotated, rotateToHandoff } from "../src/keyHandoff.ts";

const OLD_KEY = "mk_live_OLDsecretOLDsecretOLDsecret0000";
const NEW_KEY = "mk_live_NEWsecretNEWsecretNEWsecret1111";

const rotatedResponse = (over: Partial<RotateKeyResponse> = {}): RotateKeyResponse => ({
  id: "key-1",
  key: NEW_KEY,
  name: "Codex",
  key_prefix: NEW_KEY.slice(0, 12),
  parent_id: null,
  depth: 0,
  ...over,
});

describe("rotateToHandoff", () => {
  it("hands over the NEW secret as a 'rotated' handoff and asks the API for exactly that key id", async () => {
    const asked: string[] = [];
    const outcome = await rotateToHandoff("key-1", async (id) => {
      asked.push(id);
      return rotatedResponse();
    });
    assert.deepEqual(asked, ["key-1"]);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.handoff.kind, "rotated");
    assert.equal(outcome.handoff.key, NEW_KEY);
    assert.equal(outcome.handoff.name, "Codex");
    assert.notEqual(outcome.handoff.key, OLD_KEY);
  });

  it("replaces a previously created key: the page holds ONE handoff, so the old (dead) secret cannot be shown next to it", async () => {
    let handoff = handoffFromCreated({ key: OLD_KEY, name: "Codex" });
    assert.equal(handoff.kind, "created");
    assert.equal(handoff.key, OLD_KEY);
    const outcome = await rotateToHandoff("key-1", async () => rotatedResponse());
    if (outcome.ok) handoff = outcome.handoff;
    assert.equal(handoff.key, NEW_KEY);
    assert.equal(handoff.kind, "rotated");
  });

  it("on failure nothing is handed over and the message is passed on", async () => {
    const failed = await rotateToHandoff("key-1", async () => {
      throw new Error("a revoked key cannot be reset; create a new key instead");
    });
    assert.deepEqual(failed, { ok: false, message: "a revoked key cannot be reset; create a new key instead" });
    const odd = await rotateToHandoff("key-1", async () => {
      throw "boom";
    });
    assert.deepEqual(odd, { ok: false, message: "rotate_failed" });
  });

  it("every handoff has its own id (the React key that restarts the view on the skill tab)", () => {
    const a = handoffFromCreated({ key: OLD_KEY, name: "a" });
    const b = handoffFromRotated({ key: NEW_KEY, name: "a" });
    const c = handoffFromRotated({ key: NEW_KEY, name: "a" });
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  });
});

describe("rotateKey (api.ts)", () => {
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  let call: { url: string; init: RequestInit } | null = null;

  before(() => {
    Object.assign(globalThis, {
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    store.set("moneyswitch_admin_token", "ms_admin_testtoken");
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      call = { url, init };
      return new Response(JSON.stringify(rotatedResponse({ id: "a b/c" })), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("POSTs /v1/keys/<id>/rotate with the admin token and no body (an empty JSON body is rejected by the server)", async () => {
    const { rotateKey } = await import("../src/api.ts");
    const res = await rotateKey("a b/c");
    assert.equal(res.key, NEW_KEY);
    assert.ok(call);
    assert.equal(call!.url, "/v1/keys/a%20b%2Fc/rotate");
    assert.equal(call!.init.method, "POST");
    const headers = call!.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer ms_admin_testtoken");
    assert.equal(headers["Content-Type"], undefined);
    assert.equal(call!.init.body, undefined);
  });
});
