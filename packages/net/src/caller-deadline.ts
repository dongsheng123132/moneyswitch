import { Dispatcher, getGlobalDispatcher } from "undici";

/**
 * A dispatcher for requests whose deadline belongs to the CALLER (an
 * AbortSignal it controls), not to undici.
 *
 * undici arms two idle timers on every request, `headersTimeout` (time to the
 * first response byte after the request is sent) and `bodyTimeout` (max idle
 * gap between body chunks), both 300 s by default. They are Agent options, so
 * `fetch()` cannot change them per call, and they sit underneath whatever
 * deadline the caller set: a caller that legitimately waits longer than 300 s
 * (a paid request to a slow LLM seller, with a 10-minute budget) is cut off at
 * 300 s with UND_ERR_HEADERS_TIMEOUT, and the failure then carries the wrong
 * meaning (a transport error instead of "my deadline expired").
 *
 * This wrapper forwards every request to whatever dispatcher is the process's
 * CURRENT global one (looked up per request, so it follows a later
 * `installOutboundProxy()` and keeps the proxy / always-direct routing of
 * RoutingDispatcher), but switches both idle timers off for that request.
 * Connecting still has its own timeout (10 s by default). The caller MUST
 * bound the request itself (AbortSignal), otherwise a silent peer would hold
 * the request open forever.
 */
class CallerDeadlineDispatcher extends Dispatcher {
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return getGlobalDispatcher().dispatch({ ...opts, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }

  // The wrapper owns no sockets: the global dispatcher is closed by whoever installed it.
  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    if (callback) {
      queueMicrotask(callback);
      return;
    }
    return Promise.resolve();
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const cb = typeof errOrCallback === "function" ? errOrCallback : callback;
    if (cb) {
      queueMicrotask(cb);
      return;
    }
    return Promise.resolve();
  }
}

let shared: CallerDeadlineDispatcher | null = null;

/**
 * The (stateless, shared) caller-deadline dispatcher; pass it as the `dispatcher`
 * of a fetch() call: `fetch(url, { signal, dispatcher: callerDeadlineDispatcher() })`.
 */
export function callerDeadlineDispatcher(): Dispatcher {
  if (!shared) shared = new CallerDeadlineDispatcher();
  return shared;
}
