// usePolling: a response is applied only if no NEWER request has already been applied. The Wallet page depends on it: a poll fired before
// "Replace wallet" and answering after the page already learned about the new wallet must not put the old wallet back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Poller, type PollState } from "../src/usePolling.ts";

/** A fetcher whose answers the test releases by hand, in any order. */
function controlled<T>() {
  const pending: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  const fetcher = () => new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  return { fetcher, pending };
}

function poller<T>(fetcher: () => Promise<T>) {
  const seen: Array<PollState<T>> = [];
  return { poller: new Poller<T>(fetcher, (s) => seen.push(s)), seen };
}

describe("Poller: answers are applied in the order the requests were made", () => {
  it("starts loading with nothing; the first answer fills it in", async () => {
    const c = controlled<string>();
    const { poller: p, seen } = poller(c.fetcher);
    assert.deepEqual(p.state, { data: null, error: null, loading: true });
    const run = p.run();
    c.pending[0]!.resolve("A");
    await run;
    assert.deepEqual(p.state, { data: "A", error: null, loading: false });
    assert.equal(seen.length, 1);
  });

  it("answers that come back in order are all applied", async () => {
    const c = controlled<string>();
    const { poller: p } = poller(c.fetcher);
    const first = p.run();
    const second = p.run();
    c.pending[0]!.resolve("one");
    await first;
    assert.equal(p.state.data, "one");
    c.pending[1]!.resolve("two");
    await second;
    assert.equal(p.state.data, "two");
  });

  it("THE RACE: a poll made before the swap answers after the refresh that learned about the new wallet - it is dropped", async () => {
    const c = controlled<{ address: string }>();
    const { poller: p, seen } = poller(c.fetcher);
    const preSwap = p.run(); // the 3-second poll, in flight when "Replace wallet" is clicked
    const refresh = p.run(); // the refresh the page makes after the replace answered
    c.pending[1]!.resolve({ address: "0xNEW" });
    await refresh;
    assert.deepEqual(p.state.data, { address: "0xNEW" });
    c.pending[0]!.resolve({ address: "0xOLD" }); // the old answer, late
    await preSwap;
    assert.deepEqual(p.state.data, { address: "0xNEW" }, "the old wallet is not put back");
    assert.equal(seen.length, 1, "and nothing was re-rendered for it");
  });

  it("a late FAILURE of an older request does not overwrite the newer answer either", async () => {
    const c = controlled<string>();
    const { poller: p } = poller(c.fetcher);
    const old = p.run();
    const fresh = p.run();
    c.pending[1]!.resolve("fresh");
    await fresh;
    c.pending[0]!.reject(new Error("socket hang up"));
    await old;
    assert.deepEqual(p.state, { data: "fresh", error: null, loading: false });
  });

  it("a newer failure keeps the last data and reports the error; a later success clears it", async () => {
    const c = controlled<string>();
    const { poller: p } = poller(c.fetcher);
    const a = p.run();
    c.pending[0]!.resolve("A");
    await a;
    const b = p.run();
    c.pending[1]!.reject(new Error("offline"));
    await b;
    assert.deepEqual(p.state, { data: "A", error: "offline", loading: false });
    const d = p.run();
    c.pending[2]!.resolve("B");
    await d;
    assert.deepEqual(p.state, { data: "B", error: null, loading: false });
  });
});

describe("Poller: a slow request is not stacked on", () => {
  /** A fetcher that counts how many requests were actually made. */
  function counted<T>() {
    const c = controlled<T>();
    let calls = 0;
    return { ...c, fetcher: () => (calls++, c.fetcher()), calls: () => calls };
  }

  it("scheduled polls that arrive while the request is still unanswered make no request at all", async () => {
    const c = counted<string>();
    const { poller: p } = poller(c.fetcher);
    const first = p.run(); // the first poll: the server is slow
    await p.tick(); // 3 intervals go by with no answer
    await p.tick();
    await p.tick();
    assert.equal(c.calls(), 1, "still the one request");
    c.pending[0]!.resolve("A");
    await first;
    assert.equal(p.state.data, "A");
  });

  it("once the slow request is answered, the next scheduled poll goes out again", async () => {
    const c = counted<string>();
    const { poller: p } = poller(c.fetcher);
    const first = p.tick();
    await p.tick();
    assert.equal(c.calls(), 1);
    c.pending[0]!.resolve("A");
    await first;
    const second = p.tick();
    assert.equal(c.calls(), 2, "the answer freed the slot");
    c.pending[1]!.resolve("B");
    await second;
    assert.equal(p.state.data, "B");
  });

  it("a request that FAILS frees the slot too: polling does not stop after an error", async () => {
    const c = counted<string>();
    const { poller: p } = poller(c.fetcher);
    const first = p.tick();
    c.pending[0]!.reject(new Error("offline"));
    await first;
    const second = p.tick();
    assert.equal(c.calls(), 2);
    c.pending[1]!.resolve("back");
    await second;
    assert.deepEqual(p.state, { data: "back", error: null, loading: false });
  });

  it("a deliberate refresh is never skipped, even with a poll in flight (the swap race above depends on it)", async () => {
    const c = counted<string>();
    const { poller: p } = poller(c.fetcher);
    const poll = p.tick();
    const refresh = p.run();
    assert.equal(c.calls(), 2, "both went out");
    c.pending[1]!.resolve("fresh");
    await refresh;
    c.pending[0]!.resolve("stale");
    await poll;
    assert.equal(p.state.data, "fresh");
  });

  it("while a refresh is in flight, a scheduled poll waits for it too", async () => {
    const c = counted<string>();
    const { poller: p } = poller(c.fetcher);
    const refresh = p.run();
    await p.tick();
    assert.equal(c.calls(), 1);
    c.pending[0]!.resolve("A");
    await refresh;
  });
});
