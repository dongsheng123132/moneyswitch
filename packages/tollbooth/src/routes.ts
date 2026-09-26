import { parseUsdc } from "./money.js";

/**
 * SPEC-v0.5 §2 — toll booth price rules, shared by the server's /t/{slug}/*
 * proxy and `moneyswitch sell`.
 *
 * Matching semantics (the "exact rules" the SPEC leaves to the implementation):
 *  - A pattern is a path relative to the toll booth, starting with "/".
 *    Without "*" it is an EXACT path ("/v1/chat/completions"); "*" matches any
 *    run of characters including "/" ("/v1/*", "/files/*.pdf"). A trailing
 *    "/*" also matches the bare prefix ("/v1/*" matches "/v1"). "*" alone
 *    means "everything".
 *  - Longest literal prefix (the text before the first "*") wins; on a tie an
 *    exact pattern beats a wildcard, then a specific method beats ANY.
 *  - HEAD requests also match GET rules (most frameworks, e.g. Express, run
 *    the GET handler for HEAD — a free HEAD would be a way around a GET price).
 *  - Matching is case-insensitive and runs on a NORMALIZED path: dot segments
 *    resolved (also %2e), repeated slashes collapsed, percent-escapes decoded,
 *    trailing slash ignored. The upstream receives exactly the normalized path,
 *    so the path that was priced is the path that is served. Encoded "/" or
 *    "\" (%2F, %5C), backslashes, NUL and control characters are rejected
 *    outright, because upstreams disagree on how to interpret them.
 *  - No rule matched → the toll booth's default price, or "deny" when the
 *    default is null.
 */

export const ROUTE_METHODS = ["ANY", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface TollRoute {
  id?: string;
  method: RouteMethod;
  pathPattern: string;
  /** micro-USDC; 0 = free pass-through. */
  price: bigint;
  description?: string | null;
}

export type RouteDecision =
  | { kind: "free"; route: TollRoute | null }
  | { kind: "paid"; price: bigint; route: TollRoute | null }
  | { kind: "deny" };

export class TollPathError extends Error {
  constructor(public code: "BAD_PATH" | "BAD_PATTERN" | "BAD_METHOD" | "BAD_ROUTE", message: string) {
    super(message);
    this.name = "TollPathError";
  }
}

export function normalizeMethod(method: string): RouteMethod {
  const m = String(method ?? "").trim().toUpperCase();
  if (m === "" || m === "*") return "ANY";
  if (!(ROUTE_METHODS as readonly string[]).includes(m)) {
    throw new TollPathError("BAD_METHOD", `Unsupported method "${method}" (use ${ROUTE_METHODS.join(", ")})`);
  }
  return m as RouteMethod;
}

/** Validates and canonicalizes a path pattern ("*" → "/*", repeated slashes collapsed). */
export function normalizePathPattern(pattern: string): string {
  let p = String(pattern ?? "").trim();
  if (p === "" || p === "*") return "/*";
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 512) throw new TollPathError("BAD_PATTERN", "Path pattern is too long (max 512 characters)");
  if (/[\s?#\\%\x00-\x1f\x7f]/.test(p)) {
    throw new TollPathError("BAD_PATTERN", `Path pattern "${pattern}" may not contain spaces, ?, #, %, or backslashes`);
  }
  p = p.replace(/\/{2,}/g, "/");
  if (p.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new TollPathError("BAD_PATTERN", `Path pattern "${pattern}" may not contain . or .. segments`);
  }
  return p;
}

export interface NormalizedPath {
  /** Path sent to the upstream: dot segments resolved, slashes collapsed, still percent-encoded. */
  forwardPath: string;
  /** Path used for rule matching: decoded, lower-case, no trailing slash (except "/"). */
  matchPath: string;
}

/** Normalizes a request path (no query string). Throws TollPathError("BAD_PATH") on anything ambiguous. */
export function normalizeRequestPath(rawPath: string): NormalizedPath {
  let p = rawPath === "" ? "/" : rawPath;
  if (/[\\\x00-\x1f\x7f]/.test(p) || /%(2f|5c|00)/i.test(p)) {
    throw new TollPathError("BAD_PATH", "Encoded slashes, backslashes and control characters are not allowed in the path");
  }
  if (!p.startsWith("/")) p = "/" + p;
  // Collapse repeated slashes first: "//host/x" would otherwise be parsed as
  // a protocol-relative URL below.
  p = p.replace(/\/{2,}/g, "/");
  // WHATWG URL resolves "." / ".." segments, including their %2e spellings.
  const forwardPath = new URL(p, "http://tollbooth.invalid").pathname.replace(/\/{2,}/g, "/");
  let decoded: string;
  try {
    decoded = forwardPath
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    throw new TollPathError("BAD_PATH", "Malformed percent-encoding in the path");
  }
  if (decoded.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new TollPathError("BAD_PATH", "Dot segments are not allowed in the path");
  }
  let matchPath = decoded.toLowerCase();
  if (matchPath.length > 1) matchPath = matchPath.replace(/\/+$/, "") || "/";
  return { forwardPath, matchPath };
}

interface CompiledRoute {
  route: TollRoute;
  literalPrefixLength: number;
  exact: boolean;
  specificMethod: boolean;
  test: (matchPath: string) => boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(route: TollRoute): CompiledRoute {
  const pattern = normalizePathPattern(route.pathPattern).toLowerCase();
  const star = pattern.indexOf("*");
  const specificMethod = route.method !== "ANY";
  if (star === -1) {
    const target = pattern.length > 1 ? pattern.replace(/\/+$/, "") || "/" : pattern;
    return { route, literalPrefixLength: target.length, exact: true, specificMethod, test: (p) => p === target };
  }
  let body: string;
  if (pattern.endsWith("/*") && pattern.indexOf("*") === pattern.length - 1) {
    // "/v1/*" → "/v1" or "/v1/<anything>"; "/*" → everything.
    const base = pattern.slice(0, -2);
    body = base === "" ? ".*" : `${escapeRegex(base)}(?:/.*)?`;
  } else {
    body = pattern.split("*").map(escapeRegex).join(".*");
  }
  const re = new RegExp(`^${body}$`);
  return { route, literalPrefixLength: star, exact: false, specificMethod, test: (p) => re.test(p) };
}

function methodMatches(routeMethod: RouteMethod, method: string): boolean {
  if (routeMethod === "ANY") return true;
  if (routeMethod === method) return true;
  return method === "HEAD" && routeMethod === "GET";
}

/** Picks the most specific matching rule; see the file header for the exact semantics. */
export function matchRoute(
  routes: TollRoute[],
  method: string,
  matchPath: string,
  defaultPrice: bigint | null
): RouteDecision {
  const m = String(method).toUpperCase();
  const candidates = routes
    .map(compile)
    .filter((c) => methodMatches(c.route.method, m) && c.test(matchPath))
    .sort(
      (a, b) =>
        b.literalPrefixLength - a.literalPrefixLength ||
        Number(b.exact) - Number(a.exact) ||
        Number(b.specificMethod) - Number(a.specificMethod)
    );
  const best = candidates[0];
  if (best) {
    return best.route.price > 0n ? { kind: "paid", price: best.route.price, route: best.route } : { kind: "free", route: best.route };
  }
  if (defaultPrice == null) return { kind: "deny" };
  return defaultPrice > 0n ? { kind: "paid", price: defaultPrice, route: null } : { kind: "free", route: null };
}

/**
 * Parses a CLI rule "POST /v1/chat/completions=0.01", "/health=0" (any
 * method) or "GET /files/*=0.5". Price is in USDC ("free" = 0).
 */
export function parseRouteSpec(spec: string): TollRoute {
  const s = String(spec ?? "").trim();
  const eq = s.lastIndexOf("=");
  if (eq <= 0) throw new TollPathError("BAD_ROUTE", `Rule "${spec}" must look like "POST /v1/chat/completions=0.01"`);
  const left = s.slice(0, eq).trim();
  const priceText = s.slice(eq + 1).trim();
  const parts = left.split(/\s+/);
  let method: RouteMethod = "ANY";
  let pattern: string;
  if (parts.length === 1) {
    pattern = parts[0];
  } else if (parts.length === 2) {
    method = normalizeMethod(parts[0]);
    pattern = parts[1];
  } else {
    throw new TollPathError("BAD_ROUTE", `Rule "${spec}" must look like "POST /v1/chat/completions=0.01"`);
  }
  let price: bigint;
  try {
    price = priceText.toLowerCase() === "free" ? 0n : parseUsdc(priceText);
  } catch {
    throw new TollPathError("BAD_ROUTE", `Rule "${spec}": "${priceText}" is not a USDC amount like 0.01`);
  }
  return { method, pathPattern: normalizePathPattern(pattern), price };
}

/** Splits "/t/<slug>/<rest>?<query>" (server entry point). Returns null if the URL is not a toll booth URL. */
export function splitTollboothUrl(rawUrl: string): { slug: string; rest: string; search: string } | null {
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const search = q === -1 ? "" : rawUrl.slice(q);
  const m = /^\/t\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  return { slug, rest: m[2] ?? "/", search };
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Derives a URL-safe slug from a display name ("My Weather API" → "my-weather-api"). */
export function slugify(name: string): string {
  const s = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s;
}
