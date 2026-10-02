import { describe, it, expect } from "vitest";
import { openDb } from "@moneyswitch/db";
import {
  createMoneyKey,
  parseUsdcToMicros,
  evaluateAndReserve,
  markUnknown,
  recordPaymentAuthorization,
  getPayment,
  reconcileUnknownPayments,
  type AuthorizationReader,
} from "@moneyswitch/core";
import {
  AUTHORIZATION_USED_TOPIC0,
  authorizationUsedTopics,
  findAuthorizationUsedTxViaLogs,
  scanOptionsFromEnv,
  type LogRpc,
} from "../src/authorization-logs.js";

const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const PAYER = "0xFEd3f24cee2B3E2d94ad9f561ead4fEA589Ce2e3";
const NONCE = "0xfc281e68c76cc763e374b879725e8609fd844d52c7d0e3aa63a07a7ca5c31669";
const OTHER_NONCE = "0x" + "ab".repeat(32);
const TX = "0x20b9a9edf1224809ce5be9e448b6033660447035cfbc5d19252d8c292b6088ff";

interface FakeTx {
  block: bigint;
  authorizer: string;
  nonce: string;
  txHash: string;
}

/**
 * A fake chain with a constant block time and the same getLogs range cap as
 * the public Monad testnet RPC ("eth_getLogs is limited to a 100 range").
 * Records every call so tests can assert on chunking and the call budget.
 */
function fakeChain(opts: {
  latestBlock: bigint;
  latestTimestampSec: number;
  blockTimeSec: number;
  txs: FakeTx[];
  maxRange?: number;
  failFirstGetLogs?: boolean;
}) {
  const calls = { latest: 0, blockTs: 0, getLogs: 0 };
  const ranges: Array<{ from: bigint; to: bigint; topics: Array<string | null> }> = [];
  const maxRange = BigInt(opts.maxRange ?? 100);
  const tsOf = (n: bigint) => Math.floor(opts.latestTimestampSec - Number(opts.latestBlock - n) * opts.blockTimeSec);
  const rpc: LogRpc = {
    async getLatestBlock() {
      calls.latest++;
      return { number: opts.latestBlock, timestampSec: opts.latestTimestampSec };
    },
    async getBlockTimestampSec(n) {
      calls.blockTs++;
      if (n < 0n || n > opts.latestBlock) throw new Error("block out of range");
      return tsOf(n);
    },
    async getLogs({ address, fromBlock, toBlock, topics }) {
      calls.getLogs++;
      ranges.push({ from: fromBlock, to: toBlock, topics });
      if (opts.failFirstGetLogs && calls.getLogs === 1) throw new Error("transient rpc failure");
      if (toBlock - fromBlock > maxRange) throw new Error("eth_getLogs is limited to a 100 range");
      expect(address).toBe(USDC);
      return opts.txs
        .filter((t) => t.block >= fromBlock && t.block <= toBlock)
        .filter((t) => topics[0] === AUTHORIZATION_USED_TOPIC0)
        .filter((t) => topics[1] === "0x" + t.authorizer.slice(2).toLowerCase().padStart(64, "0"))
        .filter((t) => topics[2] === null || topics[2] === t.nonce.toLowerCase())
        .map((t) => ({ transactionHash: t.txHash, blockNumber: t.block }));
    },
  };
  return { rpc, calls, ranges, tsOf, total: () => calls.latest + calls.blockTs + calls.getLogs };
}

describe("AuthorizationUsed topics", () => {
  it("topic0 is the keccak of AuthorizationUsed(address,bytes32) (the standard USDC event id)", () => {
    expect(AUTHORIZATION_USED_TOPIC0).toBe("0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5");
  });

  it("filter is [event sig, authorizer left-padded to 32 bytes (lowercase), nonce]", () => {
    expect(authorizationUsedTopics(PAYER, NONCE)).toEqual([
      "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
      "0x000000000000000000000000fed3f24cee2b3e2d94ad9f561ead4fea589ce2e3",
      NONCE,
    ]);
    expect(authorizationUsedTopics(PAYER)[2]).toBeNull();
  });
});

describe("findAuthorizationUsedTxViaLogs (fake RPC)", () => {
  const NOW_SEC = 1_790_000_000;

  it("finds the tx hash of a payment made two days before chain head, in <=100-block chunks, within the call cap", async () => {
    const created = NOW_SEC - 2 * 86400;
    // the tx is mined ~7s after creation; block time 0.4s
    const latestBlock = 70_000_000n;
    const txBlock = latestBlock - BigInt(Math.round((NOW_SEC - created - 7) / 0.4));
    const chain2 = fakeChain({
      latestBlock,
      latestTimestampSec: NOW_SEC,
      blockTimeSec: 0.4,
      txs: [{ block: txBlock, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });

    const hash = await findAuthorizationUsedTxViaLogs(
      chain2.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 60 },
      {}
    );
    expect(hash).toBe(TX);
    expect(chain2.ranges.length).toBeGreaterThan(0);
    for (const r of chain2.ranges) expect(r.to - r.from).toBeLessThanOrEqual(99n);
    expect(chain2.total()).toBeLessThanOrEqual(60);
    // topics passed to the RPC are the real filter
    expect(chain2.ranges[0].topics).toEqual(authorizationUsedTopics(PAYER, NONCE));
  });

  it("still finds it when the real block time is far from the initial guess (interpolation corrects it)", async () => {
    const created = NOW_SEC - 3 * 86400;
    const latestBlock = 5_000_000n;
    const blockTimeSec = 1.0; // initial guess is 0.5s
    const txBlock = latestBlock - BigInt(Math.round((NOW_SEC - created - 12) / blockTimeSec));
    const chain = fakeChain({
      latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec,
      txs: [{ block: txBlock, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 120 },
      {}
    );
    expect(hash).toBe(TX);
    expect(chain.total()).toBeLessThanOrEqual(60);
  });

  it("finds a recent payment (window reaches the chain head)", async () => {
    const created = NOW_SEC - 100;
    const latestBlock = 1_000_000n;
    const txBlock = latestBlock - 100n;
    const chain = fakeChain({
      latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4,
      txs: [{ block: txBlock, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: NOW_SEC + 500 },
      {}
    );
    expect(hash).toBe(TX);
  });

  it("does not return a log for a different nonce or a different authorizer", async () => {
    const created = NOW_SEC - 600;
    const latestBlock = 1_000_000n;
    const txBlock = latestBlock - 1000n;
    const chain = fakeChain({
      latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4,
      txs: [
        { block: txBlock, authorizer: PAYER, nonce: OTHER_NONCE, txHash: "0x" + "01".repeat(32) },
        { block: txBlock + 1n, authorizer: "0x" + "22".repeat(20), nonce: NONCE, txHash: "0x" + "02".repeat(32) },
      ],
    });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 600 },
      {}
    );
    expect(hash).toBeNull();
  });

  it("caps total RPC calls (huge validBefore window) and returns null instead of scanning forever", async () => {
    const created = NOW_SEC - 86400;
    const chain = fakeChain({ latestBlock: 70_000_000n, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4, txs: [] });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      // validBefore a year ahead: window is millions of blocks
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 365 * 86400 },
      { maxRpcCalls: 15 }
    );
    expect(hash).toBeNull();
    expect(chain.total()).toBeLessThanOrEqual(15);
    expect(chain.calls.getLogs).toBeGreaterThan(0);
  });

  it("chunk size is configurable and respected", async () => {
    const created = NOW_SEC - 600;
    const latestBlock = 1_000_000n;
    const chain = fakeChain({ latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4, txs: [] });
    await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 60 },
      { chunkBlocks: 25 }
    );
    expect(chain.ranges.length).toBeGreaterThan(3);
    for (const r of chain.ranges) expect(r.to - r.from).toBeLessThanOrEqual(24n);
    // consecutive, non-overlapping chunks
    for (let i = 1; i < chain.ranges.length; i++) expect(chain.ranges[i].from).toBe(chain.ranges[i - 1].to + 1n);
  });

  it("stops scanning at the first hit (no wasted calls after it)", async () => {
    const created = NOW_SEC - 600;
    const latestBlock = 1_000_000n;
    const startBlock = latestBlock - BigInt(Math.round(600 / 0.4));
    const chain = fakeChain({
      latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4,
      // 5s after creation => early in the window
      txs: [{ block: startBlock + 12n, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 590 },
      {}
    );
    expect(hash).toBe(TX);
    expect(chain.ranges[chain.ranges.length - 1].from).toBeLessThanOrEqual(startBlock + 12n);
    expect(chain.ranges.length).toBeLessThanOrEqual(3);
  });

  it("a transient failure on one chunk does not hide a hit in a later chunk", async () => {
    const created = NOW_SEC - 600;
    const latestBlock = 1_000_000n;
    const startBlock = latestBlock - BigInt(Math.round(600 / 0.4));
    const chain = fakeChain({
      latestBlock, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4, failFirstGetLogs: true,
      txs: [{ block: startBlock + 200n, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });
    const hash = await findAuthorizationUsedTxViaLogs(
      chain.rpc,
      { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 590 },
      {}
    );
    expect(hash).toBe(TX);
  });

  it("throws (so the caller treats the lookup as unavailable) only when EVERY getLogs call failed, e.g. chunk above the RPC cap", async () => {
    const created = NOW_SEC - 600;
    const chain = fakeChain({ latestBlock: 1_000_000n, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4, txs: [] });
    await expect(
      findAuthorizationUsedTxViaLogs(
        chain.rpc,
        { usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: created * 1000, validBeforeSec: created + 60 },
        { chunkBlocks: 500 }
      )
    ).rejects.toThrow(/limited to a 100 range/);
  });

  it("invalid authorizer/nonce -> null with zero RPC calls; payment newer than chain head -> null", async () => {
    const chain = fakeChain({ latestBlock: 1000n, latestTimestampSec: NOW_SEC, blockTimeSec: 0.4, txs: [] });
    const base = { usdcAddress: USDC, paymentCreatedAtMs: (NOW_SEC - 100) * 1000, validBeforeSec: NOW_SEC - 40 };
    expect(await findAuthorizationUsedTxViaLogs(chain.rpc, { ...base, authorizer: "0x1234", nonce: NONCE })).toBeNull();
    expect(await findAuthorizationUsedTxViaLogs(chain.rpc, { ...base, authorizer: PAYER, nonce: "0x1234" })).toBeNull();
    expect(chain.total()).toBe(0);
    const future = await findAuthorizationUsedTxViaLogs(chain.rpc, {
      usdcAddress: USDC, authorizer: PAYER, nonce: NONCE, paymentCreatedAtMs: (NOW_SEC + 3600) * 1000, validBeforeSec: NOW_SEC + 3700,
    });
    expect(future).toBeNull();
  });
});

describe("scanOptionsFromEnv", () => {
  it("defaults, valid overrides, and invalid values falling back", () => {
    expect(scanOptionsFromEnv({})).toEqual({ chunkBlocks: 100, maxRpcCalls: 60, initialBlockTimeMs: 500 });
    expect(
      scanOptionsFromEnv({
        MONEYSWITCH_RECONCILE_LOG_CHUNK_BLOCKS: "50",
        MONEYSWITCH_RECONCILE_LOG_MAX_CALLS: "20",
        MONEYSWITCH_RECONCILE_BLOCK_TIME_MS: "400",
      })
    ).toEqual({ chunkBlocks: 50, maxRpcCalls: 20, initialBlockTimeMs: 400 });
    expect(
      scanOptionsFromEnv({
        MONEYSWITCH_RECONCILE_LOG_CHUNK_BLOCKS: "0",
        MONEYSWITCH_RECONCILE_LOG_MAX_CALLS: "abc",
        MONEYSWITCH_RECONCILE_BLOCK_TIME_MS: "-5",
      })
    ).toEqual({ chunkBlocks: 100, maxRpcCalls: 60, initialBlockTimeMs: 500 });
  });
});

describe("reconcile end to end with the log scanner (fake chain, no network)", () => {
  it("an `unknown` TIMEOUT_AFTER_PAYMENT row whose authorization was used on-chain is settled WITH its tx hash", async () => {
    const { db } = openDb({ filePath: ":memory:" });
    const key = createMoneyKey(db, {
      name: "k",
      totalBudget: parseUsdcToMicros("10"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"),
      allowedHosts: ["example.com:443"],
    }).row;
    const { paymentId } = evaluateAndReserve(db, key, {
      url: "https://example.com/premium", host: "example.com:443", method: "GET", body: undefined,
      network: "eip155:10143", asset: USDC, payTo: "0xabc", amount: parseUsdcToMicros("0.01"),
    });
    markUnknown(db, paymentId, "TIMEOUT_AFTER_PAYMENT");
    const created = getPayment(db, paymentId)!;
    const createdSec = Math.floor(new Date(created.createdAt).getTime() / 1000);
    recordPaymentAuthorization(db, paymentId, { from: PAYER, nonce: NONCE, validBefore: createdSec + 300 });

    const now = new Date((createdSec + 3600) * 1000);
    const latestBlock = 9_000_000n;
    const txBlock = latestBlock - BigInt(Math.round((3600 - 40) / 0.4)); // mined 40s after creation
    const chain = fakeChain({
      latestBlock, latestTimestampSec: createdSec + 3600, blockTimeSec: 0.4,
      txs: [{ block: txBlock, authorizer: PAYER, nonce: NONCE, txHash: TX }],
    });
    const reader: AuthorizationReader = {
      authorizationState: async () => true,
      findAuthorizationUsedTx: (input) =>
        findAuthorizationUsedTxViaLogs(chain.rpc, {
          usdcAddress: USDC, authorizer: input.authorizer, nonce: input.nonce,
          paymentCreatedAtMs: input.paymentCreatedAtMs, validBeforeSec: input.validBeforeSec,
        }),
    };

    const result = await reconcileUnknownPayments({ db, reader, now });
    expect(result.settledWithTx).toBe(1);
    expect(result.settledTxUnknown).toBe(0);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBe(TX);
    expect(row.errorCode).toBeNull();
    expect(row.reconciledAt).toBeTruthy();
  });

  it("a lookup that blows up never crashes reconcile: the row is still settled, just without a hash", async () => {
    const { db } = openDb({ filePath: ":memory:" });
    const key = createMoneyKey(db, {
      name: "k", totalBudget: parseUsdcToMicros("10"), dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.5"), allowedHosts: ["example.com:443"],
    }).row;
    const { paymentId } = evaluateAndReserve(db, key, {
      url: "https://example.com/premium", host: "example.com:443", method: "GET", body: undefined,
      network: "eip155:10143", asset: USDC, payTo: "0xabc", amount: parseUsdcToMicros("0.01"),
    });
    markUnknown(db, paymentId, "TIMEOUT_AFTER_PAYMENT");
    const createdSec = Math.floor(new Date(getPayment(db, paymentId)!.createdAt).getTime() / 1000);
    recordPaymentAuthorization(db, paymentId, { from: PAYER, nonce: NONCE, validBefore: createdSec + 300 });
    const brokenRpc: LogRpc = {
      getLatestBlock: async () => { throw new Error("rpc down"); },
      getBlockTimestampSec: async () => { throw new Error("rpc down"); },
      getLogs: async () => { throw new Error("rpc down"); },
    };
    const reader: AuthorizationReader = {
      authorizationState: async () => true,
      findAuthorizationUsedTx: (input) =>
        findAuthorizationUsedTxViaLogs(brokenRpc, {
          usdcAddress: USDC, authorizer: input.authorizer, nonce: input.nonce,
          paymentCreatedAtMs: input.paymentCreatedAtMs, validBeforeSec: input.validBeforeSec,
        }),
    };
    const result = await reconcileUnknownPayments({ db, reader, now: new Date((createdSec + 3600) * 1000) });
    expect(result.settledTxUnknown).toBe(1);
    const row = getPayment(db, paymentId)!;
    expect(row.status).toBe("settled");
    expect(row.txHash).toBeNull();
    expect(row.errorCode).toBe("SETTLED_TX_UNKNOWN");
  });
});
