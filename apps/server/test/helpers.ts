import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver, type LocalWalletDriverOptions } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import { buildApp } from "../src/app.js";
import type { AppContext } from "../src/context.js";
import type { ServerConfig } from "../src/config.js";

export interface TestCtx {
  ctx: AppContext;
  app: ReturnType<typeof buildApp>;
  adminToken: string;
  tmpDir: string;
}

export async function buildTestApp(
  opts: { unlockWallet?: boolean; port?: number; walletOptions?: LocalWalletDriverOptions } = {}
): Promise<TestCtx> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-server-test-"));
  const { db, sqlite } = openDb({ filePath: ":memory:" });
  // (no OS-level ACL work unless a test asks for it: on Windows that starts PowerShell)
  const wallet = new LocalWalletDriver(tmpDir, { protect: false, ...opts.walletOptions });
  if (opts.unlockWallet) {
    await wallet.createWithPhrase(); // auto-unlock, like every wallet the server creates
  }
  const adminToken = bootstrapAdminToken(db)!;
  const config: ServerConfig = {
    port: opts.port ?? 4020,
    host: "127.0.0.1",
    dataDir: tmpDir,
    dbFilePath: ":memory:",
    walletPassword: null,
  };
  const ctx: AppContext = { db, sqlite: sqlite as Database.Database, wallet, config };
  const app = buildApp(ctx);
  await app.ready();
  return { ctx, app, adminToken, tmpDir };
}

export async function cleanupTestApp(t: TestCtx) {
  await t.app.close();
  fs.rmSync(t.tmpDir, { recursive: true, force: true });
}
