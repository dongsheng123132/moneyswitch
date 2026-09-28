import { defaultRegQuery, readWindowsSystemProxy, type RegQueryFn } from "./windows-proxy.js";
import type { ProxyResolution } from "./types.js";

export interface ResolveOutboundProxyOptions {
  /** process.env-like source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** process.platform override, for tests. */
  platform?: NodeJS.Platform;
  /** Injectable `reg query` runner (win32 system-proxy lookup), for tests. */
  regQuery?: RegQueryFn;
}

function readEnv(env: NodeJS.ProcessEnv, upper: string, lower: string): string | undefined {
  const v = env[upper] ?? env[lower];
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

function collectEnvNoProxy(env: NodeJS.ProcessEnv): string[] {
  const raw = readEnv(env, "NO_PROXY", "no_proxy") ?? "";
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolves which outbound HTTP(S) proxy MoneySwitch should use, in priority
 * order (see docs/nansen-mainnet.md and the README "behind a proxy" section):
 *
 *  1. MONEYSWITCH_PROXY: "off" (never proxy), "auto" (default, fall through
 *     to 2/3), or a literal proxy URL ("http://127.0.0.1:7897" or bare
 *     "127.0.0.1:7897").
 *  2. Standard HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (either case), in that
 *     order.
 *  3. On win32 only, the Windows system proxy
 *     (HKCU\...\Internet Settings: ProxyEnable/ProxyServer/ProxyOverride).
 *
 * Pure and offline: never makes a network call. The win32 branch shells out
 * to `reg query` (via the injectable `regQuery`) but that's a local,
 * synchronous registry read, not network I/O.
 */
export function resolveOutboundProxy(opts: ResolveOutboundProxyOptions = {}): ProxyResolution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const regQuery = opts.regQuery ?? defaultRegQuery;
  const envNoProxy = collectEnvNoProxy(env);

  const raw = env.MONEYSWITCH_PROXY?.trim();
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower === "off") {
      return { url: null, source: "none", noProxy: envNoProxy };
    }
    if (lower !== "auto") {
      return { url: normalizeProxyUrl(raw), source: "MONEYSWITCH_PROXY", noProxy: envNoProxy };
    }
    // "auto": fall through to standard env vars / Windows system proxy below.
  }

  const envProxy =
    readEnv(env, "HTTPS_PROXY", "https_proxy") ??
    readEnv(env, "HTTP_PROXY", "http_proxy") ??
    readEnv(env, "ALL_PROXY", "all_proxy");
  if (envProxy) {
    return { url: normalizeProxyUrl(envProxy), source: "env", noProxy: envNoProxy };
  }

  if (platform === "win32") {
    const win = readWindowsSystemProxy(regQuery);
    if (win?.url) {
      return { url: win.url, source: "windows-system", noProxy: [...envNoProxy, ...win.noProxy] };
    }
  }

  return { url: null, source: "none", noProxy: envNoProxy };
}
