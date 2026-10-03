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
  hasReservedPayments,
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

describe("hasReservedPayments", () => {
  it("is true only while a payment row is in status reserved", () => {
    const { db, sqlite } = freshDb();
    expect(hasReservedPayments(db)).toBe(false);
    insertPayment(sqlite, "p-settled", "settled");
    insertPayment(sqlite, "p-unknown", "unknown");
    insertPayment(sqlite, "p-failed", "failed");
    expect(hasReservedPayments(db)).toBe(false);
    insertPayment(sqlite, "p-reserved", "reserved");
    expect(hasReservedPayments(db)).toBe(true);
    sqlite.prepare(`UPDATE payments SET status = 'settled' WHERE id = 'p-reserved'`).run();
    expect(hasReservedPayments(db)).toBe(false);
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
        expect(applied.at(-1)).toBe("0007_wallet_lifecycle.sql");
        const metaCols = (sqlite.prepare(`PRAGMA table_info(wallet_meta)`).all() as { name: string }[]).map((c) => c.name);
        expect(metaCols).toEqual(["id", "address", "created_at", "backup_confirmed_at", "origin"]);
        const retCols = (sqlite.prepare(`PRAGMA table_info(wallet_retirements)`).all() as { name: string }[]).map((c) => c.name);
        expect(retCols).toEqual(["id", "address", "retired_at", "reason", "keystore_file", "secret_file", "replaced_by"]);
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

  it("the copy bundled with the moneyswitch-server package is byte-identical", () => {
    const bundled = path.resolve(here, "..", "..", "..", "apps", "server-pkg", "migrations");
    for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"))) {
      expect(fs.readFileSync(path.join(bundled, f), "utf-8").replace(/\r\n/g, "\n"), f).toBe(
        fs.readFileSync(path.join(migrationsDir, f), "utf-8").replace(/\r\n/g, "\n")
      );
    }
  });
});
