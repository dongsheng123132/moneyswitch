import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { openDb, schema, type MoneySwitchDb } from "@moneyswitch/db";
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
 * before (deletes all existing admin_auth rows, inserts one fresh row, in one
 * transaction: if anything fails the old token is still the valid one) —
 * every previously-issued admin token is invalidated immediately. This is
 * the "I lost the admin token" recovery path (see resetAdminTokenInFile),
 * so an operator never has to delete the whole database. Safe to run
 * against a data directory whose server process is currently running: the
 * underlying SQLite file is opened in WAL mode, which supports a writer
 * (this reset) alongside the server's own reads/writes.
 */
export function resetAdminToken(db: MoneySwitchDb): string {
  const token = generateAdminToken();
  db.transaction(
    (tx) => {
      tx.delete(schema.adminAuth).run();
      tx.insert(schema.adminAuth)
        .values({ id: randomUUID(), tokenHash: sha256Hex(token), createdAt: new Date().toISOString() })
        .run();
    },
    // takes the write lock up front: a server writing at the same moment makes this wait (busy timeout), never fail half-way
    { behavior: "immediate" }
  );
  return token;
}

// ---------------------------------------------------------------------------
// the recovery command: `moneyswitch-server reset-admin-token` and scripts/admin-reset-token.mjs
// ---------------------------------------------------------------------------

export type AdminResetFailure = "NO_DATABASE" | "NOT_OWNER" | "DATABASE_ERROR";

/**
 * Why resetAdminTokenInFile refused or failed. The message is written for the operator and is shown as it is; it never contains a
 * secret, and every failure means nothing was changed.
 */
export class AdminResetError extends Error {
  constructor(
    readonly code: AdminResetFailure,
    message: string
  ) {
    super(message);
    this.name = "AdminResetError";
  }
}

/**
 * The reset has to be run by the operating-system user that runs the service: another user's SQLite -wal / -shm files can lock the
 * service out of its own database. POSIX only; Windows has no uid, so `processUid` is then null and nothing is refused here.
 */
export function ownerMismatch(fileUid: number, processUid: number | null | undefined): boolean {
  return typeof processUid === "number" && fileUid !== processUid;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Replaces the administrator token in the SQLite file `dbFilePath` and returns the new token (the caller prints it once and nowhere
 * else). The old token stops working at once; the server may keep running (no restart needed). Refuses, changing nothing, when
 * there is no database at that path (it never creates one), when the file belongs to another OS user (POSIX), or when it cannot be
 * read or updated. It does not run migrations: it works on the database exactly as it is.
 */
export function resetAdminTokenInFile(dbFilePath: string): string {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(dbFilePath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw new AdminResetError(
      "NO_DATABASE",
      `No MoneySwitch database found at ${dbFilePath}. Run this command on the server itself, as the user that runs the service, ` +
        "with the data directory that service uses (--data-dir <dir> or MONEYSWITCH_DATA_DIR). Nothing was changed."
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (ownerMismatch(stat.uid, uid)) {
    throw new AdminResetError(
      "NOT_OWNER",
      `The database at ${dbFilePath} belongs to another operating-system user (uid ${stat.uid}; this command runs as uid ${uid}). ` +
        "Run it as the user that runs the service. Nothing was changed."
    );
  }
  let opened: ReturnType<typeof openDb>;
  try {
    opened = openDb({ filePath: dbFilePath, migrate: false });
  } catch (e) {
    throw new AdminResetError("DATABASE_ERROR", `Could not open the database at ${dbFilePath}: ${errorText(e)}. Nothing was changed.`);
  }
  try {
    return resetAdminToken(opened.db);
  } catch (e) {
    throw new AdminResetError(
      "DATABASE_ERROR",
      `Could not replace the administrator token in ${dbFilePath}: ${errorText(e)}. Nothing was changed.`
    );
  } finally {
    opened.sqlite.close();
  }
}
