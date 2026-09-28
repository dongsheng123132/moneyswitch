import { execFileSync } from "node:child_process";

export type RegValueName = "ProxyEnable" | "ProxyServer" | "ProxyOverride";

/** Injectable so tests never touch the real registry (see resolve.test.ts / windows-proxy.test.ts). */
export type RegQueryFn = (valueName: RegValueName) => string | null;

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * Real `reg query` output looks like (captured on a live machine):
 *
 *   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *       ProxyEnable    REG_DWORD    0x1
 *
 * Returns raw stdout, or null when the value/key doesn't exist (reg.exe
 * exits non-zero) or `reg` itself can't be found (non-Windows).
 */
export function defaultRegQuery(valueName: RegValueName): string | null {
  try {
    return execFileSync("reg", ["query", REG_KEY, "/v", valueName], { encoding: "utf8", windowsHide: true });
  } catch {
    return null;
  }
}

function extractRegValue(output: string, regType: "REG_DWORD" | "REG_SZ"): string | null {
  const line = output.split(/\r?\n/).find((l) => l.includes(regType));
  if (!line) return null;
  const idx = line.indexOf(regType);
  const value = line.slice(idx + regType.length).trim();
  return value.length > 0 ? value : null;
}

function normalizeHostPort(hostPort: string): string {
  const trimmed = hostPort.trim();
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

/**
 * ProxyServer is either a single "host:port" (applies to every protocol) or
 * a "proto=host:port;proto=host:port;..." list (IE/Windows "Advanced" proxy
 * settings, e.g. "http=127.0.0.1:7897;https=127.0.0.1:7897;ftp=...")).
 * Prefers https, falls back to http; ftp/socks entries are ignored (v0.5
 * only speaks HTTP(S) CONNECT proxies).
 */
export function parseProxyServerValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("=")) {
    const map = new Map<string, string>();
    for (const part of trimmed.split(";")) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      if (eq === -1) continue;
      map.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
    }
    const chosen = map.get("https") ?? map.get("http");
    return chosen ? normalizeHostPort(chosen) : null;
  }
  return normalizeHostPort(trimmed);
}

/**
 * ProxyOverride is a ";"-separated bypass list, e.g.
 * ";localhost.*;;localhost;127.*;192.168.*;10.*;172.16.*;...;172.31.*;<local>"
 * (captured on a live machine). Empty segments are dropped; the special
 * "<local>" token (Windows shorthand for "hostnames with no dot in them")
 * has no direct equivalent in our noProxy matcher and is dropped too — the
 * hard-coded private-range bypass already covers the RFC1918/loopback
 * entries Windows lists explicitly here.
 */
export function parseProxyOverride(raw: string): string[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "<local>");
}

export interface WindowsSystemProxy {
  url: string | null;
  noProxy: string[];
}

/** Reads ProxyEnable/ProxyServer/ProxyOverride from HKCU\...\Internet Settings; null when the system proxy is off or unset. */
export function readWindowsSystemProxy(regQuery: RegQueryFn = defaultRegQuery): WindowsSystemProxy | null {
  const enableRaw = regQuery("ProxyEnable");
  if (!enableRaw) return null;
  const enableValue = extractRegValue(enableRaw, "REG_DWORD");
  const enabled = enableValue != null && parseInt(enableValue, 16) === 1;
  if (!enabled) return null;

  const serverRaw = regQuery("ProxyServer");
  const serverValue = serverRaw ? extractRegValue(serverRaw, "REG_SZ") : null;
  const url = serverValue ? parseProxyServerValue(serverValue) : null;

  const overrideRaw = regQuery("ProxyOverride");
  const overrideValue = overrideRaw ? extractRegValue(overrideRaw, "REG_SZ") : null;
  const noProxy = overrideValue ? parseProxyOverride(overrideValue) : [];

  return { url, noProxy };
}
