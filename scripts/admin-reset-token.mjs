#!/usr/bin/env node
/**
 * Recovery tool for "I lost the admin token" when running from a source checkout (SPEC.md §2: the admin token is printed exactly
 * once and stored only as a hash, so there is no way to recover the original). It generates a brand-new admin token and replaces
 * the stored hash directly in the data directory's SQLite file, invalidating every previously-issued admin token immediately. The
 * server does NOT need to be stopped first: the DB is opened in WAL mode (see packages/db), which supports this script writing
 * alongside a running server process.
 *
 * The work is done by resetAdminTokenInFile (packages/core), the same code as `moneyswitch-server reset-admin-token`, which is the
 * command for the npm package and the Docker image (docker compose exec server node /app/dist/cli.js reset-admin-token).
 *
 * Usage:
 *   pnpm admin:reset-token -- --data-dir <dir>
 *   node scripts/admin-reset-token.mjs --data-dir <dir>
 *
 * <dir> must be a MoneySwitch data directory (the same path you'd pass as MONEYSWITCH_DATA_DIR), containing moneyswitch.sqlite.
 * This script does not accept a custom MONEYSWITCH_DB_PATH override: it always looks for `<dir>/moneyswitch.sqlite`, matching the
 * server's own default. Run it as the user that runs the server (it refuses a database that belongs to another user).
 */
import path from "node:path";
import { AdminResetError, resetAdminTokenInFile } from "@moneyswitch/core";

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

let token;
try {
  token = resetAdminTokenInFile(path.join(dataDir, "moneyswitch.sqlite"));
} catch (e) {
  console.error(e instanceof AdminResetError ? e.message : `Could not reset the admin token: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
console.log(
  "[admin:reset-token] New admin token (save this now, it will not be shown again; " +
    "the previous admin token — if any — is now invalid):"
);
console.log(`  ${token}`);
