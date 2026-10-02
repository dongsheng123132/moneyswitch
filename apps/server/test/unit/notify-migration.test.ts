import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import type { AppContext } from "../../src/context.js";
import { createApprovalOutbox } from "../../src/notify/outbox.js";

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

describe("migration 0005_approval_notify on a database created by the base commit", () => {
  it("upgrades in place: old approvals survive untouched, new columns default, a still-pending one gets notified once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-notify-mig-"));
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

      const { db, sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(applied).toContain("0005_approval_notify.sql");

        const cols = (sqlite.prepare(`PRAGMA table_info(approvals)`).all() as { name: string; notnull: number; dflt_value: string | null }[]);
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

        // The upgraded database works with the outbox: only the genuinely pending, unexpired approval is announced.
        const sent: string[] = [];
        const ctx: AppContext = {
          db,
          sqlite,
          wallet: {} as never,
          config: { port: 0, host: "127.0.0.1", dataDir: ".", dbFilePath: file, walletPassword: null },
          notify: {
            env: { MONEYSWITCH_NOTIFY_WEBHOOK_URL: "http://hook.test/x" },
            log: { info: () => undefined, warn: () => undefined },
            fetch: (async (_u: string, init: RequestInit) => {
              sent.push(JSON.parse(String(init.body)).approval.id);
              return new Response("", { status: 200 });
            }) as unknown as typeof fetch,
          },
        };
        const outbox = createApprovalOutbox(ctx);
        await outbox.tick();
        await outbox.tick();
        expect(sent).toEqual(["ap-pending"]);
        expect(sqlite.prepare(`SELECT notified_at FROM approvals WHERE id = 'ap-pending'`).get()).toEqual({
          notified_at: expect.any(String),
        });
      } finally {
        sqlite.close();
      }

      // Re-opening is idempotent: the migration is not applied twice and the data is still there.
      const again = openDb({ filePath: file });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM __migrations WHERE name = '0005_approval_notify.sql'`).get()).toEqual({ n: 1 });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM approvals`).get()).toEqual({ n: 4 });
      again.sqlite.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // WAL files may be briefly locked on Windows
      }
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
