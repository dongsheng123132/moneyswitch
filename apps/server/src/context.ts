import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, SetupTokenStore } from "@moneyswitch/core";
import type { ServerConfig } from "./config.js";

export interface AppContext {
  db: MoneySwitchDb;
  sqlite: Database.Database;
  wallet: LocalWalletDriver;
  config: ServerConfig;
  /** First-run one-time setup link store (memory only). Absent/inactive on every boot except the first of a data dir. */
  setup?: SetupTokenStore;
}

/** Host to put in the printed setup link: a wildcard bind address is not browsable, use loopback instead. */
function browsableHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** Builds the app context, running DB migrations and printing a fresh admin token exactly once. */
export async function buildContext(config: ServerConfig): Promise<AppContext> {
  const { db, sqlite } = openDb({ filePath: config.dbFilePath });
  const wallet = new LocalWalletDriver(config.dataDir);

  const setup = new SetupTokenStore();
  const freshAdminToken = bootstrapAdminToken(db);
  if (freshAdminToken) {
    // Only place this ever gets printed. Never logged again, never stored
    // in plaintext. The only API that can hand it out is the one-time setup
    // claim below, which requires the setup token printed right next to it.
    // eslint-disable-next-line no-console
    console.log(`\n[moneyswitch] Admin token (save this now, it will not be shown again):\n  ${freshAdminToken}\n`);
    // One-time setup link (docs/ux-audit.md, threat analysis §1): same
    // channel as the admin token above, single use, memory only, 30 min.
    const setupToken = setup.issue(freshAdminToken);
    console.log(
      `[moneyswitch] First-run setup: open this one-time link in your browser (valid 30 min, single use):\n` +
        `  http://${browsableHost(config.host)}:${config.port}/setup#${setupToken}\n`
    );
  }

  if (config.walletPassword && wallet.hasKeystore()) {
    try {
      await wallet.unlock(config.walletPassword);
      console.log("[moneyswitch] Wallet unlocked from MONEYSWITCH_WALLET_PASSWORD(_FILE)");
    } catch {
      console.log("[moneyswitch] Failed to unlock wallet with provided password; remains locked");
    }
  }

  return { db, sqlite, wallet, config, setup };
}
