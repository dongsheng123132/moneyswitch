#!/usr/bin/env node
/**
 * Recovery tool for "I lost the admin token" (SPEC.md §2.2: the admin token
 * is printed exactly once and stored only as a hash — there is no way to
 * recover the original). This generates a brand-new admin token and
 * replaces the stored hash directly in the data directory's SQLite file,
 * invalidating every previously-issued admin token immediately. The server
 * does NOT need to be stopped first: the DB is opened in WAL mode (see
 * packages/db), which supports this script writing alongside a running
 * server process.
 *
 * Usage:
 *   pnpm admin:reset-token -- --data-dir <dir>
 *   node scripts/admin-reset-token.mjs --data-dir <dir>
 *
 * <dir> must be a MoneySwitch data directory (the same path you'd pass as
 * MONEYSWITCH_DATA_DIR), containing moneyswitch.sqlite. This script does
 * not accept a custom MONEYSWITCH_DB_PATH override — it always looks for
 * `<dir>/moneyswitch.sqlite`, matching the server's own default.
 */
import path from "node:path";
import fs from "node:fs";
import { openDb } from "@moneyswitch/db";
import { resetAdminToken } from "@moneyswitch/core";

function parseArgs(argv) {
  const idx = argv.indexOf("--data-dir");
  if (idx === -1 || idx === argv.length - 1) {
    return null;
  }
  return argv[idx + 1];
}

const dataDir = parseArgs(process.argv.slice(2));
if (!dataDir) {
  console.error("Usage: pnpm admin:reset-token -- --data-dir <dir>");
  process.exit(1);
}

const dbFilePath = path.join(dataDir, "moneyswitch.sqlite");
if (!fs.existsSync(dbFilePath)) {
  console.error(`No MoneySwitch database found at ${dbFilePath}. Is --data-dir correct?`);
  process.exit(1);
}

const { db, sqlite } = openDb({ filePath: dbFilePath });
try {
  const token = resetAdminToken(db);
  console.log(
    "[admin:reset-token] New admin token (save this now, it will not be shown again; " +
      "the previous admin token — if any — is now invalid):"
  );
  console.log(`  ${token}`);
} finally {
  sqlite.close();
}
