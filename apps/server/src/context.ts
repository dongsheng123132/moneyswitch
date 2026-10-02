import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, SetupTokenStore, type AuthorizationReader } from "@moneyswitch/core";
import { createMultiNetworkAuthorizationReader } from "@moneyswitch/x402";
import type { ServerConfig } from "./config.js";
import type { NotifyRuntimeOptions } from "./notify/types.js";

export interface AppContext {
  db: MoneySwitchDb;
  sqlite: Database.Database;
  wallet: LocalWalletDriver;
  config: ServerConfig;
  /** First-run one-time setup link store (memory only). Absent/inactive on every boot except the first of a data dir. */
  setup?: SetupTokenStore;
  /**
   * v0.5: on-chain reader used by reconcileUnknownPayments (the background
   * loop and POST /v1/admin/reconcile). buildContext always sets a real
   * viem-backed reader against the active network's RPC; test suites that
   * build an AppContext by hand (bypassing buildContext) should inject a
   * fake reader here instead of leaving this unset, so reconciliation never
   * touches a real RPC endpoint. Left undefined, reconcile is a no-op.
   */
  chainReader?: AuthorizationReader;
  /**
   * Approval push notifications: test seams (fake fetch / env / clock / retry
   * policy). Leave unset in production; the notifier then uses the global
   * (proxy-aware) fetch, process.env and its default retry policy.
   */
  notify?: NotifyRuntimeOptions;
}

/** Host to put in the printed setup link: a wildcard bind address is not browsable, use loopback instead. */
function browsableHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** What the first boot of a data directory produces (see buildContext's onFirstRun). */
export interface FirstRunSecrets {
  adminToken: string;
  setupToken: string;
  /** `http://<host>:<port>/setup#<setupToken>` — the one-time setup link. */
  setupUrl: string;
}

export interface BuildContextOptions {
  /**
   * Replaces the default "print the admin token + one-time setup link to
   * stdout" on the first boot of a data dir. Used by the offline demo
   * runner, which is the process that owns that stdout anyway: it opens the
   * very same one-time link in the browser. Same secrets, same channel —
   * no extra way to obtain them.
   */
  onFirstRun?: (secrets: FirstRunSecrets) => void;
}

/** Builds the app context, running DB migrations and printing a fresh admin token exactly once. */
export async function buildContext(config: ServerConfig, opts: BuildContextOptions = {}): Promise<AppContext> {
  const { db, sqlite } = openDb({ filePath: config.dbFilePath, migrationsDir: config.migrationsDir ?? undefined });
  const wallet = new LocalWalletDriver(config.dataDir);

  const setup = new SetupTokenStore();
  const setupBase = config.publicUrl?.replace(/\/+$/, "") || `http://${browsableHost(config.host)}:${config.port}`;
  const freshAdminToken = bootstrapAdminToken(db);
  if (freshAdminToken && opts.onFirstRun) {
    const setupToken = setup.issue(freshAdminToken);
    opts.onFirstRun({
      adminToken: freshAdminToken,
      setupToken,
      setupUrl: `${setupBase}/setup#${setupToken}`,
    });
  } else if (freshAdminToken) {
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
        `  ${setupBase}/setup#${setupToken}\n`
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

  // Demo mode settles through the mock facilitator only (0xmock… hashes that
  // never exist on chain): leave the reader unset so reconcile is a no-op and
  // nothing ever talks to a real RPC endpoint.
  const chainReader = config.demo ? undefined : createMultiNetworkAuthorizationReader();

  return { db, sqlite, wallet, config, setup, chainReader };
}
