import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "@moneyswitch/db";
import { freshDb } from "./helpers.js";
import { createMoneyKey } from "../src/keys.js";
import { evaluateAndReserve, ApprovalRequiredError } from "../src/policy.js";
import { decideApproval } from "../src/approval.js";
import { getPayment, markUnknown, settlePayment, failPayment } from "../src/payments.js";

const input = {
  url: "https://example.com/data", host: "example.com:443", method: "GET", body: undefined,
  network: "eip155:84532", asset: "0xusdc", payTo: "0xseller", amount: 10_000n,
};
const keyInput = { name: "data-agent", totalBudget: 10_000_000n, dailyBudget: 1_000_000n, perRequestLimit: 100_000n, allowedHosts: ["example.com:443"] };

describe("optional payment purpose", () => {
  it("defaults to null and keeps the original purpose through settlement, uncertainty and failure", () => {
    const { db, sqlite } = freshDb();
    try {
      const { row: key } = createMoneyKey(db, keyInput);
      const unannotated = evaluateAndReserve(db, key, input).paymentId;
      expect(getPayment(db, unannotated)?.purpose).toBeNull();
      const annotated = evaluateAndReserve(db, key, { ...input, purpose: "获取市场数据" }).paymentId;
      expect(getPayment(db, annotated)?.purpose).toBe("获取市场数据");
      markUnknown(db, annotated, "TIMEOUT_AFTER_PAYMENT");
      expect(getPayment(db, annotated)?.purpose).toBe("获取市场数据");
      settlePayment(db, annotated, "0xsettled");
      expect(getPayment(db, annotated)).toMatchObject({ purpose: "获取市场数据", txHash: "0xsettled", status: "settled" });
      failPayment(db, unannotated, "NOT_SIGNED");
      expect(getPayment(db, unannotated)?.purpose).toBeNull();
    } finally { sqlite.close(); }
  });

  it("annotations do not change approval identity and a used approval cannot create another payment", () => {
    const { db, sqlite } = freshDb();
    try {
      const { row: key } = createMoneyKey(db, { ...keyInput, approvalThreshold: 1n });
      let approvalId: string | undefined;
      try { evaluateAndReserve(db, key, { ...input, purpose: "private first draft" }); }
      catch (error) {
        expect(error).toBeInstanceOf(ApprovalRequiredError);
        approvalId = (error as ApprovalRequiredError).approvalId;
      }
      expect(approvalId).toBeTruthy();
      decideApproval(db, approvalId!, "approved");
      const paymentId = evaluateAndReserve(db, key, { ...input, approvalId, purpose: "获取市场数据" }).paymentId;
      expect(getPayment(db, paymentId)?.purpose).toBe("获取市场数据");
      expect(() => evaluateAndReserve(db, key, { ...input, approvalId, purpose: "changed annotation" })).toThrow("APPROVAL_INVALID");
      expect(sqlite.prepare("SELECT count(*) AS n FROM payments").get()).toEqual({ n: 1 });
      expect(getPayment(db, paymentId)?.purpose).toBe("获取市场数据");
    } finally { sqlite.close(); }
  });

  it("migration adds only a nullable purpose and preserves old records on repeated opening", () => {
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-purpose-migration-"));
    const file = path.join(dir, "old.sqlite");
    try {
      const old = new Database(file);
      old.exec("CREATE TABLE __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const filename of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f < "0012").sort()) {
        old.exec(fs.readFileSync(path.join(migrationsDir, filename), "utf8"));
        old.prepare("INSERT INTO __migrations VALUES (?, ?)").run(filename, "2026-10-11T00:00:00Z");
      }
      old.prepare(`INSERT INTO payments (id, key_id, url, host, method, network, asset, pay_to, amount, status, created_at, updated_at)
        VALUES ('old', 'legacy-key', 'https://example.com/data', 'example.com:443', 'GET', 'eip155:84532', '0xusdc', '0xseller', 10000, 'settled', '2026-10-11T00:00:00Z', '2026-10-11T00:00:00Z')`).run();
      const before = old.prepare("SELECT * FROM payments WHERE id = 'old'").get() as Record<string, unknown>;
      const beforeColumns = old.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string }>;
      old.close();
      const migrated = openDb({ filePath: file });
      expect(migrated.sqlite.prepare("SELECT * FROM payments WHERE id = 'old'").get()).toEqual({ ...before, purpose: null });
      const columns = migrated.sqlite.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string; notnull: number }>;
      expect(columns.map((c) => c.name)).toEqual([...beforeColumns.map((c) => c.name), "purpose"]);
      expect(columns.at(-1)?.notnull).toBe(0);
      expect(getPayment(migrated.db, "old")?.purpose).toBeNull();
      migrated.sqlite.close();
      const again = openDb({ filePath: file });
      expect(again.sqlite.prepare("SELECT * FROM payments WHERE id = 'old'").get()).toEqual({ ...before, purpose: null });
      expect(again.sqlite.prepare("SELECT count(*) AS n FROM __migrations WHERE name = '0012_payment_purpose.sql'").get()).toEqual({ n: 1 });
      again.sqlite.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
