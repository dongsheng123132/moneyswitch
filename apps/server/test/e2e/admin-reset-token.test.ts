import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import type { ServerConfig } from "../../src/config.js";

/**
 * scripts/admin-reset-token.mjs recovery path: run the REAL CLI script as a
 * subprocess against a throwaway data directory (never .data/testnet or any
 * other live directory), then confirm the old admin token is rejected and
 * the freshly-printed one works — against a real (non-:memory:) SQLite file,
 * matching how the script is actually used.
 */

let tmpDir: string;
let app: ReturnType<typeof buildApp> | undefined;
let sqliteHandle: Database.Database | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  sqliteHandle?.close();
  sqliteHandle = undefined;
  if (tmpDir) {
    // Windows can briefly hold the -wal/-shm files even after close(); retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

describe("scripts/admin-reset-token.mjs", () => {
  it("invalidates the old admin token and issues a new one that works", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-reset-token-test-"));
    const dbFilePath = path.join(tmpDir, "moneyswitch.sqlite");

    const opened = openDb({ filePath: dbFilePath });
    const db: MoneySwitchDb = opened.db;
    const sqlite: Database.Database = opened.sqlite;
    sqliteHandle = sqlite;
    const oldToken = bootstrapAdminToken(db)!;
    expect(oldToken.startsWith("ms_admin_")).toBe(true);

    const wallet = new LocalWalletDriver(tmpDir);
    const config: ServerConfig = {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      dbFilePath,
      walletPassword: null,
    };
    const ctx: AppContext = { db, sqlite, wallet, config };
    app = buildApp(ctx);
    await app.ready();

    // Old token works before reset.
    const before = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(before.statusCode).toBe(200);

    // Run the real CLI script against the same data directory. The server
    // (and its open `db`/`sqlite` handles above) stays "running" throughout,
    // exercising the "works even if the server is up" requirement.
    const scriptPath = path.resolve(__dirname, "../../../../scripts/admin-reset-token.mjs");
    const output = execFileSync(process.execPath, [scriptPath, "--data-dir", tmpDir], {
      encoding: "utf-8",
    });
    const match = /(ms_admin_[A-Za-z0-9]+)/.exec(output);
    expect(match).not.toBeNull();
    const newToken = match![1];
    expect(newToken).not.toBe(oldToken);

    // Old token is now rejected.
    const oldAfter = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(oldAfter.statusCode).toBe(403);

    // New token works.
    const newAfter = await app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(newAfter.statusCode).toBe(200);
  });

  it("refuses a data directory without a database: exit 1, a clear message, nothing created", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-reset-token-empty-"));
    const scriptPath = path.resolve(__dirname, "../../../../scripts/admin-reset-token.mjs");
    const r = spawnSync(process.execPath, [scriptPath, "--data-dir", tmpDir], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No MoneySwitch database found/);
    expect(r.stdout).toBe("");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
