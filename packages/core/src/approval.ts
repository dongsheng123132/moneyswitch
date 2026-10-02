import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { dbNumberToMicros, microsToDbNumber } from "./money.js";
import { encodeRequestBody } from "./request-body.js";
import type { ApprovalRow } from "./types.js";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

function rowToApproval(row: typeof schema.approvals.$inferSelect): ApprovalRow {
  return {
    id: row.id,
    keyId: row.keyId,
    url: row.url,
    method: row.method,
    bodySha256: row.bodySha256,
    network: row.network,
    asset: row.asset,
    payTo: row.payTo,
    amount: dbNumberToMicros(row.amount),
    status: row.status,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

/**
 * sha256 over the exact bytes sent to the seller (encodeRequestBody): a string
 * body hashes verbatim, any other body hashes as its JSON. The approval binding
 * and the wire encoding share one function so they cannot drift apart.
 */
export function sha256OfBody(body: unknown): string {
  const wire = encodeRequestBody(body) ?? "";
  return createHash("sha256").update(wire, "utf8").digest("hex");
}

export interface CreateApprovalInput {
  keyId: string;
  url: string;
  method: string;
  body: unknown;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
}

export function createApproval(db: MoneySwitchDb, input: CreateApprovalInput): ApprovalRow {
  const id = randomUUID();
  const now = new Date();
  const row = {
    id,
    keyId: input.keyId,
    url: input.url,
    method: input.method,
    bodySha256: sha256OfBody(input.body),
    network: input.network,
    asset: input.asset,
    payTo: input.payTo,
    amount: microsToDbNumber(input.amount),
    status: "pending" as const,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    decidedAt: null,
    createdAt: now.toISOString(),
  };
  db.insert(schema.approvals).values(row).run();
  return rowToApproval(row as typeof schema.approvals.$inferSelect);
}

export function getApproval(db: MoneySwitchDb, id: string): ApprovalRow | undefined {
  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  return row ? rowToApproval(row) : undefined;
}

export function listApprovals(db: MoneySwitchDb, status?: string): ApprovalRow[] {
  const q = db.select().from(schema.approvals);
  const rows = status
    ? q.where(eq(schema.approvals.status, status as any)).all()
    : q.all();
  return rows.map(rowToApproval);
}

/** Marks pending, already-expired approvals as `expired`. Call before reading pending lists / validating. */
export function expireStaleApprovals(db: MoneySwitchDb): void {
  const nowIso = new Date().toISOString();
  const pending = db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.status, "pending"))
    .all();
  for (const p of pending) {
    if (p.expiresAt < nowIso) {
      db.update(schema.approvals)
        .set({ status: "expired", decidedAt: nowIso })
        .where(eq(schema.approvals.id, p.id))
        .run();
    }
  }
}

export function decideApproval(
  db: MoneySwitchDb,
  id: string,
  decision: "approved" | "denied"
): ApprovalRow {
  const nowIso = new Date().toISOString();
  const updated = db
    .update(schema.approvals)
    .set({ status: decision, decidedAt: nowIso })
    .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending")))
    .run();
  if (updated.changes === 0) {
    throw new Error("APPROVAL_NOT_PENDING");
  }
  const row = getApproval(db, id);
  if (!row) throw new Error("APPROVAL_NOT_FOUND");
  return row;
}

/**
 * Validates that an approval_id supplied on a /v1/fetch retry matches the
 * current request (same key, url, method, body hash, payTo) and is
 * `approved` and unexpired. Does NOT mark it used — call markApprovalUsed
 * after the policy engine accepts the payment, inside the same transaction.
 */
export function validateApprovalForUse(
  db: MoneySwitchDb,
  approvalId: string,
  ctx: { keyId: string; url: string; method: string; body: unknown; payTo: string; amount: bigint }
): ApprovalRow {
  const approval = getApproval(db, approvalId);
  if (!approval) throw new Error("APPROVAL_INVALID");
  if (approval.status !== "approved") throw new Error("APPROVAL_INVALID");
  if (new Date(approval.expiresAt).getTime() < Date.now()) throw new Error("APPROVAL_INVALID");
  if (approval.keyId !== ctx.keyId) throw new Error("APPROVAL_INVALID");
  if (approval.url !== ctx.url) throw new Error("APPROVAL_INVALID");
  if (approval.method !== ctx.method) throw new Error("APPROVAL_INVALID");
  if (approval.bodySha256 !== sha256OfBody(ctx.body)) throw new Error("APPROVAL_INVALID");
  if (approval.payTo.toLowerCase() !== ctx.payTo.toLowerCase()) throw new Error("APPROVAL_INVALID");
  if (ctx.amount > approval.amount) throw new Error("APPROVAL_INVALID");
  return approval;
}

export function markApprovalUsed(db: MoneySwitchDb, approvalId: string): void {
  const nowIso = new Date().toISOString();
  const updated = db
    .update(schema.approvals)
    .set({ status: "used", decidedAt: nowIso })
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "approved")))
    .run();
  if (updated.changes === 0) {
    throw new Error("APPROVAL_INVALID");
  }
}
