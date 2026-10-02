import { pad, toEventSelector, type Hex } from "viem";

/**
 * Finds the transaction that consumed an EIP-3009 authorization by scanning the
 * USDC contract's `AuthorizationUsed(address indexed authorizer, bytes32 indexed
 * nonce)` logs. Used by reconcile when the authorization is known to be used
 * on-chain (authorizationState == true) but our payments row has no tx hash —
 * e.g. we signed, the seller settled, and then we lost the HTTP response.
 *
 * Public RPCs cap eth_getLogs hard (Monad's public testnet RPC: "eth_getLogs is
 * limited to a 100 range"), so a single wide query does not work. Instead:
 *   1. bound the search by the payment's own time window — the settle tx can only
 *      have been mined between the payment's creation and the authorization's
 *      validBefore (plus a margin);
 *   2. turn that time window into a block range by interpolation on real block
 *      timestamps (a handful of cheap eth_getBlockByNumber calls);
 *   3. scan the range chronologically in chunks of `chunkBlocks`, stopping at the
 *      first hit;
 *   4. never exceed `maxRpcCalls` RPC calls in total (locating + scanning).
 * It is pure with respect to the RPC: everything goes through `LogRpc`, so tests
 * drive it with a fake and never touch a network.
 */

export const AUTHORIZATION_USED_SIGNATURE = "AuthorizationUsed(address,bytes32)";
/** topic0 of AuthorizationUsed — 0x98de5035...b10a5 for the standard USDC event. */
export const AUTHORIZATION_USED_TOPIC0: Hex = toEventSelector(AUTHORIZATION_USED_SIGNATURE);

export interface LogRpc {
  /** Latest block number and its timestamp (unix seconds). */
  getLatestBlock(): Promise<{ number: bigint; timestampSec: number }>;
  /** Timestamp (unix seconds) of a specific block. */
  getBlockTimestampSec(blockNumber: bigint): Promise<number>;
  /** eth_getLogs over [fromBlock, toBlock] (inclusive) with raw topic filters. */
  getLogs(params: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
    topics: Array<string | null>;
  }): Promise<Array<{ transactionHash: string | null; blockNumber?: bigint | null }>>;
}

export interface AuthorizationLogScanOptions {
  /** Max blocks per eth_getLogs call. Default 100 (Monad public RPC limit). Env: MONEYSWITCH_RECONCILE_LOG_CHUNK_BLOCKS. */
  chunkBlocks?: number;
  /** Hard cap on total RPC calls per lookup (latest block + block-time probes + getLogs). Default 60. Env: MONEYSWITCH_RECONCILE_LOG_MAX_CALLS. */
  maxRpcCalls?: number;
  /** Seconds added before payment creation and after validBefore. Default 30. */
  marginSeconds?: number;
  /** Initial block-time guess in ms, refined from real timestamps. Default 500. Env: MONEYSWITCH_RECONCILE_BLOCK_TIME_MS. */
  initialBlockTimeMs?: number;
  /** A located block within this many seconds of the target is accepted. Default 2. */
  locateToleranceSeconds?: number;
  /** Max timestamp probes per boundary while locating it. Default 6. */
  maxLocateSteps?: number;
}

export interface AuthorizationLookup {
  /** USDC contract address. */
  usdcAddress: string;
  /** The authorization's `from` (the payer). */
  authorizer: string;
  /** The authorization's bytes32 nonce; omit/null to match any nonce of this authorizer (diagnostics only). */
  nonce?: string | null;
  /** payments.created_at in epoch ms. */
  paymentCreatedAtMs: number;
  /** The authorization's validBefore, unix seconds. Falls back to created + 10 min. */
  validBeforeSec?: number | null;
}

const DEFAULT_CHUNK_BLOCKS = 100;
const DEFAULT_MAX_RPC_CALLS = 60;
const DEFAULT_MARGIN_SECONDS = 30;
const DEFAULT_BLOCK_TIME_MS = 500;
const DEFAULT_LOCATE_TOLERANCE_SECONDS = 2;
const DEFAULT_MAX_LOCATE_STEPS = 6;
const FALLBACK_VALID_WINDOW_SECONDS = 600;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Scan options from the environment; invalid values fall back to the defaults. */
export function scanOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthorizationLogScanOptions {
  return {
    chunkBlocks: positiveInt(env.MONEYSWITCH_RECONCILE_LOG_CHUNK_BLOCKS, DEFAULT_CHUNK_BLOCKS),
    maxRpcCalls: positiveInt(env.MONEYSWITCH_RECONCILE_LOG_MAX_CALLS, DEFAULT_MAX_RPC_CALLS),
    initialBlockTimeMs: positiveInt(env.MONEYSWITCH_RECONCILE_BLOCK_TIME_MS, DEFAULT_BLOCK_TIME_MS),
  };
}

/** The eth_getLogs topics filter: [event signature, authorizer (32-byte padded), nonce | null]. */
export function authorizationUsedTopics(authorizer: string, nonce?: string | null): Array<string | null> {
  return [
    AUTHORIZATION_USED_TOPIC0,
    pad(authorizer.toLowerCase() as Hex, { size: 32 }),
    nonce ? nonce.toLowerCase() : null,
  ];
}

class RpcBudgetExhausted extends Error {
  constructor() {
    super("RPC call budget exhausted");
    this.name = "RpcBudgetExhausted";
  }
}

const clamp = (n: bigint, lo: bigint, hi: bigint) => (n < lo ? lo : n > hi ? hi : n);

/**
 * Returns the tx hash of the AuthorizationUsed log, `null` if the bounded search
 * found nothing, or throws if the RPC failed so completely that nothing could be
 * searched (callers treat a throw as "lookup unavailable", same as null for the
 * purpose of settling the row without a hash).
 */
export async function findAuthorizationUsedTxViaLogs(
  rpc: LogRpc,
  lookup: AuthorizationLookup,
  options: AuthorizationLogScanOptions = {}
): Promise<string | null> {
  const chunkBlocks = BigInt(Math.max(1, Math.floor(options.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS)));
  const maxRpcCalls = Math.max(1, Math.floor(options.maxRpcCalls ?? DEFAULT_MAX_RPC_CALLS));
  const marginSec = options.marginSeconds ?? DEFAULT_MARGIN_SECONDS;
  const tolerance = options.locateToleranceSeconds ?? DEFAULT_LOCATE_TOLERANCE_SECONDS;
  const maxLocateSteps = options.maxLocateSteps ?? DEFAULT_MAX_LOCATE_STEPS;
  const initialBps = 1000 / Math.max(1, options.initialBlockTimeMs ?? DEFAULT_BLOCK_TIME_MS);

  if (lookup.nonce != null && !/^0x[0-9a-fA-F]{64}$/.test(lookup.nonce)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(lookup.authorizer)) return null;

  let callsLeft = maxRpcCalls;
  const spend = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (callsLeft <= 0) throw new RpcBudgetExhausted();
    callsLeft--;
    return fn();
  };

  const latest = await spend(() => rpc.getLatestBlock());

  const createdSec = Math.floor(lookup.paymentCreatedAtMs / 1000);
  const validBeforeSec = lookup.validBeforeSec ?? createdSec + FALLBACK_VALID_WINDOW_SECONDS;
  const startSec = createdSec - marginSec;
  const endSec = Math.max(validBeforeSec, createdSec) + marginSec;
  if (startSec > latest.timestampSec) return null; // payment is "in the future" of the chain head: nothing to scan yet.

  // Blocks per second, refined from real timestamps as we probe.
  let blocksPerSec = initialBps;

  /** Interpolation search for the block whose timestamp is closest to targetSec. */
  const locate = async (targetSec: number): Promise<bigint> => {
    if (targetSec >= latest.timestampSec) return latest.number;
    let anchor = { n: latest.number, t: latest.timestampSec };
    let est = clamp(
      anchor.n - BigInt(Math.max(0, Math.round((anchor.t - targetSec) * blocksPerSec))),
      0n,
      latest.number
    );
    for (let step = 0; step < maxLocateSteps; step++) {
      if (est === anchor.n) return est;
      const t = await spend(() => rpc.getBlockTimestampSec(est));
      const diff = targetSec - t; // > 0: the target is later than the probed block
      if (Math.abs(diff) <= tolerance) return est;
      if (t !== anchor.t) {
        const rate = Number(est - anchor.n) / (t - anchor.t);
        if (Number.isFinite(rate) && rate > 0) blocksPerSec = rate;
      }
      anchor = { n: est, t };
      est = clamp(est + BigInt(Math.round(diff * blocksPerSec)), 0n, latest.number);
    }
    return est;
  };

  let fromBlock: bigint;
  let toBlock: bigint;
  try {
    const startBlock = await locate(startSec);
    const endBlock = endSec >= latest.timestampSec ? latest.number : await locate(endSec);
    const guard = BigInt(Math.ceil(tolerance * blocksPerSec) + 2);
    fromBlock = clamp(startBlock - guard, 0n, latest.number);
    toBlock = clamp(endBlock + guard, 0n, latest.number);
  } catch (e) {
    if (e instanceof RpcBudgetExhausted) return null;
    throw e;
  }
  if (toBlock < fromBlock) return null;

  const topics = authorizationUsedTopics(lookup.authorizer, lookup.nonce);
  let successfulCalls = 0;
  let lastError: unknown;
  for (let from = fromBlock; from <= toBlock; from += chunkBlocks) {
    if (callsLeft <= 0) break;
    const to = from + chunkBlocks - 1n > toBlock ? toBlock : from + chunkBlocks - 1n;
    try {
      const logs = await spend(() =>
        rpc.getLogs({ address: lookup.usdcAddress, fromBlock: from, toBlock: to, topics })
      );
      successfulCalls++;
      const hit = logs.find((l) => typeof l.transactionHash === "string" && l.transactionHash.length > 0);
      if (hit) return hit.transactionHash;
    } catch (e) {
      lastError = e; // keep going: one flaky chunk must not hide a hit in the next one.
    }
  }
  if (successfulCalls === 0 && lastError !== undefined) throw lastError;
  return null;
}
