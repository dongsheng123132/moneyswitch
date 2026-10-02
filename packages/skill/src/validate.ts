/**
 * Input checks shared by the renderers. The rendered text is pasted into an
 * agent and its code blocks get executed, so anything that lands inside a
 * quoted string must not be able to break out of it: URLs and keys are
 * restricted to a safe alphabet instead of being escaped per shell.
 */

const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
// http(s)://host[:port][/path] - host is a DNS name, IPv4 or bracketed IPv6; no userinfo, query or fragment.
const BASE_URL_RE = /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;

/** Trims and strips trailing slashes; throws when the result is not a plain http(s) base URL. */
export function normalizeBaseUrl(raw: string): string {
  const url = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!BASE_URL_RE.test(url)) throw new Error("invalid baseUrl: expected http(s)://host[:port][/prefix]");
  return url;
}

/** Same check without throwing. */
export function isValidBaseUrl(raw: string): boolean {
  try {
    normalizeBaseUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export function assertKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("invalid key: expected letters, digits, '_' or '-' only (a MoneyKey looks like mk_live_...)");
  return key;
}

/** Key names are shown in the skill text; flatten anything that could break markdown inline code. */
export function cleanKeyName(name: string | null | undefined): string | null {
  const n = (name ?? "").replace(/[\r\n\t`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return n || null;
}
