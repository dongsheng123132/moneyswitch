import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import {
  confirmWalletBackup,
  getWalletMeta,
  listRetiredWallets,
  recordWalletOrigin,
  recordWalletRetirement,
} from "../src/wallet.js";
import { freshDb } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "..", "db", "migrations");
const ADDRESS = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function insertPayment(sqlite: Database.Database, id: string, status: string) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at, kind)
       VALUES (?, 'k', 'https://example.com/x', 'example.com:443', 'GET', 'eip155:10143', '0xa', '0xb', 10000, ?, ?, ?, 'fetch')`
    )
    .run(id, status, now, now);
}

describe("wallet_meta: backup confirmation", () => {
  it("has no row until something is recorded, and keys rows by the lower-case address", () => {
    const { db } = freshDb();
    expect(getWalletMeta(db, ADDRESS)).toBeUndefined();
    const row = recordWalletOrigin(db, ADDRESS, "generated");
    expect(row.id).toBe(ADDRESS.toLowerCase());
    expect(row.address).toBe(ADDRESS);
    expect(row.origin).toBe("generated");
    expect(row.backupConfirmedAt).toBeNull();
    // looked up by any casing
    expect(getWalletMeta(db, ADDRESS.toLowerCase())?.address).toBe(ADDRESS);
  });

  it("confirmation is stored once and an earlier timestamp is kept", () => {
    const { db } = freshDb();
    recordWalletOrigin(db, ADDRESS, "generated");
    const first = confirmWalletBackup(db, ADDRESS, "2026-10-03T00:00:00.000Z");
    expect(first).toBe("2026-10-03T00:00:00.000Z");
    expect(confirmWalletBackup(db, ADDRESS, "2026-10-04T00:00:00.000Z")).toBe(first);
    expect(getWalletMeta(db, ADDRESS)?.backupConfirmedAt).toBe(first);
  });

  it("a wallet that predates the table can still be confirmed (row is created)", () => {
    const { db } = freshDb();
    expect(getWalletMeta(db, ADDRESS)).toBeUndefined();
    const at = confirmWalletBackup(db, ADDRESS, "2026-10-03T00:00:00.000Z");
    expect(getWalletMeta(db, ADDRESS)).toMatchObject({ backupConfirmedAt: at, origin: null });
  });

  it("an imported wallet counts as backed up; re-recording never un-confirms", () => {
    const { db } = freshDb();
    const imported = recordWalletOrigin(db, ADDRESS, "imported", { backupConfirmed: true, now: "2026-10-03T01:00:00.000Z" });
    expect(imported.backupConfirmedAt).toBe("2026-10-03T01:00:00.000Z");
    const again = recordWalletOrigin(db, ADDRESS, "generated");
    expect(again.backupConfirmedAt).toBe("2026-10-03T01:00:00.000Z");
  });
});

describe("wallet_retirements", () => {
  it("records file names (never paths) and lists newest first", () => {
    const { db } = freshDb();
    const a = recordWalletRetirement(db, {
      address: ADDRESS,
      retiredAt: "2026-10-03T01:00:00.000Z",
      reason: "lost_password",
      keystoreFile: "wallet-0xf39f-20261003T010000000Z.json",
      secretFile: null,
      replacedBy: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    const b = recordWalletRetirement(db, {
      address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      retiredAt: "2026-10-03T02:00:00.000Z",
      reason: "suspected_leak",
      keystoreFile: "wallet-0x7099-20261003T020000000Z.json",
      secretFile: "wallet-unlock-0x7099-20261003T020000000Z.secret",
      replacedBy: null,
    });
    const list = listRetiredWallets(db);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ secretFile: "wallet-unlock-0x7099-20261003T020000000Z.secret", replacedBy: null });
    expect(list[1]).toMatchObject({ reason: "lost_password", secretFile: null });
  });
});

describe("migration 0007_wallet_lifecycle on a database created by the previous release", () => {
  it("upgrades 0000..0006 in place: existing rows and payments survive, new columns/table appear, re-open is idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-mig7-"));
    const file = path.join(dir, "v6.sqlite");
    try {
      const old = new Database(file);
      old.pragma("journal_mode = WAL");
      old.exec(`CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
      const upTo0006 = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f < "0007").sort();
      expect(upTo0006.at(-1)).toBe("0006_approval_notify_deliveries.sql");
      for (const f of upTo0006) {
        old.exec(fs.readFileSync(path.join(migrationsDir, f), "utf-8"));
        old.prepare(`INSERT INTO __migrations (name, applied_at) VALUES (?, ?)`).run(f, new Date().toISOString());
      }
      // a wallet_meta row as an older build could have written it, and a payment that signed with the old wallet
      old.prepare(`INSERT INTO wallet_meta (id, address, created_at) VALUES (?, ?, ?)`).run(ADDRESS.toLowerCase(), ADDRESS, "2026-09-01T00:00:00.000Z");
      insertPayment(old, "p-old", "unknown");
      old.prepare(`UPDATE payments SET auth_from = ? WHERE id = 'p-old'`).run(ADDRESS);
      old.close();

      const { db, sqlite } = openDb({ filePath: file });
      try {
        const applied = (sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(applied[7]).toBe("0007_wallet_lifecycle.sql"); // right after 0006 (later migrations may follow)
        const metaCols = (sqlite.prepare(`PRAGMA table_info(wallet_meta)`).all() as { name: string }[]).map((c) => c.name);
        expect(metaCols).toEqual(["id", "address", "created_at", "backup_confirmed_at", "origin"]);
        const retCols = (sqlite.prepare(`PRAGMA table_info(wallet_retirements)`).all() as { name: string }[]).map((c) => c.name);
        expect(retCols).toEqual(["id", "address", "retired_at", "reason", "keystore_file", "secret_file", "replaced_by", "solana_address"]);
        // nothing was lost
        expect(getWalletMeta(db, ADDRESS)).toMatchObject({ address: ADDRESS, backupConfirmedAt: null, origin: null });
        expect(sqlite.prepare(`SELECT auth_from FROM payments WHERE id = 'p-old'`).get()).toEqual({ auth_from: ADDRESS });
        // and the new helpers work against the upgraded file
        expect(confirmWalletBackup(db, ADDRESS, "2026-10-03T00:00:00.000Z")).toBe("2026-10-03T00:00:00.000Z");
        expect(listRetiredWallets(db)).toEqual([]);
      } finally {
        sqlite.close();
      }
      const again = openDb({ filePath: file });
      expect(again.sqlite.prepare(`SELECT count(*) AS n FROM __migrations WHERE name = '0007_wallet_lifecycle.sql'`).get()).toEqual({ n: 1 });
      again.sqlite.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks: harmless */
      }
    }
  });

  it("rolling back to the previous image is safe: a database already at 0007 opens and works with the previous release's migration list and statements", () => {
    // deploy/upgrade-us.sh restores the previous image when the upgrade fails after the database was migrated. That image
    // knows only 0000..0006: it must neither try to re-apply anything nor trip over the additive columns and table.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-rollback7-"));
    const file = path.join(dir, "moneyswitch.sqlite");
    const previous = path.join(dir, "previous-image-migrations");
    try {
      fs.mkdirSync(previous);
      const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
      for (const f of sqlFiles.filter((n) => n < "0007")) fs.copyFileSync(path.join(migrationsDir, f), path.join(previous, f));
      expect(fs.readdirSync(previous)).toHaveLength(7);

      // the NEW release migrates the database and the wallet layer writes its rows
      const current = openDb({ filePath: file });
      recordWalletOrigin(current.db, ADDRESS, "generated");
      recordWalletRetirement(current.db, { address: ADDRESS, retiredAt: "2026-10-03T00:00:00.000Z", reason: "lost_password", keystoreFile: "wallet-a.json", secretFile: null, replacedBy: null });
      insertPayment(current.sqlite, "p-new", "settled");
      current.sqlite.close();

      // the PREVIOUS release opens the same file with its own list
      const rolledBack = openDb({ filePath: file, migrationsDir: previous });
      try {
        const names = (rolledBack.sqlite.prepare(`SELECT name FROM __migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
        expect(names).toEqual(sqlFiles); // nothing re-applied, and the record of 0007 is untouched
        // statements the previous release issues keep working on the extended tables (it names the columns it knows)
        rolledBack.sqlite.prepare(`INSERT INTO wallet_meta (id, address, created_at) VALUES (?, ?, ?)`).run("0xabc", "0xAbC", "2026-10-03T00:00:00.000Z");
        expect(rolledBack.sqlite.prepare(`SELECT id, address, created_at FROM wallet_meta WHERE id = '0xabc'`).get()).toMatchObject({ address: "0xAbC" });
        insertPayment(rolledBack.sqlite, "p-old-image", "reserved");
        expect(rolledBack.sqlite.prepare(`SELECT count(*) AS n FROM payments`).get()).toEqual({ n: 2 });
        // and the data the new release wrote is all still there
        expect(rolledBack.sqlite.prepare(`SELECT backup_confirmed_at, origin FROM wallet_meta WHERE id = ?`).get(ADDRESS.toLowerCase())).toEqual({ backup_confirmed_at: null, origin: "generated" });
      } finally {
        rolledBack.sqlite.close();
      }
      // finally the new release opens it again without complaint
      const again = openDb({ filePath: file });
      expect(listRetiredWallets(again.db)).toHaveLength(1);
      again.sqlite.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks: harmless */
      }
    }
  });

  it("the copy bundled with the moneyswitch-server package is byte-identical", () => {
    const bundled = path.resolve(here, "..", "..", "..", "apps", "server-pkg", "migrations");
    for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"))) {
      expect(fs.readFileSync(path.join(bundled, f), "utf-8").replace(/\r\n/g, "\n"), f).toBe(
        fs.readFileSync(path.join(migrationsDir, f), "utf-8").replace(/\r\n/g, "\n")
      );
    }
  });
});
