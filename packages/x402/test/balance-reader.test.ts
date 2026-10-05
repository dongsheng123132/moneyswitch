import { describe, it, expect, afterEach, vi } from "vitest";
import { BALANCE_CACHE_MS, BALANCE_FAILURE_CACHE_MS, BALANCE_TIMEOUT_MS, createBalanceReader } from "../src/balance.js";
import { BASE_SEPOLIA, TESTNET } from "../src/networks.js";

/**
 * createBalanceReader is the cache + deadline in front of the wallet's RPC read (SPEC.md §6): a balance is reused for at most 15 s per
 * (network, address), one read waits at most about 3 s (and its request is aborted then), and a read that failed is "unknown" (null) -
 * remembered for 2 s only - never an exception. The raw read is always a fake here: nothing in this file touches an RPC.
 */

const ADDRESS = "0x00000000000000000000000000000000000000aB";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBalanceReader", () => {
  it("defaults to the SPEC numbers: 15 s of cache, a 3 s deadline, a failure remembered for 2 s (the wallet page's number)", () => {
    expect(BALANCE_CACHE_MS).toBe(15_000);
    expect(BALANCE_TIMEOUT_MS).toBe(3_000);
    expect(BALANCE_FAILURE_CACHE_MS).toBe(2_000);
  });

  it("reuses a read for the same (network, address) until 15 s have passed, then reads again", async () => {
    let clock = 1_000_000;
    let onChain = 7n;
    const read = vi.fn(async () => onChain);
    const reader = createBalanceReader(read, { now: () => clock });

    expect(await reader(ADDRESS, TESTNET)).toBe(7n);
    onChain = 9n; // the chain moves, the cache does not know
    clock += BALANCE_CACHE_MS - 1;
    expect(await reader(ADDRESS, TESTNET)).toBe(7n);
    expect(read).toHaveBeenCalledTimes(1);

    clock += 1; // exactly 15 s old: expired
    expect(await reader(ADDRESS, TESTNET)).toBe(9n);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by network and by address (case-insensitively)", async () => {
    const read = vi.fn(async (address: string, network: { caip2: string }) => BigInt(address.length + network.caip2.length));
    const reader = createBalanceReader(read);
    await reader(ADDRESS, TESTNET);
    await reader(ADDRESS.toLowerCase(), TESTNET); // same address, other spelling: a cache hit
    expect(read).toHaveBeenCalledTimes(1);
    await reader(ADDRESS, BASE_SEPOLIA); // other chain: its own read
    await reader("0x00000000000000000000000000000000000000cD", TESTNET); // other address: its own read
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives null for a read that failed, and remembers the failure for 2 s only (not for the 15 s a balance is kept)", async () => {
    let clock = 1_000_000;
    const read = vi.fn<() => Promise<bigint>>().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(5n);
    const reader = createBalanceReader(read, { now: () => clock });
    expect(await reader(ADDRESS, TESTNET)).toBeNull();
    clock += BALANCE_FAILURE_CACHE_MS - 1;
    expect(await reader(ADDRESS, TESTNET), "inside 2 s: still 'unknown', no new read").toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await reader(ADDRESS, TESTNET), "2 s after the failure: asked again").toBe(5n);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("the failure memory is per (network, address): another chain is still read", async () => {
    const read = vi.fn<(address: string, network: { caip2: string }) => Promise<bigint>>(async (_address, network) => {
      if (network.caip2 === TESTNET.caip2) throw new Error("rpc down");
      return 8n;
    });
    const reader = createBalanceReader(read);
    expect(await reader(ADDRESS, TESTNET)).toBeNull();
    expect(await reader(ADDRESS, BASE_SEPOLIA)).toBe(8n);
    expect(await reader(ADDRESS, TESTNET)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a read that succeeds ends the failure memory; the answer it brings is cached as usual", async () => {
    let clock = 1_000_000;
    const read = vi.fn<() => Promise<bigint>>().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(5n);
    const reader = createBalanceReader(read, { now: () => clock });
    await reader(ADDRESS, TESTNET);
    clock += BALANCE_FAILURE_CACHE_MS;
    expect(await reader(ADDRESS, TESTNET)).toBe(5n);
    clock += 1;
    expect(await reader(ADDRESS, TESTNET)).toBe(5n);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives null for a raw read that throws before it returns a promise", async () => {
    const reader = createBalanceReader(() => {
      throw new Error("boom");
    });
    expect(await reader(ADDRESS, TESTNET)).toBeNull();
  });

  it("gives null once a read has not answered in 3 s, and a late answer is not cached", async () => {
    vi.useFakeTimers();
    const answers: Array<(v: bigint) => void> = [];
    const read = vi.fn(() => new Promise<bigint>((resolve) => answers.push(resolve)));
    const reader = createBalanceReader(read);

    let result: bigint | null | undefined;
    void reader(ADDRESS, TESTNET).then((v) => (result = v));
    await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS - 1);
    expect(result, "still waiting at 2.999 s").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result, "given up at 3 s").toBeNull();

    answers[0](42n); // too late
    await vi.advanceTimersByTimeAsync(0);
    expect(await reader(ADDRESS, TESTNET), "the late answer was not kept (the timeout itself is remembered, see below)").toBeNull();
    await vi.advanceTimersByTimeAsync(BALANCE_FAILURE_CACHE_MS);
    const second = reader(ADDRESS, TESTNET);
    expect(read, "once the failure memory has expired the next ask reads again").toHaveBeenCalledTimes(2);
    answers[1](5n);
    expect(await second).toBe(5n);
  });

  describe("an RPC that never answers", () => {
    /** A raw read that hangs until its signal is aborted - what a real fetch does. */
    function hangingRead() {
      const signals: AbortSignal[] = [];
      const read = vi.fn((_address: string, _network: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<bigint>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      });
      return { read, signals };
    }

    it("has its underlying request aborted at the deadline, not left hanging", async () => {
      vi.useFakeTimers();
      const { read, signals } = hangingRead();
      const reader = createBalanceReader(read);
      const result = reader(ADDRESS, TESTNET);
      await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS - 1);
      expect(signals[0].aborted, "not before the deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted, "aborted at 3 s").toBe(true);
      expect(await result).toBeNull();
    });

    it("does not abort a read that answered in time", async () => {
      const signals: AbortSignal[] = [];
      const reader = createBalanceReader(async (_address, _network, signal) => {
        signals.push(signal);
        return 1n;
      });
      await reader(ADDRESS, TESTNET);
      expect(signals[0].aborted).toBe(false);
    });

    it("is not waited for again by a second request within 2 s of the timeout: that one answers null at once, with no new read", async () => {
      vi.useFakeTimers();
      const { read } = hangingRead();
      const reader = createBalanceReader(read);
      void reader(ADDRESS, TESTNET);
      await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS); // the first request has now waited out its 3 s

      await vi.advanceTimersByTimeAsync(BALANCE_FAILURE_CACHE_MS - 1);
      // The clock is frozen here: an ask that waited out a 3 s deadline would never settle, so this await returning at all is the proof.
      expect(await reader(ADDRESS, TESTNET)).toBeNull();
      expect(read, "no second request to the dead RPC").toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1); // 2 s after the timeout: the chain is tried again
      void reader(ADDRESS, TESTNET);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS);
    });
  });

  it("leaves no timer behind once a read has answered", async () => {
    vi.useFakeTimers();
    const reader = createBalanceReader(async () => 1n);
    await reader(ADDRESS, TESTNET);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets callers that ask while a read is under way share it", async () => {
    let answer!: (v: bigint) => void;
    const read = vi.fn(() => new Promise<bigint>((resolve) => (answer = resolve)));
    const reader = createBalanceReader(read);
    const both = Promise.all([reader(ADDRESS, TESTNET), reader(ADDRESS, TESTNET)]);
    answer(3n);
    expect(await both).toEqual([3n, 3n]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  describe("forget (the wallet just spent from that (network, address))", () => {
    it("drops what is remembered for that (network, address) so the next ask reads the chain, and leaves every other key alone", async () => {
      let onChain = 10n;
      const read = vi.fn(async () => onChain);
      const reader = createBalanceReader(read);
      const other = "0x00000000000000000000000000000000000000cD";
      await reader(ADDRESS, TESTNET);
      await reader(ADDRESS, BASE_SEPOLIA);
      await reader(other, TESTNET);
      expect(read).toHaveBeenCalledTimes(3);

      onChain = 4n; // the payment moved the money
      reader.forget!(ADDRESS.toLowerCase(), TESTNET); // same address, other spelling: the same key
      expect(await reader(ADDRESS, TESTNET)).toBe(4n);
      expect(read).toHaveBeenCalledTimes(4);
      expect(await reader(ADDRESS, BASE_SEPOLIA)).toBe(10n); // the other chain was not spent from: still cached
      expect(await reader(other, TESTNET)).toBe(10n); // the other address: still cached
      expect(read).toHaveBeenCalledTimes(4);
    });

    it("also drops a remembered failure, so the next ask reads the chain at once", async () => {
      const read = vi.fn<() => Promise<bigint>>().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(6n);
      const reader = createBalanceReader(read);
      expect(await reader(ADDRESS, TESTNET)).toBeNull();
      reader.forget!(ADDRESS, TESTNET);
      expect(await reader(ADDRESS, TESTNET)).toBe(6n);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("forgetting something that is not remembered does nothing", async () => {
      const read = vi.fn(async () => 1n);
      const reader = createBalanceReader(read);
      reader.forget!(ADDRESS, TESTNET);
      expect(await reader(ADDRESS, TESTNET)).toBe(1n);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("a read already under way at the time is answered to its waiters but not cached, and a later ask does not share it", async () => {
      const answers: Array<(v: bigint) => void> = [];
      const read = vi.fn(() => new Promise<bigint>((resolve) => answers.push(resolve)));
      const reader = createBalanceReader(read);

      const early = reader(ADDRESS, TESTNET); // started before the payment
      reader.forget!(ADDRESS, TESTNET);
      const late = reader(ADDRESS, TESTNET); // asked after it
      expect(read, "the late ask reads for itself").toHaveBeenCalledTimes(2);

      answers[0](10n); // the old number: from before the payment
      expect(await early).toBe(10n);
      answers[1](4n);
      expect(await late).toBe(4n);
      expect(await reader(ADDRESS, TESTNET), "what stays cached is the read made after the forget, not the older one").toBe(4n);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("a read under way at the time of the forget does not overwrite what a later read cached, whichever answers last", async () => {
      const answers: Array<(v: bigint) => void> = [];
      const read = vi.fn(() => new Promise<bigint>((resolve) => answers.push(resolve)));
      const reader = createBalanceReader(read);

      const early = reader(ADDRESS, TESTNET);
      reader.forget!(ADDRESS, TESTNET);
      const late = reader(ADDRESS, TESTNET);
      answers[1](4n); // the post-payment read answers first ...
      await late;
      answers[0](10n); // ... the pre-payment one limps in after it
      await early;
      expect(await reader(ADDRESS, TESTNET)).toBe(4n);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
