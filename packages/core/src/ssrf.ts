import { isIP } from "node:net";
import { MoneySwitchError } from "./types.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

function isPrivateOrLoopbackIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateOrLoopbackIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80");
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  if (isIP(h) === 4) return isPrivateOrLoopbackIPv4(h);
  if (isIP(h) === 6) return isPrivateOrLoopbackIPv6(h);
  return false;
}

export interface SsrfGuardOptions {
  /** The port MoneySwitch server itself listens on (e.g. 4020). */
  selfPort: number;
  /** Explicit allowed "host:port" or bare host entries from the MoneyKey. */
  allowedHosts: string[];
}

/**
 * SSRF guard per SPEC §6 step 2:
 * - Always reject requests targeting MoneySwitch's own listening address,
 *   in any IP/hostname form, on selfPort — allowlist can never override this.
 * - Private-network/loopback hosts are otherwise allowed ONLY if allowed_hosts
 *   explicitly lists that exact host:port (this is how demo-seller, running
 *   locally, is permitted).
 */
export function assertNotSsrf(url: URL, opts: SsrfGuardOptions): void {
  const hostname = url.hostname;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  if (LOOPBACK_HOSTNAMES.has(hostname.toLowerCase()) && port === opts.selfPort) {
    throw new MoneySwitchError("SSRF_BLOCKED", "Refusing to target MoneySwitch's own listening address");
  }
  if (isIP(hostname) === 4 && isPrivateOrLoopbackIPv4(hostname) && port === opts.selfPort) {
    throw new MoneySwitchError("SSRF_BLOCKED", "Refusing to target MoneySwitch's own listening address");
  }

  if (isLoopbackOrPrivateHost(hostname)) {
    const hostPort = `${hostname}:${port}`;
    const allowed = opts.allowedHosts.some(
      (h) => h.toLowerCase() === hostPort.toLowerCase() || h.toLowerCase() === hostname.toLowerCase()
    );
    if (!allowed) {
      throw new MoneySwitchError(
        "SSRF_BLOCKED",
        "Private/loopback host is not explicitly allow-listed as host:port"
      );
    }
  }
}
