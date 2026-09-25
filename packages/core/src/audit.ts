import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";

/** Field names that must never appear in audit/log output. */
const SENSITIVE_KEYS = new Set([
  "password",
  "privateKey",
  "private_key",
  "mnemonic",
  "keystorePassword",
  "keystore_password",
  "fullKey",
  "moneyKey",
  "money_key",
  "adminToken",
  "admin_token",
  "signature",
  "authorization",
]);

/** Recursively strips sensitive fields and truncates secret-shaped strings before logging/auditing. */
export function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^mk_live_[A-Za-z0-9]{10,}/.test(value) || /^ms_admin_[A-Za-z0-9]{10,}/.test(value)) {
      return value.slice(0, 12) + "...REDACTED";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export function writeAudit(
  db: MoneySwitchDb,
  actor: string,
  action: string,
  detail: Record<string, unknown>
): void {
  db.insert(schema.auditLog)
    .values({
      id: randomUUID(),
      actor,
      action,
      detail: redact(detail) as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function listAudit(db: MoneySwitchDb, limit = 100) {
  return db
    .select()
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(limit)
    .all();
}
