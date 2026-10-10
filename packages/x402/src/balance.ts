import type { NetworkConfig } from "./networks.js";

/**
 * Reading the wallet's USDC balance for the payment path (SPEC.md §6, "pick the chain the wallet can actually pay on").
 *
 * This file holds no RPC code of its own. The read itself is LocalWalletDriver.getUsdcBalanceOf (the one the wallet page uses); the
 * server hands it in (AppContext.balanceReader), so packages/x402 never depends on apps/server and tests inject a fake.
 */

/** How long one read of (chain, address) is reused. SPEC §6: at most 15 s. */
export const BALANCE_CACHE_MS = 15_000;
/** How long a paid request waits for one read; a chain that has not answered by then is treated as "balance unknown". */
export const BALANCE_TIMEOUT_MS = 3_000;
/** How long "could not be read" (failed or timed out) is remembered, so a dead RPC is not asked again by every request. Same as the wallet page (routes/wallet.ts). */
export const BALANCE_FAILURE_CACHE_MS = 2_000;

/**
 * The raw read: USDC (atomic units) of `address` on `network`. Throws when it cannot be read. `signal` is aborted when the caller has
 * stopped waiting (the deadline), so a read that honors it leaves no request hanging on the RPC.
 */
export type UsdcBalanceReader = (address: string, network: NetworkConfig, signal: AbortSignal) => Promise<bigint>;

/** What the payment path asks: the balance, or null when it is not known (the read failed or timed out). Never throws. */
export interface KnownBalanceReader {
  (address: string, network: NetworkConfig): Promise<bigint | null>;
  /**
   * Called when a payment out of `address` on `network` has been signed, and again when that payment's outcome is decided (a read made
   * in between is just as old): whatever balance is remembered for it was true before that payment and no longer is, so the next ask
   * reads the chain again. Optional: a reader that remembers nothing (a test's fake) has nothing to forget.
   */
  forget?(address: string, network: NetworkConfig): void;
}

export interface BalanceReaderOptions {
  ttlMs?: number;
  /** How long a failed or timed-out read is remembered as "unknown" (default BALANCE_FAILURE_CACHE_MS). */
  failureTtlMs?: number;
  timeoutMs?: number;
  /** Test seam: the clock the cache ages by. */
  now?: () => number;
}

/**
 * Wraps a raw read: cached per (network, address) for ttlMs, at most timeoutMs per read, and a failed or late read gives null (the
 * raw read's signal is aborted when the deadline passes). A balance that was really read is cached for ttlMs; "could not be read" is
 * remembered for failureTtlMs only (2 s): long enough that requests arriving together do not each wait out a dead RPC, short enough
 * that it is tried again soon. Callers that ask for the same (network, address) while a read is under way share it. forget() drops
 * what is remembered for one (network, address) (the wallet just spent from it); a read that was under way at that moment may predate
 * the payment, so it is answered to those who were already waiting for it but is neither cached nor shared with anyone who asks after
 * the forget.
 */
export function createBalanceReader(read: UsdcBalanceReader, options: BalanceReaderOptions = {}): KnownBalanceReader {
  const ttlMs = options.ttlMs ?? BALANCE_CACHE_MS;
  const failureTtlMs = options.failureTtlMs ?? BALANCE_FAILURE_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; value: bigint }>();
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<bigint | null>>();
  const keyOf = (address: string, network: NetworkConfig) => `${network.caip2}:${network.caip2.startsWith("eip155:") ? address.toLowerCase() : address}`;

  async function lookup(address: string, network: NetworkConfig): Promise<bigint | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = new AbortController();
    try {
      return await Promise.race([
        read(address, network, request.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Give up on the request, not only on waiting for it: nothing is left hanging on the RPC.
            request.abort();
            reject(new Error("USDC balance read timed out"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const reader: KnownBalanceReader = (address, network) => {
    const key = keyOf(address, network);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    const failed = failedAt.get(key);
    if (failed !== undefined && now() - failed < failureTtlMs) return Promise.resolve(null);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const started: Promise<bigint | null> = lookup(address, network)
      .then((value) => {
        // Not the read this key is waiting for any more (forget() dropped it): it may be older than a payment, so keep nothing of it.
        if (inFlight.get(key) === started) {
          if (value !== null) {
            cache.set(key, { at: now(), value });
            failedAt.delete(key);
          } else {
            failedAt.set(key, now());
          }
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      });
    inFlight.set(key, started);
    return started;
  };
  reader.forget = (address, network) => {
    const key = keyOf(address, network);
    cache.delete(key);
    failedAt.delete(key);
    inFlight.delete(key);
  };
  return reader;
}
