import { useSyncExternalStore } from "react";

/**
 * Holds a recovery phrase that was just handed out (a wallet was created or replaced) until the
 * operator has written it down and ticked "I wrote them down".
 *
 * Memory only, on purpose: never sessionStorage / localStorage / the URL. It lives as long as this
 * page does, so it survives the 3-second wallet polls that re-render the page, but a reload drops it,
 * and nothing can show it again (there is no reveal: a wallet whose words were not written down is
 * replaced). So it is cleared in exactly two places: the acknowledgement and signing out. Never
 * because the page happens to show another wallet for a moment (a poll that was in flight before a
 * replace can answer late): that would lose the words for good.
 *
 * It is remembered TOGETHER WITH THE ADDRESS it belongs to, and only ever SHOWN for that wallet: if the
 * wallet that is current is another one (replaced from another tab, or by the server), the old phrase must
 * not turn up in that wallet's backup flow. It stays held, hidden, until the page shows its wallet again or
 * it is cleared. The address also travels with the acknowledgement, so the server can refuse it when the
 * wallet was replaced between the words being shown and the click.
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
 * The phrase to put on screen for the wallet the page shows (null = nothing to show). It is shown only for the wallet it was
 * handed out for; for another wallet it is hidden but NOT dropped.
 *  - `currentAddress` = the address of the wallet the page shows.
 *  - `null` = no wallet is known yet (the set-up screen right after "Create", before the next poll): the creation
 *    response is the authority, the phrase is shown as it is.
 */
export function visibleFreshPhrase(entry: FreshPhraseEntry | null, currentAddress: string | null): FreshPhraseEntry | null {
  if (entry === null) return null;
  if (currentAddress === null) return entry;
  return sameAddress(entry.address, currentAddress) ? entry : null;
}

export function useFreshPhrase(currentAddress: string | null): FreshPhraseEntry | null {
  // (This is a client-only app; the server snapshot is the same memory value, which also lets render tests see it.)
  const current = useSyncExternalStore(freshPhrase.subscribe, freshPhrase.get, freshPhrase.get);
  return visibleFreshPhrase(current, currentAddress);
}
