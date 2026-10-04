// usePolling skips a scheduled tick while a request is in flight, so a GET that never answers must not hold that slot forever:
// every GET carries a timeout signal; requests that change something (POST) are never cut short by the client.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { localStorage: fakeStorage, sessionStorage: fakeStorage });

const { GET_TIMEOUT_MS, listBills, revokeKey } = await import("../src/api.ts");

describe("request timeout", () => {
  it("a GET gets a timeout signal; a POST does not", async () => {
    const real = globalThis.fetch;
    const seen: Array<{ url: string; method?: string; signal?: AbortSignal | null }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, signal: init.signal });
      const body = init.method === "POST" ? { id: "k1", revoked: true } : { payments: [], truncated: false, total: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await listBills();
      await revokeKey("k1");
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(GET_TIMEOUT_MS, 30_000);
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.signal instanceof AbortSignal, "the GET carries a signal");
    assert.equal(seen[0]!.signal!.aborted, false);
    assert.equal(seen[1]!.method, "POST");
    assert.equal(seen[1]!.signal ?? null, null, "the POST carries no client timeout");
  });

  it("a GET that never answers is aborted, so the caller sees an error instead of waiting forever", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 10);
    try {
      await assert.rejects(listBills(), (e: Error) => e.name === "TimeoutError");
    } finally {
      globalThis.fetch = real;
      AbortSignal.timeout = realTimeout;
    }
  });
});
