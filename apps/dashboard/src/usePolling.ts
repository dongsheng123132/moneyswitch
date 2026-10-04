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
 *
 * Requests do not pile up: a scheduled poll (`tick`) is skipped while an earlier request is still waiting for its answer, so a slow
 * server is not handed a new request every interval. A deliberate `run` (the refresh after a click) is never skipped: it goes out
 * even with a poll in flight, and the ordering rule above sorts out which answer wins.
 */
export class Poller<T> {
  state: PollState<T> = { data: null, error: null, loading: true };
  private issued = 0;
  private applied = 0;
  private inFlight = 0;

  constructor(
    public fetcher: () => Promise<T>,
    private readonly onChange: (state: PollState<T>) => void
  ) {}

  /** A scheduled poll: makes one request unless an earlier one has not been answered yet, in which case it does nothing. Never rejects. */
  tick(): Promise<void> {
    return this.inFlight > 0 ? Promise.resolve() : this.run();
  }

  /** Makes one request, whatever else is in flight. Resolves when it has been answered (applied or dropped); never rejects. */
  async run(): Promise<void> {
    this.inFlight++;
    try {
      await this.request(++this.issued);
    } finally {
      this.inFlight--;
    }
  }

  private async request(seq: number): Promise<void> {
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
 * Polls the given async fetcher every `intervalMs` (default 3000ms). An
 * interval that arrives while the previous request is still unanswered is
 * skipped. Also exposes a manual refresh() for after mutations (create key,
 * approve, etc), which is never skipped. An answer that comes back after a
 * newer one was applied is ignored (see Poller).
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
  const tick = useCallback(() => poller.current!.tick(), []);

  useEffect(() => {
    run();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [run, tick, intervalMs]);

  return { ...state, refresh: run };
}
