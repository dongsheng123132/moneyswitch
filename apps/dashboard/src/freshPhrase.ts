import { useSyncExternalStore } from "react";

/**
 * Holds a recovery phrase that was just handed out (a wallet was created or replaced) until the
 * operator has written it down and answered the two-word check.
 *
 * Memory only, on purpose: never sessionStorage / localStorage / the URL. It lives as long as this
 * page does, so it survives switching wizard steps and the 3-second wallet polls that re-render
 * the page, but a reload drops it (the phrase can be shown again later with the wallet address,
 * see "Reveal recovery phrase"). It is cleared as soon as the backup is confirmed.
 */
let phrase: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

export const freshPhrase = {
  get: (): string | null => phrase,
  set(next: string): void {
    phrase = next;
    notify();
  },
  clear(): void {
    if (phrase === null) return;
    phrase = null;
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useFreshPhrase(): string | null {
  // (This is a client-only app; the server snapshot is the same memory value, which also lets render tests see it.)
  return useSyncExternalStore(freshPhrase.subscribe, freshPhrase.get, freshPhrase.get);
}
