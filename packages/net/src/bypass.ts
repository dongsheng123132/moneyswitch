import { isIP } from "node:net";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT). */
function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  return false;
}

/** ::1 only (the task's "always direct" list has no other IPv6 ranges). */
function isLoopbackIPv6(ip: string): boolean {
  return ip.toLowerCase().replace(/^\[|\]$/g, "") === "::1";
}

/**
 * Hosts that must always be dialed directly, regardless of any proxy
 * configuration: localhost, loopback and RFC1918/CGNAT private ranges. This
 * is what keeps the local MoneySwitch server itself and other LAN services
 * reachable even when a system-wide proxy is installed.
 */
export function isAlwaysDirectHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  const bare = h.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind === 4) return isPrivateOrLoopbackIPv4(bare);
  if (kind === 6) return isLoopbackIPv6(bare);
  return false;
}

/**
 * Matches a single NO_PROXY/ProxyOverride-style entry against a hostname.
 * Supports exact match, dot-prefixed/bare suffix match (the NO_PROXY
 * convention: "example.com" and ".example.com" both match
 * "api.example.com"), and simple "*" globs (the Windows ProxyOverride
 * convention: "192.168.*", "*.contoso.com").
 */
export function matchesNoProxyEntry(hostname: string, entry: string): boolean {
  const h = hostname.toLowerCase();
  const e = entry.toLowerCase().trim();
  if (!e) return false;
  if (e === "*") return true;
  if (e.includes("*")) {
    const pattern = "^" + e.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
    return new RegExp(pattern).test(h);
  }
  const normalized = e.startsWith(".") ? e.slice(1) : e;
  return h === normalized || h.endsWith("." + normalized);
}

/** True when `hostname` should bypass the proxy: always-direct ranges, or an explicit noProxy entry. */
export function shouldBypassProxy(hostname: string, noProxy: readonly string[]): boolean {
  if (isAlwaysDirectHost(hostname)) return true;
  return noProxy.some((entry) => matchesNoProxyEntry(hostname, entry));
}
