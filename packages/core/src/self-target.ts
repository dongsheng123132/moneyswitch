import { isIP } from "node:net";
import os from "node:os";
import { lookup } from "node:dns/promises";

/**
 * "Does this URL point back at this very process?" — the self-port SSRF rule
 * (assertNotSsrf): a payment request must never target MoneySwitch's own port,
 * in any spelling of the address, or an agent could reach the admin API through
 * /v1/fetch.
 */

const LOOPBACK_NAMES = new Set(["localhost", "localhost.", "0.0.0.0", "::", "::1", "[::]", "[::1]"]);

function stripBrackets(h: string): string {
  return h.replace(/^\[|\]$/g, "");
}

/** IPv4 loopback / private / link-local / unspecified. */
export function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

/** Maps "::ffff:7f00:1" / "::ffff:127.0.0.1" to "127.0.0.1"; null if not IPv4-mapped. */
export function ipv4FromMapped(ip: string): string | null {
  const s = stripBrackets(ip).toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const s = stripBrackets(ip).toLowerCase();
  const mapped = ipv4FromMapped(s);
  if (mapped) return isPrivateOrLoopbackIPv4(mapped);
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80");
}

/** Hostname (as in URL.hostname) is loopback, private, link-local or unspecified. */
export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  const bare = stripBrackets(h);
  if (isIP(bare) === 4) return isPrivateOrLoopbackIPv4(bare);
  if (isIP(bare) === 6) return isPrivateOrLoopbackIPv6(bare);
  return false;
}

export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** Addresses bound to this machine's network interfaces (so a LAN/public IP of this host counts as "self"). */
export function localInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) out.add(a.address.toLowerCase());
    }
  } catch {
    // ignore — interface enumeration is best-effort
  }
  return out;
}

export function isSelfAddress(host: string, localAddrs: Set<string>): boolean {
  const bare = stripBrackets(host.toLowerCase());
  if (LOOPBACK_NAMES.has(host.toLowerCase()) || LOOPBACK_NAMES.has(bare)) return true;
  const mapped = ipv4FromMapped(bare);
  const ip = mapped ?? bare;
  if (isIP(ip) === 4 && isPrivateOrLoopbackIPv4(ip)) return true;
  if (isIP(ip) === 6 && isPrivateOrLoopbackIPv6(ip)) return true;
  return localAddrs.has(ip);
}

/**
 * Synchronous check: the URL names this machine (loopback / private /
 * one of our interface addresses, in any spelling) on `selfPort`.
 */
export function isSelfTarget(url: URL, selfPort: number): boolean {
  if (effectivePort(url) !== selfPort) return false;
  return isSelfAddress(url.hostname, localInterfaceAddresses());
}

/**
 * Same as isSelfTarget, but also resolves the hostname via DNS — catches
 * names like "127.0.0.1.nip.io" or a hosts-file alias that point back at us.
 * DNS failures are not "self" (the request will simply fail to connect).
 */
export async function isSelfTargetResolved(url: URL, selfPort: number): Promise<boolean> {
  if (effectivePort(url) !== selfPort) return false;
  const localAddrs = localInterfaceAddresses();
  if (isSelfAddress(url.hostname, localAddrs)) return true;
  const bare = stripBrackets(url.hostname);
  if (isIP(bare)) return false;
  try {
    const addrs = await lookup(bare, { all: true });
    return addrs.some((a) => isSelfAddress(a.address, localAddrs));
  } catch {
    return false;
  }
}
