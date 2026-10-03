// Where the login page sends the administrator afterwards, and how the one-time setup link of the first start is recognised.
//
// SPEC.md §3: the approval link carries no token. Whoever opens /approvals?id=… without being logged in is sent to
// /login?next=/approvals%3Fid%3D…, logs in with the administrator token, and lands back on that approval.

/** Where a login without a destination ends up: the Wallet page (SPEC.md §2: first use is login -> create the wallet). */
export const LANDING_PATH = "/wallet";

/** Only in-app paths ("/approvals?id=…"): no scheme or host, no backslash or control character, and never the login page itself. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const next = raw.trim();
  if (next.length === 0 || next.length > 500) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(next)) return null;
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login#")) return null;
  return next;
}

/** "/login?next=%2Fapprovals%3Fid%3D…" for a protected page; plain "/login" when there is nothing worth coming back to. */
export function loginUrlFor(pathname: string, search = ""): string {
  const next = safeNextPath(`${pathname}${search}`);
  return next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/** The setup token of the one-time link the server prints on its first start (".../login#ms_setup_…"), else null. */
export function setupTokenFromHash(hash: string | null | undefined): string | null {
  const m = /^#(ms_setup_[A-Za-z0-9]{8,64})(?:&.*)?$/.exec(hash ?? "");
  return m ? m[1] : null;
}
