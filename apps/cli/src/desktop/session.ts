import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Local UI authentication (SPEC-v0.4 §B 形态):
 *
 *  1. On start we mint a one-time token and open
 *     `http://127.0.0.1:<port>/#<token>` — the fragment never reaches the
 *     server's access logs or the Referer header.
 *  2. The page POSTs the token to /api/session; we burn it and answer with an
 *     httpOnly, SameSite=Strict session cookie.
 *  3. Every /api/* call needs that cookie. Every state-changing call also
 *     needs an Origin header equal to this server's own origin and a JSON
 *     content type, so another local process's web page cannot CSRF it, and
 *     the Host header must be the loopback address we bound (DNS-rebinding).
 *
 * Other local *processes* (e.g. an agent with shell access) can still read
 * ~/.moneyswitch/desktop.json directly — that file is protected by OS file
 * permissions, not by this layer. What this layer prevents is a process or
 * page that can only speak HTTP to 127.0.0.1 silently rewriting agent configs.
 */
export const COOKIE_NAME = "ms_desktop_session";

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class SessionManager {
  private oneTimeToken: string | null;
  private readonly sessions = new Map<string, { createdAt: number }>();

  constructor(
    readonly port: number,
    token: string = randomToken()
  ) {
    this.oneTimeToken = token;
  }

  /** The token to put in the launch URL fragment. Null once it has been used. */
  get pendingToken(): string | null {
    return this.oneTimeToken;
  }

  /** Mint a fresh one-time token (e.g. `moneyswitch ui` asked to re-open the browser). */
  rotateToken(): string {
    this.oneTimeToken = randomToken();
    return this.oneTimeToken;
  }

  /** Exchange the one-time token for a session id. Returns null if wrong or already used. */
  exchange(token: unknown): string | null {
    if (typeof token !== "string" || !this.oneTimeToken) return null;
    if (!safeEqual(token, this.oneTimeToken)) return null;
    this.oneTimeToken = null;
    const sid = randomToken();
    this.sessions.set(sid, { createdAt: Date.now() });
    return sid;
  }

  isValid(sid: string | null | undefined): boolean {
    return typeof sid === "string" && this.sessions.has(sid);
  }

  revoke(sid: string): void {
    this.sessions.delete(sid);
  }

  cookieHeader(sid: string): string {
    return `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** Origins this server accepts (exact match, scheme+host+port). */
  allowedOrigins(): string[] {
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
  }

  allowedHosts(): string[] {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export type GuardFailure = { status: number; code: string; message: string };

/**
 * Decide whether a request may proceed. Pure (only reads headers) so it can
 * be unit-tested without a socket.
 *  - host:    all requests (DNS rebinding protection)
 *  - session: all /api/* except POST /api/session
 *  - origin:  all non-GET/HEAD requests, including POST /api/session
 */
export function guardRequest(
  sm: SessionManager,
  req: Pick<IncomingMessage, "method" | "headers" | "url">
): GuardFailure | null {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!sm.allowedHosts().includes(host)) {
    return { status: 421, code: "BAD_HOST", message: "unexpected Host header" };
  }
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "/";
  const isApi = url.startsWith("/api/");
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (isApi && mutating) {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !sm.allowedOrigins().includes(origin)) {
      return { status: 403, code: "BAD_ORIGIN", message: "cross-origin request refused" };
    }
    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.toLowerCase().startsWith("application/json")) {
      return { status: 415, code: "JSON_REQUIRED", message: "Content-Type must be application/json" };
    }
  }
  if (isApi && !(method === "POST" && url.split("?")[0] === "/api/session")) {
    const sid = readCookie(req.headers.cookie, COOKIE_NAME);
    if (!sm.isValid(sid)) return { status: 401, code: "NO_SESSION", message: "open the link printed by `moneyswitch ui`" };
  }
  return null;
}
