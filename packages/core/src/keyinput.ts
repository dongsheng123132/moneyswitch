/**
 * The wire fields a key's body carries, as POST /v1/keys (admin, root keys) and
 * POST /v1/keys/children (a key holder) both read them.
 *
 * Before this module the two routes spelled these rules out separately (in
 * apps/server/src/routes/children.ts and, since the admin-key-input-validation
 * patch, in admin.ts as well), so a field could be refused by one and stored by
 * the other. Both routes now call these; a third spelling would drift again.
 *
 * A missing or malformed field throws DelegationError("INVALID_REQUEST", ...)
 * naming the field in snake_case, as it appears on the wire. The routes answer
 * it as 400 INVALID_REQUEST; the core's own callers (see createMoneyKey) reject
 * before any insert, so a bad body never reaches SQLite.
 */
import { isIP } from "node:net";
import { formatMicrosToUsdc, parseUsdcToMicros } from "./money.js";
import { DelegationError } from "./types.js";

/** The body fields these functions read, in the shape a request carries them. */
export interface KeyBody {
  name?: unknown;
  total_budget?: unknown;
  daily_budget?: unknown;
  per_request_limit?: unknown;
  approval_threshold?: unknown;
  allowed_hosts?: unknown;
  max_payments_per_minute?: unknown;
  expires_at?: unknown;
  can_delegate?: unknown;
  network_mode?: unknown;
}

type AmountField = "total_budget" | "daily_budget" | "per_request_limit" | "approval_threshold";

/**
 * `name`: 1-200 characters, trimmed. A key with no name is unfindable on the
 * keys page and in the audit log, so the form's own rule is enforced here too.
 */
export function parseKeyName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DelegationError("INVALID_REQUEST", "name is required (1-200 characters)", { field: "name" });
  }
  const name = raw.trim();
  if (!name || name.length > 200) {
    throw new DelegationError("INVALID_REQUEST", "name is required (1-200 characters)", { field: "name" });
  }
  return name;
}

/**
 * An amount: a decimal USDC string like "1.00", or a finite number (the
 * Dashboard sends strings; an API caller may send 1). Negative values are
 * refused here, not left for the policy engine: a negative limit is a
 * nonsense key, and `parseUsdcToMicros` would read "-1" as 1 in magnitude.
 * `required` distinguishes a missing budget (IS) from an omitted
 * approval_threshold (which means "no threshold" and yields null).
 */
export function parseKeyAmount(raw: unknown, field: AmountField, required: boolean): bigint | null {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new DelegationError("INVALID_REQUEST", `${field} is required`, { field });
    return null;
  }
  let micros: bigint;
  try {
    micros = parseUsdcToMicros(raw as string | number);
  } catch {
    throw new DelegationError("INVALID_REQUEST", `${field} must be a decimal USDC string like "1.00"`, { field });
  }
  if (micros < 0n) {
    throw new DelegationError("INVALID_REQUEST", `${field} must be >= 0`, { field });
  }
  return micros;
}

/**
 * `allowed_hosts`: an array of `host` or `host:port` entries, trimmed; null
 * when the body omitted it (a child then inherits its parent's list; a root
 * key with no entry means "every site asks a person first").
 *
 * A scheme or a path is refused: `isHostListed` compares a normalized
 * host[:port] against the URL's, so "https://api.example.com" or
 * "api.example.com/v1" could never match, and the admin would be shown an
 * entry they believe allows a site that is in fact refused (or asked for
 * approval, forever). A non-array (a string, say) is also refused: a string
 * is iterable, so a row stored that way would later be walked a character at
 * a time by isHostListed.
 *
 * An empty array is allowed: it means "every site asks a person first".
 */
export function parseKeyAllowedHosts(raw: unknown, field = "allowed_hosts"): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((h) => typeof h !== "string" || h.trim() === "")) {
    throw new DelegationError("INVALID_REQUEST", `${field} must be an array of non-empty strings`, { field });
  }
  const hosts = (raw as string[]).map((h) => h.trim());
  for (const h of hosts) {
    if (!isAllowedHostEntry(h)) {
      throw new DelegationError("INVALID_REQUEST", `${field} entry must be host or host:port, not "${h}"`, { field });
    }
  }
  return hosts;
}

/**
 * Is this allowed_hosts entry one the gate can ever match? `host` or
 * `host:port`, and nothing else: no scheme, no path, no userinfo, no
 * whitespace. The host is a name a URL can carry — a DNS name, a single
 * label ("localhost", a host on one's own machine, is real and used), or an
 * IP, bracketed for IPv6.
 */
export function isAllowedHostEntry(entry: string): boolean {
  if (entry === "" || /\s/.test(entry) || entry.includes("/") || entry.includes("@")) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(:(\d+))?$/.exec(entry);
  if (!m) return false;
  const host = m[1];
  if (m[3] !== undefined) {
    const port = Number(m[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  if (host.startsWith("[")) {
    return isIP(host.slice(1, -1)) === 6;
  }
  return isIP(host) !== 0 || isDnsName(host);
}

/**
 * A name a URL can carry: one label or more ("localhost" is one, and a key
 * for a service on the operator's own machine lists it), optionally with the
 * one trailing dot a person may type ("example.com." is the same host).
 */
function isDnsName(host: string): boolean {
  const labels = host.split(".");
  // "example.com." splits to ["example", "com", ""] — the empty last label is the root.
  const named = labels[labels.length - 1] === "" ? labels.slice(0, -1) : labels;
  if (named.length < 1) return false;
  return named.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l));
}

/** `max_payments_per_minute`: a positive integer, or omitted (the caller's default then applies). */
export function parseKeyMaxPaymentsPerMinute(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new DelegationError("INVALID_REQUEST", "max_payments_per_minute must be a positive integer", {
      field: "max_payments_per_minute",
    });
  }
  return raw;
}

/** `expires_at`: an ISO-8601 date-time, or omitted / null ("never expires"). */
export function parseKeyExpiresAt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || Number.isNaN(new Date(raw).getTime())) {
    throw new DelegationError("INVALID_REQUEST", "expires_at must be an ISO-8601 date-time", { field: "expires_at" });
  }
  return raw;
}

/** `can_delegate`: a boolean, or omitted (false). The API is JSON: a string "true" is a mistake, not a wish. */
export function parseKeyCanDelegate(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") {
    throw new DelegationError("INVALID_REQUEST", "can_delegate must be a boolean", { field: "can_delegate" });
  }
  return raw;
}

/** The fields of a key body, already parsed and trimmed: what a creation route hands to createMoneyKey / createChildKey. */
export interface ParsedKeyFields {
  name: string;
  totalBudget: bigint;
  dailyBudget: bigint;
  perRequestLimit: bigint;
  /** null = no threshold: every amount asks a person. */
  approvalThreshold: bigint | null;
  /** Omitted when the body omitted allowed_hosts: a child inherits its parent's list, a root key gets none. */
  allowedHosts?: string[];
  /** undefined = leave the caller's own default / the parent's value alone. */
  maxPaymentsPerMinute?: number;
  expiresAt: string | null;
  canDelegate: boolean;
}

/**
 * Reads every field a key-creation body carries, in one place, in the order
 * the API lists them: the first bad field names itself, and nothing is
 * created.
 *
 * Two things are deliberately NOT decided here:
 *
 * - `approval_threshold` vs `per_request_limit`. A child key may carry a
 *   threshold above its own per-request limit when its parent's limit is
 *   higher, and then the answer is the parent-bound CHILD_EXCEEDS_PARENT,
 *   not INVALID_REQUEST. The parent-bound checks (delegation.ts) run first;
 *   this check is `assertOwnLimits`, and it runs after them.
 * - `allowed_hosts` omitted. That means "inherit the parent's" for a child
 *   and "no hosts" for a root key, so it is left to the caller:
 *   `allowedHosts` is undefined when the body omitted it.
 */
export function parseKeyFields(body: KeyBody): ParsedKeyFields {
  const name = parseKeyName(body.name);
  const totalBudget = parseKeyAmount(body.total_budget, "total_budget", true)!;
  const dailyBudget = parseKeyAmount(body.daily_budget, "daily_budget", true)!;
  const perRequestLimit = parseKeyAmount(body.per_request_limit, "per_request_limit", true)!;
  const approvalThreshold = parseKeyAmount(body.approval_threshold, "approval_threshold", false);
  const allowedHosts = parseKeyAllowedHosts(body.allowed_hosts);
  const maxPaymentsPerMinute = parseKeyMaxPaymentsPerMinute(body.max_payments_per_minute);
  const expiresAt = parseKeyExpiresAt(body.expires_at);
  const canDelegate = parseKeyCanDelegate(body.can_delegate);
  return {
    name,
    totalBudget,
    dailyBudget,
    perRequestLimit,
    approvalThreshold,
    ...(allowedHosts !== null ? { allowedHosts } : {}),
    ...(maxPaymentsPerMinute !== undefined ? { maxPaymentsPerMinute } : {}),
    expiresAt: expiresAt ?? null,
    canDelegate,
  };
}

/**
 * A key's own limits must agree with each other, whatever its parent allows:
 * an approval_threshold above the key's per-request limit would never fire,
 * because every payment that could reach it is refused by the limit first.
 * Called after the parent-bound checks, so a child that breaks both gets the
 * more specific answer.
 */
export function assertOwnLimits(fields: {
  perRequestLimit: bigint;
  approvalThreshold?: bigint | null;
}): void {
  if (fields.approvalThreshold != null && fields.approvalThreshold > fields.perRequestLimit) {
    throw new DelegationError("INVALID_REQUEST", "approval_threshold must be <= per_request_limit", {
      field: "approval_threshold",
    });
  }
}

/**
 * The wire shape of a rejected key-creation request, for both creation routes:
 * `{ error, code, message, field?, parent_value? }`. `message` is the human
 * sentence without the `CODE: ` prefix the error carries internally
 * (DelegationError puts it there for logs; the API names the code separately).
 */
export function keyErrorFields(e: DelegationError): Record<string, unknown> {
  return {
    error: e.code,
    code: e.code,
    message: e.message.replace(/^[A-Z_]+: /, ""),
    ...(e.field ? { field: e.field } : {}),
    ...(e.parentValue !== undefined ? { parent_value: wireValue(e.parentValue) } : {}),
  };
}

/** A parent_value in wire form: a money amount as a decimal string, a host list as it was stored. */
function wireValue(v: unknown): unknown {
  return typeof v === "bigint" ? formatMicrosToUsdc(v) : v;
}
