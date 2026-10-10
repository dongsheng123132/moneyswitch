import path from "node:path";
import { openDb, type MoneySwitchDb } from "@moneyswitch/db";
import type Database from "better-sqlite3";
import { LocalWalletDriver, type LocalWalletDriverOptions } from "@moneyswitch/wallet";
import { bootstrapAdminToken, SetupTokenStore, sweepStaleReservations, writeAudit, type AuthorizationReader } from "@moneyswitch/core";
import { createBalanceReader, createMultiNetworkAuthorizationReader, type KnownBalanceReader } from "@moneyswitch/x402";
import type { ServerConfig } from "./config.js";
import { publicBaseUrl } from "./public-base.js";

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
   * The wallet's USDC balance per chain, read before a payment goes out so it is made on a chain that can cover it (SPEC.md §6;
   * INSUFFICIENT_FUNDS when none can). buildContext sets a real one (the wallet page's own RPC read, cached 15 s); test suites that
   * build an AppContext by hand should inject a fake or leave it unset, which means balances are not looked at and no RPC is touched.
   */
  balanceReader?: KnownBalanceReader;
}

export interface BuildContextOptions {
  /** Test seam: options for the wallet driver (cheap scrypt, no OS-level ACL work, a short drain). Leave unset in production. */
  walletOptions?: LocalWalletDriverOptions;
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
          "Is the data directory mounted from the right place? Restore wallet.json from your backup, or create a new wallet in the Dashboard: " +
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
              "Restore the right file from a backup of the data directory, or use Replace wallet in the Dashboard (a new wallet; the old files stay in retired/)."
            : "Restore that file from a backup of the data directory, or use Replace wallet in the Dashboard (a new wallet; the old files stay in retired/).")
      );
    }
  }
  if (!report.unlocked && report.attempts.length === 0) {
    console.log(
      "[moneyswitch] Wallet is locked: no unlock credential configured. Set MONEYSWITCH_WALLET_PASSWORD(_FILE) and restart, or replace the wallet in the Dashboard (Wallet page)."
    );
  }
  const openers = wallet.retiredSecretsOpeningLiveKey;
  if (openers.length > 0) {
    console.error(
      `[moneyswitch] WARNING: ${openers.map((f) => `retired/${f}`).join(", ")} still opens this wallet without the password (it is a copy of this wallet's old unlock secret). ` +
        "It is removed as soon as the wallet is unlocked with its password at startup (MONEYSWITCH_WALLET_PASSWORD)."
    );
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
  const wallet = new LocalWalletDriver(config.dataDir, {
    ...opts.walletOptions,
    // Credentials are only ever deleted from retired/, only when they merely open a copy of the live key, and every time it is written down.
    onRetiredSecretsRemoved: ({ files, trigger }) => writeAudit(db, "system", "wallet.retired_secrets_removed", { files, trigger }),
  });

  const setup = new SetupTokenStore();
  const setupBase = publicBaseUrl(config); // the same rule as every other link: MONEYSWITCH_PUBLIC_URL, else the address the server listens on
  const freshAdminToken = bootstrapAdminToken(db);
  if (freshAdminToken) {
    // Only place this ever gets printed. Never logged again, never stored
    // in plaintext. The only API that can hand it out is the one-time setup
    // claim below, which requires the setup token printed right next to it.
    // eslint-disable-next-line no-console
    console.log(`\n[moneyswitch] Admin token (save this now, it will not be shown again):\n  ${freshAdminToken}\n`);
    // One-time sign-in link: same channel as the admin token above, single use,
    // memory only, 30 min. The token sits in the URL fragment, so it never
    // reaches a server log; the login page exchanges it for the admin token.
    const setupToken = setup.issue(freshAdminToken);
    console.log(
      `[moneyswitch] First-run sign-in: open this one-time link in your browser (valid 30 min, single use):\n` +
        `  ${setupBase}/login#${setupToken}\n`
    );
  }

  await unlockWalletOnStartup(wallet, config.walletPassword);

  const chainReader = createMultiNetworkAuthorizationReader();
  // The same RPC read the wallet page uses (routes/wallet.ts readBalance wraps this very call with its own 5 s cache).
  const balanceReader = createBalanceReader((address, network, signal) =>
    network.family === "svm"
      ? wallet.getSolanaUsdcBalanceOf(address, network.rpcUrl, network.usdcAddress, signal)
      : wallet.getUsdcBalanceOf(address, network.rpcUrl, network.usdcAddress, signal)
  );

  return { db, sqlite, wallet, config, setup, chainReader, balanceReader };
}
