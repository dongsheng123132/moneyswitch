import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFilePath: string;
  walletPassword: string | null;
  /** Base URL of the demo x402 seller (set by scripts/demo-*.mjs), used by the Dashboard's one-click demo channel. */
  demoSellerUrl?: string | null;
  /** Absolute path of the packed client CLI tarball served at GET /dl/moneyswitch.tgz (defaults to apps/cli/pack/moneyswitch.tgz). */
  cliTarballPath?: string | null;
}

function defaultDataDir(): string {
  return path.join(os.homedir(), ".moneyswitch");
}

export function loadConfig(): ServerConfig {
  const port = Number(process.env.MONEYSWITCH_PORT || 4020);
  const host = process.env.MONEYSWITCH_HOST || "127.0.0.1";
  const dataDir = process.env.MONEYSWITCH_DATA_DIR || defaultDataDir();
  const dbFilePath = process.env.MONEYSWITCH_DB_PATH || path.join(dataDir, "moneyswitch.sqlite");
  let walletPassword: string | null = process.env.MONEYSWITCH_WALLET_PASSWORD ?? null;
  if (!walletPassword && process.env.MONEYSWITCH_WALLET_PASSWORD_FILE) {
    try {
      walletPassword = fs.readFileSync(process.env.MONEYSWITCH_WALLET_PASSWORD_FILE, "utf-8").trim();
    } catch {
      walletPassword = null;
    }
  }
  const demoSellerUrl = process.env.MONEYSWITCH_DEMO_SELLER_URL?.trim() || null;
  return { port, host, dataDir, dbFilePath, walletPassword, demoSellerUrl };
}
