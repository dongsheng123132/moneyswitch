import { useEffect, useSyncExternalStore } from "react";

/**
 * Holds a recovery phrase that was just handed out (a wallet was created or replaced) until the
 * operator has written it down and answered the two-word check.
 *
 * Memory only, on purpose: never sessionStorage / localStorage / the URL. It lives as long as this
 * page does, so it survives switching wizard steps and the 3-second wallet polls that re-render
 * the page, but a reload drops it (the phrase can be shown again later with the wallet address,
 * see "Reveal recovery phrase"). It is cleared as soon as the backup is confirmed.
 *
 * It is remembered TOGETHER WITH THE ADDRESS it belongs to, and only ever shown for that wallet: if the
 * wallet that is current is another one (replaced from another tab, or by the server), the old phrase must
 * not turn up in that wallet's backup flow.
 */
export interface FreshPhraseEntry {
  address: string;
  phrase: string;
}

let entry: FreshPhraseEntry | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const freshPhrase = {
  get: (): FreshPhraseEntry | null => entry,
  /** The phrase, but only if it belongs to `address`. */
  getFor: (address: string): string | null => (entry && sameAddress(entry.address, address) ? entry.phrase : null),
  set(address: string, phrase: string): void {
    entry = { address, phrase };
    notify();
  },
  clear(): void {
    if (entry === null) return;
    entry = null;
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * The fresh phrase for the wallet that is current.
 *  - `currentAddress` = that wallet's address: the phrase is returned only when it was handed out for THIS address, and a
 *    phrase that belongs to another wallet is dropped.
 *  - `null` = no wallet is known yet (the set-up screen right after "Create", before the next poll): the creation
 *    response is the authority, the phrase is returned as it is.
 */
export function useFreshPhrase(currentAddress: string | null): string | null {
  // (This is a client-only app; the server snapshot is the same memory value, which also lets render tests see it.)
  const current = useSyncExternalStore(freshPhrase.subscribe, freshPhrase.get, freshPhrase.get);
  const stale = current !== null && currentAddress !== null && !sameAddress(current.address, currentAddress);
  useEffect(() => {
    if (stale) freshPhrase.clear();
  }, [stale]);
  if (current === null || stale) return null;
  return current.phrase;
}
