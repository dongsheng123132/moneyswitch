// The administrator-token reset (SPEC.md §2: "lost it: run the reset command on the server"): resetAdminTokenInFile is what both
// `moneyswitch-server reset-admin-token` and scripts/admin-reset-token.mjs call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@moneyswitch/db";
import {
  AdminResetError,
  authenticateMoneyKey,
  bootstrapAdminToken,
  createMoneyKey,
  ownerMismatch,
  parseUsdcToMicros,
  resetAdminTokenInFile,
  verifyAdminToken,
} from "../src/index.js";

let dir: string;
let dbFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-admin-reset-"));
  dbFile = path.join(dir, "moneyswitch.sqlite");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A data directory as a server leaves it: a migrated database, the first-start admin token, one MoneyKey. */
function seed(): { oldToken: string; moneyKey: string } {
  const { db, sqlite } = openDb({ filePath: dbFile });
  try {
    const oldToken = bootstrapAdminToken(db)!;
    const { plaintextKey } = createMoneyKey(db, {
      name: "agent",
      totalBudget: parseUsdcToMicros("5"),
      dailyBudget: parseUsdcToMicros("1"),
      perRequestLimit: parseUsdcToMicros("0.1"),
      approvalThreshold: null,
      allowedHosts: ["example.com:443"],
    });
    return { oldToken, moneyKey: plaintextKey };
  } finally {
    sqlite.close();
  }
}

describe("resetAdminTokenInFile", () => {
  it("returns a new token: the old one stops working, the new one works, everything else stays", () => {
    const { oldToken, moneyKey } = seed();
    const fresh = resetAdminTokenInFile(dbFile);
    expect(fresh).toMatch(/^ms_admin_[A-Za-z0-9]+$/);
    expect(fresh).not.toBe(oldToken);

    const { db, sqlite } = openDb({ filePath: dbFile });
    try {
      expect(verifyAdminToken(db, oldToken)).toBe(false);
      expect(verifyAdminToken(db, fresh)).toBe(true);
      expect(authenticateMoneyKey(db, moneyKey).name).toBe("agent");
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM admin_auth").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("stores only a hash: the new token is nowhere in the database files", () => {
    seed();
    const fresh = resetAdminTokenInFile(dbFile);
    for (const name of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, name)).includes(Buffer.from(fresh)), name).toBe(false);
    }
  });

  it("works while a server holds the database open, and that server sees the change at once (no restart)", () => {
    const { oldToken } = seed();
    const server = openDb({ filePath: dbFile }); // what the running service has open
    try {
      expect(verifyAdminToken(server.db, oldToken)).toBe(true);
      const fresh = resetAdminTokenInFile(dbFile);
      expect(verifyAdminToken(server.db, oldToken)).toBe(false);
      expect(verifyAdminToken(server.db, fresh)).toBe(true);
    } finally {
      server.sqlite.close();
    }
  });

  it("refuses a data directory without a database, says so, and creates nothing", () => {
    let error: unknown;
    try {
      resetAdminTokenInFile(dbFile);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdminResetError);
    expect((error as AdminResetError).code).toBe("NO_DATABASE");
    expect((error as AdminResetError).message).toContain(dbFile);
    expect((error as AdminResetError).message).toMatch(/No MoneySwitch database found/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a path that is a directory", () => {
    fs.mkdirSync(dbFile);
    expect(() => resetAdminTokenInFile(dbFile)).toThrowError(/No MoneySwitch database found/);
  });

  it("refuses a file that is not a database, and leaves it as it was", () => {
    const junk = Buffer.alloc(2048, 7);
    fs.writeFileSync(dbFile, junk);
    let error: unknown;
    try {
      resetAdminTokenInFile(dbFile);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdminResetError);
    expect((error as AdminResetError).code).toBe("DATABASE_ERROR");
    expect(fs.readFileSync(dbFile).equals(junk)).toBe(true);
  });

  it("a failure half-way keeps the old token valid (delete and insert are one transaction)", () => {
    const { oldToken } = seed();
    const raw = openDb({ filePath: dbFile });
    raw.sqlite.exec("CREATE TRIGGER block_admin_insert BEFORE INSERT ON admin_auth BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END;");
    raw.sqlite.close();

    let error: unknown;
    try {
      resetAdminTokenInFile(dbFile);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AdminResetError);
    expect((error as AdminResetError).code).toBe("DATABASE_ERROR");
    expect((error as AdminResetError).message).toContain("blocked for the test");

    const after = openDb({ filePath: dbFile });
    try {
      expect(verifyAdminToken(after.db, oldToken)).toBe(true);
    } finally {
      after.sqlite.close();
    }
  });

  it("does not run migrations: the database is changed in nothing but the administrator token", () => {
    seed();
    const before = openDb({ filePath: dbFile });
    before.sqlite.prepare("DELETE FROM __migrations WHERE name = (SELECT MAX(name) FROM __migrations)").run();
    const applied = before.sqlite.prepare("SELECT COUNT(*) AS n FROM __migrations").get() as { n: number };
    before.sqlite.close();

    resetAdminTokenInFile(dbFile);

    const after = openDb({ filePath: dbFile, migrate: false });
    try {
      expect(after.sqlite.prepare("SELECT COUNT(*) AS n FROM __migrations").get()).toEqual(applied);
    } finally {
      after.sqlite.close();
    }
  });
});

describe("ownerMismatch: the reset runs as the user that owns the database", () => {
  it("same uid: fine; another uid: refused; no uid (Windows): never refused", () => {
    expect(ownerMismatch(1000, 1000)).toBe(false);
    expect(ownerMismatch(0, 0)).toBe(false);
    expect(ownerMismatch(1000, 0)).toBe(true);
    expect(ownerMismatch(0, 1000)).toBe(true);
    expect(ownerMismatch(0, null)).toBe(false);
    expect(ownerMismatch(1000, undefined)).toBe(false);
  });
});
