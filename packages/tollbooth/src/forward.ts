/**
 * SPEC-v0.5 §2 step 3 — forwarding a (paid or free) request to the seller's
 * upstream, shared by the server's /t/{slug}/* proxy and `moneyswitch sell`.
 *
 *  - never follows redirects (redirect: "manual"), 30 s timeout, 10 MB cap;
 *  - request: hop-by-hop headers, the buyer's Authorization / Cookie, every
 *    x402 payment header, method-override headers and any client-supplied
 *    X-MoneySwitch-* / X-Forwarded-* are stripped; X-MoneySwitch-Payer /
 *    -Amount / -Tollbooth and fresh X-Forwarded-* are added;
 *  - response: hop-by-hop, Set-Cookie, encoding/length and any x402 header the
 *    upstream might try to spoof are stripped; the page is sandboxed
 *    (CSP: sandbox) because it is served from MoneySwitch's own origin.
 */

export const UPSTREAM_TIMEOUT_MS = 30_000;
export const UPSTREAM_MAX_BYTES = 10 * 1024 * 1024;

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

/** x402 v1 + v2 payment headers, in both directions. */
export const X402_HEADERS = ["payment-signature", "x-payment", "payment-required", "payment-response", "x-payment-response"];

const STRIP_REQUEST = new Set([
  ...HOP_BY_HOP,
  ...X402_HEADERS,
  "host",
  "authorization",
  "cookie",
  "content-length",
  "expect",
  "accept-encoding",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "forwarded",
  "x-real-ip",
]);

const STRIP_RESPONSE = new Set([
  ...HOP_BY_HOP,
  ...X402_HEADERS,
  "set-cookie",
  "set-cookie2",
  "content-length",
  "content-encoding",
  "access-control-allow-credentials",
]);

export type HeaderBag = Record<string, string | string[] | undefined>;

function connectionListed(headers: HeaderBag): Set<string> {
  const raw = headers["connection"];
  const value = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface ForwardMeta {
  /** Toll booth slug (or name for `moneyswitch sell`). */
  tollbooth: string;
  /** Verified payer address; null for free routes. */
  payer: string | null;
  /** Price in USDC decimal ("0.01"); "0" for free routes. */
  amount: string;
  /** Public host the buyer called (X-Forwarded-Host), e.g. "pay.example.com". */
  publicHost?: string;
  publicProto?: "http" | "https";
  clientIp?: string;
  /** Keep the buyer's Host header instead of the upstream's own host (default false). */
  forwardHostHeader?: boolean;
}

/** Builds the header set sent to the upstream. Input keys may be any case. */
export function buildUpstreamRequestHeaders(incoming: HeaderBag, meta: ForwardMeta): Record<string, string> {
  const lower: HeaderBag = {};
  for (const [k, v] of Object.entries(incoming)) lower[k.toLowerCase()] = v;
  const listed = connectionListed(lower);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(lower)) {
    if (v === undefined) continue;
    if (STRIP_REQUEST.has(k) || listed.has(k)) continue;
    if (k.startsWith("x-moneyswitch-") || k.startsWith("x-forwarded-")) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (meta.forwardHostHeader && typeof lower["host"] === "string") out["host"] = lower["host"];
  out["x-moneyswitch-tollbooth"] = meta.tollbooth;
  out["x-moneyswitch-amount"] = meta.amount;
  if (meta.payer) out["x-moneyswitch-payer"] = meta.payer;
  if (meta.publicHost) out["x-forwarded-host"] = meta.publicHost;
  if (meta.publicProto) out["x-forwarded-proto"] = meta.publicProto;
  if (meta.clientIp) out["x-forwarded-for"] = meta.clientIp;
  return out;
}

/** Filters upstream response headers before they go back to the buyer. */
export function buildBuyerResponseHeaders(upstream: Headers | Record<string, string>): Record<string, string> {
  const entries: Array<[string, string]> =
    upstream instanceof Headers ? [...upstream.entries()] : Object.entries(upstream);
  const lower: HeaderBag = Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v]));
  const listed = connectionListed(lower);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (STRIP_RESPONSE.has(key) || listed.has(key)) continue;
    if (key.startsWith("x-moneyswitch-")) continue;
    out[key] = v;
  }
  // Served from MoneySwitch's own origin: an HTML/JS response from the
  // upstream must not be able to read the Dashboard's storage or cookies.
  out["content-security-policy"] = "sandbox";
  out["x-content-type-options"] = "nosniff";
  return out;
}

export class UpstreamUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamUrlError";
  }
}

/** Validates an upstream base URL (http/https, no credentials, no query/fragment). Returns it without a trailing slash. */
export function normalizeUpstreamUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new UpstreamUrlError("Upstream must be a full URL like http://localhost:8000 or https://api.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UpstreamUrlError("Upstream must start with http:// or https://");
  }
  if (url.username || url.password) {
    throw new UpstreamUrlError("Upstream URL may not contain a username or password");
  }
  if (url.search || url.hash) {
    throw new UpstreamUrlError("Upstream URL may not contain ?query or #fragment — use the base address only");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Joins the upstream base with the (already normalized) forward path + query; guarantees the origin cannot change. */
export function joinUpstreamUrl(upstreamBase: string, forwardPath: string, search: string): URL {
  const base = new URL(upstreamBase);
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = new URL(base.origin);
  target.pathname = basePath + (forwardPath.startsWith("/") ? forwardPath : "/" + forwardPath);
  target.search = search && search !== "?" ? search : "";
  if (target.origin !== base.origin) throw new UpstreamUrlError("Upstream URL escaped its origin");
  return target;
}

/**
 * Rewrites an upstream redirect Location that points inside the upstream
 * into the toll booth's public URL space, so buyers never learn the internal
 * address and stay behind the toll booth. Anything else is passed as-is.
 */
export function rewriteLocation(location: string, upstreamBase: string, publicBase: string): string {
  try {
    const base = new URL(upstreamBase);
    const loc = new URL(location, upstreamBase);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (loc.origin === base.origin && (loc.pathname === basePath || loc.pathname.startsWith(basePath + "/") || basePath === "")) {
      const rest = basePath === "" ? loc.pathname : loc.pathname.slice(basePath.length) || "/";
      return publicBase.replace(/\/+$/, "") + rest + loc.search + loc.hash;
    }
    return location;
  } catch {
    return location;
  }
}

export type UpstreamFailure = "UPSTREAM_TIMEOUT" | "UPSTREAM_TOO_LARGE" | "UPSTREAM_UNREACHABLE";

export class UpstreamError extends Error {
  constructor(public code: UpstreamFailure, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface ForwardOptions {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** Sends the request upstream and reads the whole response (bounded). Never follows redirects. */
export async function forwardToUpstream(opts: ForwardOptions): Promise<UpstreamResponse> {
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? UPSTREAM_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = opts.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && opts.body != null && opts.body.length > 0;
  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(opts.url, {
        method,
        headers: opts.headers,
        body: hasBody ? new Uint8Array(opts.body!) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT", `Upstream did not answer within ${timeoutMs / 1000}s`);
      throw new UpstreamError("UPSTREAM_UNREACHABLE", `Upstream is unreachable: ${(e as Error)?.cause ?? (e as Error)?.message ?? e}`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      controller.abort();
      throw new UpstreamError("UPSTREAM_TOO_LARGE", `Upstream response exceeds ${maxBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            throw new UpstreamError("UPSTREAM_TOO_LARGE", `Upstream response exceeds ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e instanceof UpstreamError) throw e;
        if (controller.signal.aborted) throw new UpstreamError("UPSTREAM_TIMEOUT", `Upstream did not finish within ${timeoutMs / 1000}s`);
        throw new UpstreamError("UPSTREAM_UNREACHABLE", `Upstream connection failed: ${(e as Error)?.message ?? e}`);
      }
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP status the buyer sees when the upstream itself failed. */
export function statusForUpstreamFailure(code: UpstreamFailure): number {
  return code === "UPSTREAM_TIMEOUT" ? 504 : 502;
}
