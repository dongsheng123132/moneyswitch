import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMaxKeyDepth } from "@moneyswitch/core";

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
  /** v0.4 (SPEC-v0.4 §A): MONEYSWITCH_MAX_KEY_DEPTH (default 3 = root + 3 levels of child keys). */
  maxKeyDepth?: number;
  /**
   * v0.5 (SPEC-v0.5 §2): x402 facilitator the toll booths verify/settle with.
   * Defaults to the active network's facilitator (MONEYSWITCH_FACILITATOR_URL).
   */
  facilitatorUrl?: string | null;
  /**
   * v0.5: public base URL buyers use to reach this server (e.g.
   * https://pay.example.com), from MONEYSWITCH_PUBLIC_URL. When unset, the
   * Dashboard shows the origin it was opened from.
   */
  publicUrl?: string | null;
  /**
   * v0.5: how often (ms) to run reconcileUnknownPayments in the background.
   * MONEYSWITCH_RECONCILE_INTERVAL_MS, default 60000; 0 disables the loop
   * (the admin can still trigger it on demand via POST /v1/admin/reconcile).
   */
  reconcileIntervalMs?: number;
  /**
   * Directory with the built Dashboard (index.html + assets). Defaults to
   * apps/dashboard/dist; the `moneyswitch-server` npm package ships its own
   * copy (MONEYSWITCH_DASHBOARD_DIR).
   */
  dashboardDir?: string | null;
  /** Directory with the SQL migrations (defaults to packages/db/migrations). */
  migrationsDir?: string | null;
  /**
   * Offline demo mode (`npx moneyswitch-server demo`). Only ever set in code by
   * the demo runner — there is no environment variable for it. It never
   * relaxes authentication; it only (a) tells the Dashboard to show the
   * "DEMO · simulated settlement" banner + guide card, (b) reports a simulated
   * wallet balance instead of querying the chain, (c) skips on-chain
   * reconciliation (every settlement goes through the mock facilitator).
   */
  demo?: DemoModeInfo | null;
}

export interface DemoModeInfo {
  /** Simulated starting wallet balance, in USDC micros. */
  startingBalanceMicros: number;
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
  const maxKeyDepth = parseMaxKeyDepth(process.env.MONEYSWITCH_MAX_KEY_DEPTH);
  const publicUrl = process.env.MONEYSWITCH_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  const rawReconcileInterval = process.env.MONEYSWITCH_RECONCILE_INTERVAL_MS;
  const parsedReconcileInterval = rawReconcileInterval != null ? Number(rawReconcileInterval) : NaN;
  const dashboardDir = process.env.MONEYSWITCH_DASHBOARD_DIR?.trim() || null;
  const reconcileIntervalMs = Number.isFinite(parsedReconcileInterval) && parsedReconcileInterval >= 0
    ? parsedReconcileInterval
    : 60_000;
  return {
    port,
    host,
    dataDir,
    dbFilePath,
    walletPassword,
    demoSellerUrl,
    maxKeyDepth,
    publicUrl,
    reconcileIntervalMs,
    dashboardDir,
  };
}
