import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export * as schema from "./schema.js";

export type MoneySwitchDb = BetterSQLite3Database<typeof schema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs raw SQL migrations found in packages/db/migrations, in filename order,
 * tracked in a `__migrations` table so re-runs are idempotent.
 */
function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
  );
  const migrationsDir = path.resolve(__dirname, "..", "migrations");
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = new Set(
    sqlite.prepare(`SELECT name FROM __migrations`).all().map((r: any) => r.name)
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    // One transaction per migration file (SQLite DDL is transactional): a
    // migration that fails half-way leaves the database exactly as it was
    // and unrecorded, so fixing it and restarting re-applies it cleanly
    // instead of tripping over e.g. an already-added column.
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`)
        .run(file, new Date().toISOString());
    })();
  }
}

export interface OpenDbOptions {
  /** Path to the sqlite file, or ":memory:" for tests. */
  filePath: string;
}

export function openDb(opts: OpenDbOptions): { db: MoneySwitchDb; sqlite: Database.Database } {
  if (opts.filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
  }
  const sqlite = new Database(opts.filePath);
  if (opts.filePath !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
