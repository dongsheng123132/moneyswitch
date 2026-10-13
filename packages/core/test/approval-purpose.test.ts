import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createApproval, getApproval, decideApproval } from "../src/approval.js";

describe("approval task descriptions", () => {
  it("keeps only explicitly supplied descriptions, including after a decision", () => {
    const { db, sqlite } = freshDb();
    try {
      const input = { keyId: "key", url: "https://example.com", method: "POST", body: { purpose: "private request body" }, network: "eip155:8453", asset: "usdc", payTo: "seller", amount: 127000n };
      expect(createApproval(db, input).purpose).toBeNull();
      expect(createApproval(db, { ...input, purpose: "   " }).purpose).toBeNull();
      const approval = createApproval(db, { ...input, purpose: "  制作虾盘横版海报  " });
      expect(approval.purpose).toBe("制作虾盘横版海报");
      decideApproval(db, approval.id, "denied");
      expect(getApproval(db, approval.id)).toMatchObject({ status: "denied", purpose: "制作虾盘横版海报" });
    } finally { sqlite.close(); }
  });

  it("migrates an existing database without changing old approvals and applies the migration once", () => {
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-approval-purpose-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const old = new Database(file);
      old.exec("CREATE TABLE __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const filename of fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql") && f < "0013").sort()) {
        old.exec(fs.readFileSync(path.join(migrationsDir, filename), "utf8"));
        old.prepare("INSERT INTO __migrations VALUES (?, ?)").run(filename, "2026-10-13T00:00:00Z");
      }
      old.prepare(`INSERT INTO approvals (id, key_id, url, method, body_sha256, network, asset, pay_to, amount, status, expires_at, created_at)
        VALUES ('old', 'key', 'https://example.com', 'GET', 'hash', 'eip155:8453', 'usdc', 'seller', 127000, 'expired', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run();
      const before = old.prepare("SELECT * FROM approvals WHERE id = 'old'").get() as Record<string, unknown>;
      old.close();
      for (let i = 0; i < 2; i++) {
        const migrated = openDb({ filePath: file });
        expect(migrated.sqlite.prepare("SELECT * FROM approvals WHERE id = 'old'").get()).toEqual({ ...before, purpose: null });
        expect(getApproval(migrated.db, "old")?.purpose).toBeNull();
        expect(migrated.sqlite.prepare("SELECT count(*) AS n FROM __migrations WHERE name = '0013_approval_purpose.sql'").get()).toEqual({ n: 1 });
        migrated.sqlite.close();
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
