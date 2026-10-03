import { useCallback, useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * What usePolling does, without React: runs `fetcher` and reports the state through `onChange`.
 *
 * Answers are applied in the order the requests were MADE, not the order they come back: an answer is dropped when a request made
 * after it has already been applied. Without that rule a poll made before an action (say, "Replace wallet") and answering after the
 * page already learned the outcome would put the old state back on screen.
 */
export class Poller<T> {
  state: PollState<T> = { data: null, error: null, loading: true };
  private issued = 0;
  private applied = 0;

  constructor(
    public fetcher: () => Promise<T>,
    private readonly onChange: (state: PollState<T>) => void
  ) {}

  /** Makes one request. Resolves when it has been answered (applied or dropped); never rejects. */
  async run(): Promise<void> {
    const seq = ++this.issued;
    let next: PollState<T>;
    try {
      const data = await this.fetcher();
      if (seq < this.applied) return; // a newer request has already been applied
      next = { data, error: null, loading: false };
    } catch (e) {
      if (seq < this.applied) return;
      next = { data: this.state.data, error: e instanceof Error ? e.message : "request_failed", loading: false };
    }
    this.applied = seq;
    this.state = next;
    this.onChange(next);
  }
}

/**
 * Polls the given async fetcher every `intervalMs` (default 3000ms per
 * SPEC §10: "轮询 3s 刷新即可，不上 WebSocket"). Also exposes a manual
 * refresh() for after mutations (create key, approve, etc). An answer that
 * comes back after a newer one was applied is ignored (see Poller).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 3000
): { data: T | null; error: string | null; loading: boolean; refresh: () => Promise<void> } {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true });
  const poller = useRef<Poller<T> | null>(null);
  if (poller.current === null) poller.current = new Poller<T>(fetcher, setState);
  poller.current.fetcher = fetcher;

  const run = useCallback(() => poller.current!.run(), []);

  useEffect(() => {
    run();
    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
  }, [run, intervalMs]);

  return { ...state, refresh: run };
}
