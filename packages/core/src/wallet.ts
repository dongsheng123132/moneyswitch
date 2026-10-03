import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type MoneySwitchDb } from "@moneyswitch/db";

/**
 * Database side of the wallet lifecycle (the key files themselves are managed
 * by @moneyswitch/wallet). Nothing here ever sees a key, a password or a
 * recovery phrase: only addresses, timestamps and file names.
 */

export type WalletOrigin = "generated" | "imported";

export interface WalletMetaRow {
  /** Lower-case 0x address. */
  id: string;
  address: string;
  createdAt: string;
  /** NULL until the operator answered the two-word recovery-phrase check (or imported the wallet). */
  backupConfirmedAt: string | null;
  origin: WalletOrigin | null;
}

function rowToMeta(row: typeof schema.walletMeta.$inferSelect): WalletMetaRow {
  return {
    id: row.id,
    address: row.address ?? row.id,
    createdAt: row.createdAt,
    backupConfirmedAt: row.backupConfirmedAt,
    origin: row.origin === "generated" || row.origin === "imported" ? row.origin : null,
  };
}

export function walletMetaId(address: string): string {
  return address.toLowerCase();
}

export function getWalletMeta(db: MoneySwitchDb, address: string): WalletMetaRow | undefined {
  const row = db.select().from(schema.walletMeta).where(eq(schema.walletMeta.id, walletMetaId(address))).get();
  return row ? rowToMeta(row) : undefined;
}

/**
 * Remembers a wallet the server just created or imported. An imported wallet
 * counts as backed up from the start (`backupConfirmed`): the operator brought
 * the credential, so there is nothing for them to write down. A row that
 * already exists keeps its earlier confirmation.
 */
export function recordWalletOrigin(
  db: MoneySwitchDb,
  address: string,
  origin: WalletOrigin,
  opts: { backupConfirmed?: boolean; now?: string } = {}
): WalletMetaRow {
  const now = opts.now ?? new Date().toISOString();
  const confirmedAt = opts.backupConfirmed ? now : null;
  db.insert(schema.walletMeta)
    .values({ id: walletMetaId(address), address, createdAt: now, origin, backupConfirmedAt: confirmedAt })
    .onConflictDoUpdate({
      target: schema.walletMeta.id,
      set: { address, origin, ...(confirmedAt ? { backupConfirmedAt: confirmedAt } : {}) },
    })
    .run();
  return getWalletMeta(db, address)!;
}

/**
 * Marks the recovery phrase of `address` as confirmed and returns the stored
 * timestamp (an earlier confirmation is kept). Creates the row for a wallet
 * that predates this table.
 */
export function confirmWalletBackup(db: MoneySwitchDb, address: string, now = new Date().toISOString()): string {
  const existing = getWalletMeta(db, address);
  if (existing?.backupConfirmedAt) return existing.backupConfirmedAt;
  db.insert(schema.walletMeta)
    .values({ id: walletMetaId(address), address, createdAt: now, backupConfirmedAt: now, origin: existing?.origin ?? null })
    .onConflictDoUpdate({ target: schema.walletMeta.id, set: { backupConfirmedAt: now } })
    .run();
  return now;
}

export interface RetiredWalletRow {
  id: string;
  address: string;
  retiredAt: string;
  reason: string;
  /** File name inside <dataDir>/retired/. */
  keystoreFile: string;
  /** File name inside <dataDir>/retired/, or null when the wallet had no auto-unlock secret. */
  secretFile: string | null;
  replacedBy: string | null;
}

function rowToRetired(row: typeof schema.walletRetirements.$inferSelect): RetiredWalletRow {
  return {
    id: row.id,
    address: row.address,
    retiredAt: row.retiredAt,
    reason: row.reason,
    keystoreFile: row.keystoreFile,
    secretFile: row.secretFile,
    replacedBy: row.replacedBy,
  };
}

export interface RecordRetirementInput {
  address: string;
  retiredAt: string;
  reason: string;
  keystoreFile: string;
  secretFile: string | null;
  replacedBy: string | null;
}

export function recordWalletRetirement(db: MoneySwitchDb, input: RecordRetirementInput): RetiredWalletRow {
  const id = randomUUID();
  db.insert(schema.walletRetirements)
    .values({
      id,
      address: input.address,
      retiredAt: input.retiredAt,
      reason: input.reason,
      keystoreFile: input.keystoreFile,
      secretFile: input.secretFile,
      replacedBy: input.replacedBy,
    })
    .run();
  const row = db.select().from(schema.walletRetirements).where(eq(schema.walletRetirements.id, id)).get();
  if (!row) throw new Error("failed to read back wallet retirement");
  return rowToRetired(row);
}

/** Retired wallets, newest first. */
export function listRetiredWallets(db: MoneySwitchDb): RetiredWalletRow[] {
  return db
    .select()
    .from(schema.walletRetirements)
    .orderBy(desc(schema.walletRetirements.retiredAt), sql`rowid desc`)
    .all()
    .map(rowToRetired);
}
