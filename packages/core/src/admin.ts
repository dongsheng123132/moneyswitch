import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";
import { generateAdminToken, sha256Hex, verifySecretAgainstHash } from "./moneykey.js";

/**
 * Bootstraps the admin token on first run: if no admin_auth row exists yet,
 * generates a fresh `ms_admin_xxx` token, stores only its hash, and returns
 * the plaintext (caller must print it once to stdout and never log it again).
 * If a row already exists, returns null (no new token generated).
 */
export function bootstrapAdminToken(db: MoneySwitchDb): string | null {
  const existing = db.select().from(schema.adminAuth).all();
  if (existing.length > 0) return null;
  const token = generateAdminToken();
  db.insert(schema.adminAuth)
    .values({ id: randomUUID(), tokenHash: sha256Hex(token), createdAt: new Date().toISOString() })
    .run();
  return token;
}

export function verifyAdminToken(db: MoneySwitchDb, candidate: string): boolean {
  const rows = db.select().from(schema.adminAuth).all();
  return rows.some((r) => verifySecretAgainstHash(candidate, r.tokenHash));
}

/**
 * Generates a brand-new admin token and replaces whatever was stored
 * before (deletes all existing admin_auth rows, inserts one fresh row) —
 * every previously-issued admin token is invalidated immediately. Used by
 * `scripts/admin-reset-token.mjs` for the "I lost the admin token" recovery
 * path, so an operator never has to delete the whole database. Safe to run
 * against a data directory whose server process is currently running: the
 * underlying SQLite file is opened in WAL mode, which supports a writer
 * (this reset) alongside the server's own reads/writes.
 */
export function resetAdminToken(db: MoneySwitchDb): string {
  const token = generateAdminToken();
  db.delete(schema.adminAuth).run();
  db.insert(schema.adminAuth)
    .values({ id: randomUUID(), tokenHash: sha256Hex(token), createdAt: new Date().toISOString() })
    .run();
  return token;
}
