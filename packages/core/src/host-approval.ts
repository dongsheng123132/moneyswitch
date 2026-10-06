import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { and, eq, gte } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { createApproval, decideApproval, getApproval } from "./approval.js";
import { writeAudit } from "./audit.js";
import { effectiveStatus, getKeyChain } from "./chain.js";
import { effectivePort, isSelfAddress, localInterfaceAddresses } from "./self-target.js";
import { getMoneyKeyById } from "./keys.js";
import { MoneySwitchError, type ApprovalRow } from "./types.js";

/**
 * A new host asks a person (SPEC.md §3): a /v1/fetch to an http(s) host outside the key's allowed hosts waits on a 'host' approval, and
 * approving it appends that host:port to the (root) key's allowed hosts. Nothing is sent to the host before that, and the price is
 * checked as always once the seller quotes.
 */

/** At most this many unexpired pending 'host' approvals per key; the next new host is RATE_LIMITED. */
export const MAX_PENDING_HOST_APPROVALS = 5;

/** The one DNS look, made at approval time and nowhere else, gives up after this long and counts as a failure. */
export const HOST_LOOKUP_TIMEOUT_MS = 3000;

// IPv4 ranges that are not public unicast, as [first address, prefix length].
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT; some clouds put their metadata service here)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255
];

function v4ToNumber(a: string): number {
  const [p, q, r, s] = a.split(".").map(Number);
  return ((p << 24) | (q << 16) | (r << 8) | s) >>> 0;
}

function nonPublicV4(n: number): boolean {
  return NON_PUBLIC_V4.some(([base, bits]) => n >>> (32 - bits) === v4ToNumber(base) >>> (32 - bits));
}

/** The eight 16-bit groups of an IPv6 address (no brackets, no zone); null if it is not one. */
function v6Groups(s: string): number[] | null {
  if (isIP(s) !== 6) return null;
  let head = s;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number); // an embedded dotted IPv4 ("::ffff:10.0.0.1") is two more groups
    head = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [l, r] = head.split("::");
  const left = l ? l.split(":") : [];
  const right = r ? r.split(":") : [];
  const zeros = r === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

/**
 * Is this host something other than a public unicast address: a literal address in a special-use range, or a name that is always local
 * (`localhost`, `*.localhost`)? Any other name is not judged here (false): only its DNS answer can say, see approveHostApproval.
 * `host` is a URL hostname or a bare address, any case, IPv6 with or without brackets.
 *
 * IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
 * 224/4, 240/4 (which holds 255.255.255.255). IPv6: ::/96 (:: and ::1; the deprecated IPv4-compatible form is never public either),
 * 100::/64 (discard-only), 2001::/32 (Teredo), 2001:db8::/32, 3fff::/20 (documentation), fc00::/7, fe80::/10, fec0::/10, ff00::/8, and
 * the whole of 64:ff9b:1::/48 (local-use NAT64: where the IPv4 sits depends on the prefix, so none of it is trusted); the IPv4 inside
 * ::ffff:0:0/96, ::ffff:0:0:0/96 (SIIT), 64:ff9b::/96 and 2002::/16 is judged by the IPv4 rules.
 */
export function isNonPublicAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "").replace(/%.*$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return nonPublicV4(v4ToNumber(h));
  const g = v6Groups(h);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => nonPublicV4(((hi << 16) | lo) >>> 0);
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return (
    (g[0] & 0xfe00) === 0xfc00 ||
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xffc0) === 0xfec0 ||
    (g[0] & 0xff00) === 0xff00 ||
    (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) ||
    (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) ||
    (g[0] === 0x3fff && (g[1] & 0xf000) === 0) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)
  );
}

/** A URL's hostname as a key's allowed_hosts and the gate compare it: lower-case, without the one trailing dot ("example.com." is "example.com"). */
export function normalizedHostname(url: URL): string {
  const h = url.hostname.toLowerCase();
  return h.length > 1 && h.endsWith(".") ? h.slice(0, -1) : h;
}

/** The form a key's allowed_hosts entry takes: normalizedHostname, port always explicit (https -> 443, http -> 80). */
export function hostPortOf(url: URL): string {
  return `${normalizedHostname(url)}:${effectivePort(url)}`;
}

/**
 * An allowed_hosts entry as it is compared (written by hand when the key was issued, so any case, any trailing dot): lower-case, one
 * trailing dot dropped from its host part, as normalizedHostname does for a URL: "example.com." is "example.com" and "example.com.:443"
 * is "example.com:443". A bracketed IPv6 entry and a lone "." stay as they are.
 */
export function normalizedAllowedEntry(entry: string): string {
  return entry.toLowerCase().replace(/^([^[].*)\.(:\d+)?$/, "$1$2");
}

/**
 * Does the key's allowed_hosts list this URL's host: as the entry host:port (port explicit) or as the bare host (any port)? The one
 * comparison for the gate and for approving a new host, so that what is asked for and what is allowed can never be spelled apart: a
 * dot, in the entry or in the URL, makes no other host.
 */
export function isHostListed(url: URL, allowedHosts: string[]): boolean {
  const hostPort = hostPortOf(url);
  const hostname = normalizedHostname(url);
  return allowedHosts.some((h) => {
    const entry = normalizedAllowedEntry(h);
    return entry === hostPort || entry === hostname;
  });
}

function hostPortOfString(url: string): string | null {
  try {
    return hostPortOf(new URL(url));
  } catch {
    return null;
  }
}

/**
 * The host:port that approving this approval adds to the key's list, for a 'host' approval (the very value approveHostApproval appends,
 * so that what a person is shown is what gets listed); null for a payment approval.
 */
export function hostOfApproval(approval: Pick<ApprovalRow, "kind" | "url">): string | null {
  return approval.kind === "host" ? hostPortOfString(approval.url) : null;
}

/** What a request to a host outside the key's allowed hosts is recorded with: the paying key and the exact url, method and body. */
export interface HostApprovalContext {
  keyId: string;
  url: string;
  method: string;
  body: unknown;
}

/**
 * The approval a /v1/fetch to a host outside the key's allowed hosts waits on. It exists before any request goes out, so there is no
 * price yet: network / asset / pay_to are stored as '' and amount as 0 (the columns are NOT NULL); `url` is the request's own, for
 * display. Same 10-minute TTL as every approval.
 *
 * One pending approval per key and host:port: asking again returns the one that is already waiting (its url, method and body are the
 * first request's). A key with MAX_PENDING_HOST_APPROVALS unexpired pending ones gets RATE_LIMITED for any further new host. Nothing
 * here awaits, and the look and the insert are one transaction.
 */
export function createHostApproval(
  sqlite: { exec(sql: string): unknown },
  db: MoneySwitchDb,
  ctx: HostApprovalContext
): ApprovalRow {
  const hostPort = hostPortOf(new URL(ctx.url));
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const pending = db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.keyId, ctx.keyId),
          eq(schema.approvals.kind, "host"),
          eq(schema.approvals.status, "pending"),
          gte(schema.approvals.expiresAt, new Date().toISOString())
        )
      )
      .all();
    const same = pending.find((p) => hostPortOfString(p.url) === hostPort);
    if (same) {
      sqlite.exec("COMMIT");
      return getApproval(db, same.id)!;
    }
    if (pending.length >= MAX_PENDING_HOST_APPROVALS) {
      // limit_scope "self" like checkRateLimit's own: it is this key's limit (new hosts are only ever asked for by a root key)
      throw new MoneySwitchError("RATE_LIMITED", `This key already has ${MAX_PENDING_HOST_APPROVALS} new hosts waiting for approval`, {
        scope: "self",
        keyPrefix: getMoneyKeyById(db, ctx.keyId)!.keyPrefix, // (it has pending approvals, so it exists)
      });
    }
    const row = createApproval(db, { ...ctx, network: "", asset: "", payTo: "", amount: 0n, kind: "host" });
    sqlite.exec("COMMIT");
    return row;
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}

export type AllowHostErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_PENDING"
  | "ALLOW_HOST_CHILD_KEY"
  | "ALLOW_HOST_KEY_NOT_ACTIVE"
  | "ALLOW_HOST_PRIVATE_HOST"
  | "ALLOW_HOST_UNRESOLVED";

/** Why approving a new host was refused. Nothing was decided or changed; a refused DNS look leaves the approval pending. */
export class AllowHostError extends Error {
  code: AllowHostErrorCode;
  constructor(code: AllowHostErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AllowHostError";
  }
}

/** The pending, unexpired 'host' approval and its key, or an AllowHostError: only a ROOT key's list can be widened, and only while the key is usable. */
function approvableHost(db: MoneySwitchDb, approvalId: string) {
  const row = getApproval(db, approvalId);
  if (!row) throw new AllowHostError("APPROVAL_NOT_FOUND", "No approval with that id");
  if (row.kind !== "host" || row.status !== "pending" || new Date(row.expiresAt).getTime() < Date.now()) {
    throw new AllowHostError("APPROVAL_NOT_PENDING", "This approval is no longer pending");
  }
  const chain = getKeyChain(db, row.keyId);
  if (chain[0].parentId != null) {
    throw new AllowHostError("ALLOW_HOST_CHILD_KEY", "A child key's hosts are bound by its parent's list and cannot be widened here");
  }
  if (effectiveStatus(chain) !== "active") throw new AllowHostError("ALLOW_HOST_KEY_NOT_ACTIVE", "The key is revoked or expired");
  return { row, key: chain[0] };
}

/**
 * The one DNS look, made when a new host is approved (never on the payment path): the host must be a public address, or a name every
 * one of whose addresses is. A private / loopback / special-use address, an address bound to one of this machine's own network
 * interfaces (a public IP of this very host is no more reachable by an approval than 127.0.0.1 is), a failed look, an empty answer and
 * a look that takes longer than HOST_LOOKUP_TIMEOUT_MS all refuse (fail closed).
 */
async function assertHostIsPublic(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const privateHost = () =>
    new AllowHostError("ALLOW_HOST_PRIVATE_HOST", `${bare} is, or resolves to, a private, loopback or special-use address, or one of this machine's own: only an entry written when the key was issued can allow that`);
  if (isNonPublicAddress(bare)) throw privateHost();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = lookup(bare, { all: true });
    query.catch(() => {}); // when the timeout wins, a late failure must not surface as an unhandled rejection
    const addrs = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), HOST_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (addrs.length === 0) throw new Error("no address");
    const own = localInterfaceAddresses();
    if (addrs.some((a) => isNonPublicAddress(a.address) || isSelfAddress(a.address, own))) throw privateHost();
  } catch (e) {
    if (e instanceof AllowHostError) throw e;
    throw new AllowHostError("ALLOW_HOST_UNRESOLVED", `${bare} could not be resolved (lookup failed, empty, or over 3 s): nothing was added, and the request stays waiting for approval`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Approves a 'host' approval (SPEC.md §3): after one DNS look, in ONE transaction the approval becomes `approved`, the approval's
 * host:port is appended to the key's allowed_hosts (not twice if it is already there, as host:port or as the bare host), and
 * `key.allow_host` is audited. The list only ever grows, and only here. A payment approval is decided by decideApproval, unchanged
 * (the route sends only 'host' ones here).
 *
 * Refused (AllowHostError, nothing changed, the approval stays pending) unless it is a pending, unexpired 'host' approval of a usable
 * ROOT key and the host passes the look. Async only for that look, made before the transaction opens; the transaction re-checks
 * everything it decides on. `actor` is who approved, as the audit row names them: "admin", or `pin:<root key id>` for the person who
 * holds the key (SPEC.md §3); the rules above are the same for both.
 */
export async function approveHostApproval(
  sqlite: { exec(sql: string): unknown },
  db: MoneySwitchDb,
  approvalId: string,
  actor = "admin"
): Promise<{ approval: ApprovalRow; host: string }> {
  await assertHostIsPublic(normalizedHostname(new URL(approvableHost(db, approvalId).row.url)));
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const { row, key } = approvableHost(db, approvalId);
    const url = new URL(row.url);
    const host = hostPortOf(url);
    if (!isHostListed(url, key.allowedHosts)) {
      db.update(schema.moneyKeys)
        .set({ allowedHosts: [...key.allowedHosts, host] })
        .where(eq(schema.moneyKeys.id, key.id))
        .run();
    }
    const approval = decideApproval(db, approvalId, "approved");
    writeAudit(db, actor, "key.allow_host", { keyId: key.id, host, approvalId });
    sqlite.exec("COMMIT");
    return { approval, host };
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}
