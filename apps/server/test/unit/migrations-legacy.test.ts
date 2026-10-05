import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "..", "..", "..", "packages", "db", "migrations");
const pkgMigrationsDir = path.resolve(here, "..", "..", "..", "server-pkg", "migrations");

/** Builds a database exactly as the base commit (68a7bdf, migrations 0000..0004) leaves it. */
function buildBaseCommitDb(file: string) {
  const old = new Database(file);
  old.pragma("journal_mode = WAL");
  old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && f < "0005")
    .sort();
  expect(applied).toEqual([
    "0000_init.sql",
    "0001_v02_channels.sql",
    "0002_v04_subkeys.sql",
    "0003_v05_tollbooths.sql",
    "0004_v05_unknown_reconcile.sql",
  ]);
  for (const f of applied) {
    old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
    old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
  }
  return old;
}

function removeQuietly(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // WAL files may be briefly locked on Windows
  }
}

/**
 * Migrations 0005 / 0006 added the push-notification tables and columns. The notification feature is gone (SPEC.md §3), but the
 * database is additive-only: the migrations stay, so an older database must still upgrade in place and lose nothing.
 */
describe("migrations 0005 / 0006 (unused push-notification tables) on older databases", () => {
  it("a database created by the base commit upgrades in place: old approvals survive untouched, the new columns default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const old = buildBaseCommitDb(file);
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      old.prepare(
        `INSERT INTO money_keys (id, name, key_prefix, key_hash, enabled, total_budget, daily_budget, per_request_limit,
           approval_threshold, allowed_hosts, max_payments_per_minute, expires_at, created_at, last_used_at, allowed_models,
           parent_id, depth, can_delegate, created_by)
         VALUES ('k1', 'legacy-key', 'mk_live_old1', 'hash', 1, 10000000, 5000000, 1000000, 100000, '["api.example.com"]', 10,
           NULL, ?, NULL, NULL, NULL, 0, 0, 'admin')`
      ).run(iso(now));
      const insertApproval = old.prepare(
        `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, decided_at, created_at)
         VALUES (?, 'k1', 'https://api.example.com/old?x=1', 'GET', 'sha', 'eip155:10143', '0xusdc', '0xpay', 150000, ?, ?, ?, ?)`
      );
      insertApproval.run("ap-pending", "pending", iso(now + 5 * 60_000), null, iso(now - 60_000));
      insertApproval.run("ap-stale-pending", "pending", iso(now - 3_600_000), null, iso(now - 4_200_000));
      insertApproval.run("ap-approved", "approved", iso(now + 5 * 60_000), iso(now - 30_000), iso(now - 90_000));
      insertApproval.run("ap-used", "used", iso(now - 3_600_000), iso(now - 3_500_000), iso(now - 4_000_000));
      old.close();

      const { sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(applied).toContain("0005_approval_notify.sql");
        expect(applied).toContain("0006_approval_notify_deliveries.sql");
        expect(sqlite.prepare(`SELECT count(*) AS n FROM approval_notify_deliveries`).get()).toEqual({ n: 0 });

        const cols = sqlite.prepare(`PRAGMA table_info(approvals)`).all() as { name: string; notnull: number; dflt_value: string | null }[];
        expect(cols.find((c) => c.name === "notified_at")).toMatchObject({ notnull: 0 });
        expect(cols.find((c) => c.name === "notify_attempts")).toMatchObject({ notnull: 1, dflt_value: "0" });
        expect(cols.find((c) => c.name === "notify_attempt_at")).toMatchObject({ notnull: 0 });
        expect(sqlite.prepare(`SELECT count(*) AS n FROM notify_settings`).get()).toEqual({ n: 0 });

        const rows = sqlite
          .prepare(`SELECT id, status, amount, url, notified_at, notify_attempts, notify_attempt_at FROM approvals ORDER BY id`)
          .all();
        expect(rows).toEqual([
          { id: "ap-approved", status: "approved", amount: 150000, url: "https://api.example.com/old?x=1", notified_at: null, notify_attempts: 0, notify_attempt_at: null },
          { id: "ap-pending", status: "pending", amount: 150000, url: "https://api.example.com/old?x=1", notified_at: null, notify_attempts: 0, notify_attempt_at: null },
          { id: "ap-stale-pending", status: "pending", amount: 150000, url: "https://api.example.com/old?x=1", notified_at: null, notify_attempts: 0, notify_attempt_at: null },
          { id: "ap-used", status: "used", amount: 150000, url: "https://api.example.com/old?x=1", notified_at: null, notify_attempts: 0, notify_attempt_at: null },
        ]);
      } finally {
        sqlite.close();
      }

      // Re-opening is idempotent: the migration is not applied twice and the data is still there.
      const again = openDb({ filePath: file });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM __migrations WHERE name = '0005_approval_notify.sql'`).get()).toEqual({ n: 1 });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM approvals`).get()).toEqual({ n: 4 });
      again.sqlite.close();
    } finally {
      removeQuietly(dir);
    }
  });

  it("0006 upgrades a database that already ran 0005 in place and loses nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig6-"));
    const file = path.join(dir, "v5.sqlite");
    try {
      // a database as the first outbox version left it: migrations 0000..0005, one approval already announced, one mid-retry
      const old = new Database(file);
      old.pragma("journal_mode = WAL");
      old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      const upTo0005 = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f < "0006").sort();
      expect(upTo0005.at(-1)).toBe("0005_approval_notify.sql");
      for (const f of upTo0005) {
        old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
        old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      }
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      old.prepare(
        `INSERT INTO money_keys (id, name, key_prefix, key_hash, enabled, total_budget, daily_budget, per_request_limit,
           approval_threshold, allowed_hosts, max_payments_per_minute, expires_at, created_at, last_used_at, allowed_models,
           parent_id, depth, can_delegate, created_by)
         VALUES ('k1', 'v5-key', 'mk_live_v5aa', 'hash', 1, 10000000, 5000000, 1000000, 100000, '["api.example.com"]', 10,
           NULL, ?, NULL, NULL, NULL, 0, 0, 'admin')`
      ).run(iso(now));
      const insertApproval = old.prepare(
        `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, decided_at, created_at,
                                notified_at, notify_attempts, notify_attempt_at)
         VALUES (?, 'k1', ?, 'GET', 'sha', 'eip155:10143', '0xusdc', '0xpay', 150000, 'pending', ?, NULL, ?, ?, ?, ?)`
      );
      insertApproval.run("ap-announced", "https://api.example.com/a", iso(now + 5 * 60_000), iso(now - 90_000), iso(now - 80_000), 1, iso(now - 80_000));
      insertApproval.run("ap-unannounced", "https://api.example.com/b", iso(now + 5 * 60_000), iso(now - 60_000), null, 2, iso(now - 50_000));
      old.close();

      const { sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        // 0005 stays recorded, 0006 is applied right after it (later migrations may follow)
        expect(applied.slice(5, 7)).toEqual(["0005_approval_notify.sql", "0006_approval_notify_deliveries.sql"]);
        const cols = (sqlite.prepare(`PRAGMA table_info(approval_notify_deliveries)`).all() as { name: string }[]).map((c) => c.name);
        expect(cols).toEqual(["approval_id", "channel", "kind", "attempts", "attempt_at", "delivered_at", "skipped", "created_at"]);
        // nothing was lost or rewritten
        expect(sqlite.prepare(`SELECT id, notified_at IS NOT NULL AS announced, notify_attempts FROM approvals ORDER BY id`).all()).toEqual([
          { id: "ap-announced", announced: 1, notify_attempts: 1 },
          { id: "ap-unannounced", announced: 0, notify_attempts: 2 },
        ]);
      } finally {
        sqlite.close();
      }
    } finally {
      removeQuietly(dir);
    }
  });

  it("the migrations bundled into the moneyswitch-server npm package are byte-identical to packages/db/migrations", () => {
    const names = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(fs.readdirSync(pkgMigrationsDir).filter((f) => f.endsWith(".sql")).sort()).toEqual(names);
    for (const name of names) {
      expect(fs.readFileSync(path.join(pkgMigrationsDir, name), "utf8"), name).toBe(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    }
  });
});

/** Migration 0008 added approvals.kind ('payment' | 'host'); the database is additive-only, so an older database must upgrade in place. */
describe("migration 0008 (approvals.kind) on an older database", () => {
  it("every approval that existed before is a 'payment' approval afterwards; nothing else about it changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig8-"));
    const file = path.join(dir, "v7.sqlite");
    try {
      // a database as the release before host approvals left it: migrations 0000..0007
      const old = new Database(file);
      old.pragma("journal_mode = WAL");
      old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      const upTo0007 = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f < "0008").sort();
      expect(upTo0007.at(-1)).toBe("0007_wallet_lifecycle.sql");
      for (const f of upTo0007) {
        old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
        old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      }
      expect((old.prepare(`PRAGMA table_info(approvals)`).all() as { name: string }[]).map((c) => c.name)).not.toContain("kind");
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      old.prepare(
        `INSERT INTO money_keys (id, name, key_prefix, key_hash, enabled, total_budget, daily_budget, per_request_limit,
           approval_threshold, allowed_hosts, max_payments_per_minute, expires_at, created_at, last_used_at, allowed_models,
           parent_id, depth, can_delegate, created_by)
         VALUES ('k1', 'v7-key', 'mk_live_v7aa', 'hash', 1, 10000000, 5000000, 1000000, 100000, '["api.example.com"]', 10,
           NULL, ?, NULL, NULL, NULL, 0, 0, 'admin')`
      ).run(iso(now));
      const insertApproval = old.prepare(
        `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, decided_at, created_at)
         VALUES (?, 'k1', 'https://api.example.com/old', 'GET', 'sha', 'eip155:10143', '0xusdc', '0xpay', 150000, ?, ?, NULL, ?)`
      );
      for (const [id, status] of [["ap-pending", "pending"], ["ap-approved", "approved"], ["ap-used", "used"], ["ap-denied", "denied"]]) {
        insertApproval.run(id, status, iso(now + 5 * 60_000), iso(now - 60_000));
      }
      old.close();

      const { sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(applied).toContain("0008_approval_kind.sql"); // (later migrations may follow)
        expect(sqlite.prepare(`PRAGMA table_info(approvals)`).all().find((c: any) => c.name === "kind")).toMatchObject({ notnull: 1, dflt_value: "'payment'" });
        expect(sqlite.prepare(`SELECT id, status, kind, amount, pay_to FROM approvals ORDER BY id`).all()).toEqual([
          { id: "ap-approved", status: "approved", kind: "payment", amount: 150000, pay_to: "0xpay" },
          { id: "ap-denied", status: "denied", kind: "payment", amount: 150000, pay_to: "0xpay" },
          { id: "ap-pending", status: "pending", kind: "payment", amount: 150000, pay_to: "0xpay" },
          { id: "ap-used", status: "used", kind: "payment", amount: 150000, pay_to: "0xpay" },
        ]);
        // a row written without naming the column is a payment approval too; a host approval is written with its kind
        sqlite
          .prepare(
            `INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, decided_at, created_at)
             VALUES ('ap-new', 'k1', 'https://api.example.com/new', 'GET', 'sha', 'n', 'a', 'p', 1, 'pending', ?, NULL, ?)`
          )
          .run(iso(now + 60_000), iso(now));
        expect(sqlite.prepare(`SELECT kind FROM approvals WHERE id = 'ap-new'`).get()).toEqual({ kind: "payment" });
      } finally {
        sqlite.close();
      }

      // re-opening does not apply it twice and loses nothing
      const again = openDb({ filePath: file });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM __migrations WHERE name = '0008_approval_kind.sql'`).get()).toEqual({ n: 1 });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM approvals WHERE kind = 'payment'`).get()).toEqual({ n: 5 });
      again.sqlite.close();
    } finally {
      removeQuietly(dir);
    }
  });
});
