import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import { getMoneyKeyById, authenticateMoneyKey } from "../src/keys.js";
import { sha256Hex, keyPrefix12, generateMoneyKey } from "../src/moneykey.js";
import { evaluateAndReserve } from "../src/policy.js";
import { usedToday } from "../src/ledger.js";
import { createChildKey, DelegationError } from "../src/delegation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "..", "db", "migrations");

/**
 * v0.4 migration must upgrade an existing (v0.2/v0.3) database in place:
 * existing keys become roots with depth=0, can_delegate=false, and keep
 * working exactly as before.
 */
describe("v0.4 migration 0002_v04_subkeys on a pre-existing database", () => {
  it("upgrades a v0.3-era database: existing key -> root, depth 0, can_delegate false; spend/auth unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig-"));
    const file = path.join(dir, "old.sqlite");
    const plaintext = generateMoneyKey();
    try {
      // Build a database exactly as the pre-v0.4 runner left it.
      const old = new Database(file);
      old.pragma("journal_mode = WAL");
      old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      for (const f of ["0000_init.sql", "0001_v02_channels.sql"]) {
        old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
        old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      }
      const now = new Date().toISOString();
      old.prepare(
        `INSERT INTO money_keys (id, name, key_prefix, key_hash, enabled, total_budget, daily_budget, per_request_limit,
           approval_threshold, allowed_hosts, max_payments_per_minute, expires_at, created_at, last_used_at, allowed_models)
         VALUES ('old-key', 'legacy', ?, ?, 1, 10000000, 1000000, 500000, NULL, '["example.com:443"]', 10, NULL, ?, NULL, NULL)`
      ).run(keyPrefix12(plaintext), sha256Hex(plaintext), now);
      old.prepare(
        `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, tx_hash, error_code,
           approval_id, created_at, updated_at, kind)
         VALUES ('p1', 'old-key', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000,
           'settled', '0xmock', NULL, NULL, ?, ?, 'fetch')`
      ).run(now, now);
      old.close();

      const { db, sqlite } = openDb({ filePath: file });
      try {
        const applied = sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[];
        expect(applied.map((r) => r.name)).toContain("0002_v04_subkeys.sql");

        const k = getMoneyKeyById(db, "old-key")!;
        expect(k.parentId).toBeNull();
        expect(k.depth).toBe(0);
        expect(k.canDelegate).toBe(false);
        expect(k.createdBy).toBe("admin");
        expect(authenticateMoneyKey(db, plaintext).id).toBe("old-key");
        expect(usedToday(db, "old-key")).toBe(10000n);
        expect(evaluateAndReserve(db, k, {
          url: "https://example.com/x", host: "example.com:443", method: "GET", body: undefined,
          network: "eip155:10143", asset: "0xa", payTo: "0xb", amount: 10000n,
        }).paymentId).toBeTruthy();
        // A migrated key cannot delegate until an admin creates a delegable key.
        expect(() =>
          createChildKey(db, "old-key", { name: "c", dailyBudget: 1n, totalBudget: 1n, perRequestLimit: 1n }, { maxDepth: 3 })
        ).toThrow(DelegationError);
      } finally {
        sqlite.close();
      }

      // Re-opening is idempotent (migration not re-applied).
      const again = openDb({ filePath: file });
      expect(getMoneyKeyById(again.db, "old-key")!.depth).toBe(0);
      again.sqlite.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks: harmless */
      }
    }
  });
});
