import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { shouldBypassProxy } from "./bypass.js";
import { resolveOutboundProxy, type ResolveOutboundProxyOptions } from "./resolve.js";
import type { ProxyResolution } from "./types.js";

/**
 * Routes each dispatched request to a direct `Agent` or a `ProxyAgent`
 * depending on the target host, so one `setGlobalDispatcher` call covers
 * every outbound fetch in the process (facilitator, viem RPC, toll booth
 * forwarding, `paid_fetch`) while localhost/private-range/no_proxy targets
 * still go direct. Chosen over undici's `EnvHttpProxyAgent` because that
 * class only ever reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY from process.env —
 * it has no way to represent MONEYSWITCH_PROXY or the Windows-system-proxy
 * source, and it has no hook for the extra always-direct private ranges
 * (10/8, 172.16/12, 192.168/16, 100.64/10) this module also enforces
 * unconditionally, regardless of NO_PROXY content.
 */
class RoutingDispatcher extends Dispatcher {
  private readonly direct = new Agent();
  private readonly proxied: ProxyAgent;
  private readonly noProxy: readonly string[];

  constructor(proxyUrl: string, noProxy: readonly string[]) {
    super();
    this.proxied = new ProxyAgent(proxyUrl);
    this.noProxy = noProxy;
  }

  private pick(opts: Dispatcher.DispatchOptions): Dispatcher {
    const originValue = opts.origin as unknown;
    const originStr = typeof originValue === "string" ? originValue : (originValue as { toString(): string } | undefined)?.toString() ?? "";
    let hostname = "";
    try {
      hostname = new URL(originStr).hostname;
    } catch {
      hostname = "";
    }
    return shouldBypassProxy(hostname, this.noProxy) ? this.direct : this.proxied;
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.pick(opts).dispatch(opts, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const p = Promise.all([this.direct.close(), this.proxied.close()]).then(() => undefined);
    if (callback) {
      p.then(() => callback());
      return;
    }
    return p;
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const err = typeof errOrCallback === "function" ? null : errOrCallback ?? null;
    const cb = typeof errOrCallback === "function" ? errOrCallback : callback;
    const p = Promise.all([this.direct.destroy(err), this.proxied.destroy(err)]).then(() => undefined);
    if (cb) {
      p.then(() => cb());
      return;
    }
    return p;
  }
}

let installed: ProxyResolution | null = null;

/** Strips userinfo (auth) from a proxy URL — never log/expose credentials. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** `host:port` only, no scheme/credentials — what the admin-meta endpoint is allowed to expose. */
export function hostPortOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

/**
 * Resolves the outbound proxy (see resolveOutboundProxy) and, if one
 * applies, installs a process-wide undici dispatcher so it's used by every
 * global `fetch` call (this process only — does not affect child
 * processes). No-op when the resolution has no url (MONEYSWITCH_PROXY=off,
 * or auto-detection found nothing): the previous/default dispatcher is left
 * untouched. Always records the resolution for `getInstalledOutboundProxy`.
 */
export function installOutboundProxy(opts: ResolveOutboundProxyOptions = {}): ProxyResolution {
  const resolution = resolveOutboundProxy(opts);
  installed = resolution;
  if (resolution.url) {
    setGlobalDispatcher(new RoutingDispatcher(resolution.url, resolution.noProxy));
  }
  return resolution;
}

/** The resolution from the most recent `installOutboundProxy()` call in this process, or null before that. */
export function getInstalledOutboundProxy(): ProxyResolution | null {
  return installed;
}
