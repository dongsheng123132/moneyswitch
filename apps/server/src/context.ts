import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken } from "@moneyswitch/core";
import type { ServerConfig } from "./config.js";

export interface AppContext {
  db: MoneySwitchDb;
  sqlite: Database.Database;
  wallet: LocalWalletDriver;
  config: ServerConfig;
}

/** Builds the app context, running DB migrations and printing a fresh admin token exactly once. */
export async function buildContext(config: ServerConfig): Promise<AppContext> {
  const { db, sqlite } = openDb({ filePath: config.dbFilePath });
  const wallet = new LocalWalletDriver(config.dataDir);

  const freshAdminToken = bootstrapAdminToken(db);
  if (freshAdminToken) {
    // Only place this ever gets printed. Never logged again, never stored
    // in plaintext, never included in any API response.
    // eslint-disable-next-line no-console
    console.log(`\n[moneyswitch] Admin token (save this now, it will not be shown again):\n  ${freshAdminToken}\n`);
  }

  if (config.walletPassword && wallet.hasKeystore()) {
    try {
      await wallet.unlock(config.walletPassword);
      console.log("[moneyswitch] Wallet unlocked from MONEYSWITCH_WALLET_PASSWORD(_FILE)");
    } catch {
      console.log("[moneyswitch] Failed to unlock wallet with provided password; remains locked");
    }
  }

  return { db, sqlite, wallet, config };
}
