import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver } from "@moneyswitch/wallet";
import { bootstrapAdminToken, SetupTokenStore, sweepStaleReservations, type AuthorizationReader } from "@moneyswitch/core";
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

/**
 * Unlocks the wallet at startup, in this order: MONEYSWITCH_WALLET_PASSWORD(_FILE)
 * when it is non-empty, else the wallet's own unlock secret, else stay locked. Every
 * source that was tried gets its OWN log line with its OWN reason (a stale environment
 * password is never blamed for a wrong secret, or the other way round); only outcomes
 * are logged, never a credential. The result is also kept on the driver
 * (unlockStatus) so GET /v1/admin/wallet can report it.
 */
export async function unlockWalletOnStartup(wallet: LocalWalletDriver, password: string | null | undefined): Promise<void> {
  const report = await wallet.unlockOnStartup({ password });
  if (!wallet.hasKeystore()) {
    const orphans = wallet.orphanFiles();
    if (orphans.secrets.length > 0 || orphans.retired > 0) {
      console.error(
        "[moneyswitch] WARNING: wallet.json is missing from the data directory, but credential files of an earlier wallet are still there " +
          `(${orphans.secrets.length} unlock secret file(s), ${orphans.retired} file(s) in retired/). ` +
          "Is the data directory mounted from the right place? Restore wallet.json from your backup, or create/import a wallet in the Dashboard: " +
          "the existing files are kept, never overwritten."
      );
    }
    return;
  }
  if (report.restoredSecret) {
    console.log(
      `[moneyswitch] This wallet's unlock secret had been moved to retired/${report.restoredSecret} (while wallet.json belonged to another wallet). ` +
        "It opens this wallet, so it was moved back."
    );
  }
  const secretName = (): string => {
    const file = wallet.secretPath;
    return file ? path.basename(file) : "wallet-unlock-<address>.secret";
  };
  const autoWallet = wallet.protection() === "auto";
  for (const attempt of report.attempts) {
    if (attempt.ok) {
      console.log(
        attempt.source === "env_or_file"
          ? "[moneyswitch] Wallet unlocked from MONEYSWITCH_WALLET_PASSWORD(_FILE)"
          : `[moneyswitch] Wallet unlocked automatically (unlock secret ${secretName()})`
      );
    } else if (attempt.source === "env_or_file") {
      console.error(
        "[moneyswitch] ERROR: MONEYSWITCH_WALLET_PASSWORD(_FILE) is set but does not unlock wallet.json (wrong password). Fix or remove it." +
          (autoWallet ? " The wallet's own auto-unlock is tried next." : "")
      );
    } else {
      const what: Record<string, string> = {
        secret_missing: "is missing",
        secret_empty: "is empty",
        secret_unreadable: "cannot be read",
        secret_wrong: "does not open wallet.json",
      };
      // A secret that an earlier start moved aside (wallet.json belonged to another key then) is named exactly, so nobody has to guess.
      const aside = attempt.reason === "secret_missing" && report.retiredSecretFiles?.length ? report.retiredSecretFiles : null;
      console.error(
        `[moneyswitch] ERROR: auto-unlock is ON for this wallet, but its unlock secret (${secretName()}) ${what[attempt.reason ?? "secret_wrong"] ?? "does not work"}, so the wallet stays LOCKED. ` +
          (aside
            ? `This wallet's secret was moved aside before (while wallet.json belonged to another wallet): ${aside.map((n) => `retired/${n}`).join(", ")} - but ${aside.length === 1 ? "it does" : "they do"} not open this wallet, so it was not moved back. ` +
              "Restore the right file from a backup of the data directory, or use Replace wallet in the Dashboard (import your recovery phrase or private key)."
            : "Restore that file from a backup of the data directory, or use Replace wallet in the Dashboard (import your recovery phrase or private key).")
      );
    }
  }
  if (!report.unlocked && report.attempts.length === 0) {
    console.log("[moneyswitch] Wallet is locked: no unlock credential configured. Unlock it in the Dashboard (Wallet page).");
  }
  const protection = wallet.secretProtection;
  if (protection && !protection.ok) {
    console.error(
      `[moneyswitch] WARNING: could not restrict access to the data directory / unlock secret to this account (${protection.detail ?? "unverified"}). ` +
        "Other accounts or programs on this machine may be able to read the secret that opens the wallet. Keep only a small float in it; the Dashboard shows the same warning."
    );
  }
}

/** Builds the app context, running DB migrations and printing a fresh admin token exactly once. */
export async function buildContext(config: ServerConfig, opts: BuildContextOptions = {}): Promise<AppContext> {
  // "This boot": every payment still `reserved` that was created before it belongs to a process that no longer exists.
  const bootedAt = new Date().toISOString();
  const { db, sqlite } = openDb({ filePath: config.dbFilePath, migrationsDir: config.migrationsDir ?? undefined });
  const swept = sweepStaleReservations(db, bootedAt);
  if (swept.toUnknown.length > 0 || swept.toFailed.length > 0) {
    console.log(
      `[moneyswitch] Startup: ${swept.toFailed.length + swept.toUnknown.length} payment(s) were in flight when the previous process stopped: ` +
        `${swept.toFailed.length} had nothing signed and were released, ${swept.toUnknown.length} were kept as unknown until the chain is checked.`
    );
  }
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

  await unlockWalletOnStartup(wallet, config.walletPassword);

  // Demo mode settles through the mock facilitator only (0xmock… hashes that
  // never exist on chain): leave the reader unset so reconcile is a no-op and
  // nothing ever talks to a real RPC endpoint.
  const chainReader = config.demo ? undefined : createMultiNetworkAuthorizationReader();

  return { db, sqlite, wallet, config, setup, chainReader };
}
