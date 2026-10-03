import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  confirmWalletBackup,
  formatMicrosToUsdc,
  getWalletMeta,
  listRetiredWallets,
  parseUsdcToMicros,
  recordWalletOrigin,
  recordWalletRetirement,
  writeAudit,
} from "@moneyswitch/core";
import { getActiveNetwork, getEnabledNetworks, isMainnetNetwork, type NetworkConfig } from "@moneyswitch/x402";
import { WalletError } from "@moneyswitch/wallet";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";

/**
 * Wallet surface (SPEC.md §1, §5): status, create, a backup acknowledgement and replace. Everything here is administrator-only (a
 * MoneyKey is always 403). Responses that carry the recovery phrase are `Cache-Control: no-store`; nothing secret is ever written to
 * the audit log or to the request log. There is no import, no password form, no reveal and no download: the phrase is shown once,
 * by create / replace, and a lost one means "replace the wallet".
 */

const DEFAULT_FLOAT_LIMIT = "50";
const BALANCE_TTL_MS = 5_000;
const BALANCE_FAILURE_TTL_MS = 2_000;

type Body = Record<string, unknown>;

export interface WalletHealth {
  /** How wallet.json is protected, as RECORDED in it (never guessed from which files happen to exist). "password" = a wallet made by an older version. */
  protection: "auto" | "password" | "none";
  unlock_mode: "auto" | "env_or_file" | "manual" | "none";
  auto_unlock_ok: boolean | null;
  /** The last startup unlock attempt per source, with the reason it failed: nothing is blamed on the wrong source. */
  unlock_sources: Array<{ source: "env_or_file" | "auto"; ok: boolean; reason?: string }>;
  /** Auto wallets only: does the unlock secret file exist right now? (false = the next restart will leave the wallet locked.) */
  secret_file_present: boolean | null;
  /**
   * Legacy password wallets: retired/ unlock secrets that still open a retired copy of the live key, i.e. a way in WITHOUT the password
   * (they are removed once the startup password has proved the wallet reachable; this lists what could not be removed yet). Empty = none.
   */
  retired_secrets_open_live_key: string[];
  /** false = the data directory / unlock secret could not be restricted to this user (red warning); null = nothing to protect. */
  secret_protected: boolean | null;
  secret_protection_detail: string | null;
  /** Credential files that belong to no live wallet.json; wallet_file_missing = wallet.json is gone but these remain. */
  orphan_files: { secrets: string[]; retired: number; wallet_file_missing: boolean };
  backup: "confirmed" | "missing" | "not_applicable";
  float_limit: string;
  over_float_limit: Record<string, boolean>;
}

/** The same address on one chain: its balance and whether it is above the float limit. */
export interface WalletNetworkView {
  network: string;
  label: string;
  explorer_base: string;
  is_mainnet: boolean;
  /** USDC, null = unknown (the RPC did not answer). */
  usdc_balance: string | null;
  over_float_limit: boolean | null;
}

export interface RetiredWalletView {
  address: string;
  retired_at: string;
  reason: string;
  keystore_file: string;
  has_secret_file: boolean;
  replaced_by: string | null;
  /** USDC per enabled chain (CAIP-2), null = unknown. */
  balances: Record<string, string | null>;
}

/** The configured float limit in USDC (MONEYSWITCH_WALLET_FLOAT_LIMIT, default 50); an unusable value falls back to the default. */
export function walletFloatLimit(env: NodeJS.ProcessEnv = process.env): { text: string; micros: bigint } {
  for (const candidate of [env.MONEYSWITCH_WALLET_FLOAT_LIMIT, DEFAULT_FLOAT_LIMIT]) {
    if (candidate === undefined) continue;
    try {
      const micros = parseUsdcToMicros(candidate);
      if (micros > 0n) return { text: formatMicrosToUsdc(micros), micros };
    } catch {
      /* try the default */
    }
  }
  throw new Error("unreachable: the default float limit is valid");
}

// ---------------------------------------------------------------------------
// balances: shared by the dashboard polls (several tabs poll every few seconds)
// ---------------------------------------------------------------------------

interface CachedBalance {
  at: number;
  ttl: number;
  value: bigint | null;
  pending?: Promise<bigint | null>;
}
const balanceCaches = new WeakMap<AppContext, Map<string, CachedBalance>>();

async function readBalance(ctx: AppContext, address: string, network: NetworkConfig): Promise<bigint | null> {
  let cache = balanceCaches.get(ctx);
  if (!cache) balanceCaches.set(ctx, (cache = new Map()));
  const key = `${network.caip2}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const pending = ctx.wallet
    .getUsdcBalanceOf(address, network.rpcUrl, network.usdcAddress)
    .then((value): bigint | null => value)
    .catch((): bigint | null => null);
  cache.set(key, { at: Date.now(), ttl: BALANCE_FAILURE_TTL_MS, value: hit?.value ?? null, pending });
  const value = await pending;
  cache.set(key, { at: Date.now(), ttl: value === null ? BALANCE_FAILURE_TTL_MS : BALANCE_TTL_MS, value });
  return value;
}

/** Balance on every enabled chain where it can be read (null = unknown). */
async function balancesByNetwork(ctx: AppContext, address: string | null, networks: NetworkConfig[]): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  if (!address) return out;
  await Promise.all(networks.map(async (n) => out.set(n.caip2, await readBalance(ctx, address, n))));
  return out;
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

/** Wallets are created with auto-unlock only. A request that still asks for a password or an import is refused, never quietly turned into something else. */
function refuseRemovedOptions(body: Body): string | null {
  if (body.password !== undefined && body.password !== null) return "password wallets can no longer be created: the wallet unlocks itself after a restart";
  if (body.mode !== undefined && body.mode !== "auto") return "only the auto-unlock mode exists";
  if (body.kind !== undefined && body.kind !== "create") return "importing a wallet is not supported: replace it with a new one";
  return null;
}

function parseReason(body: Body): string | null {
  if (body.reason === undefined || body.reason === null) return "replaced";
  // A short machine token, never free text: this lands in the audit log and the retirement table.
  return typeof body.reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(body.reason) ? body.reason : null;
}

export function registerWalletRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  /** Recorded protection mode, last real decrypt attempt per source, secret protection, backup state and float limit. */
  function buildHealth(address: string | null, balances: Map<string, bigint | null>): WalletHealth {
    const hasKeystore = ctx.wallet.hasKeystore();
    const envConfigured = Boolean(ctx.config.walletPassword && ctx.config.walletPassword.trim() !== "");
    const status = ctx.wallet.unlockStatus;
    // The mode comes from what wallet.json SAYS about itself. A wallet.json that cannot be read at all is treated as a
    // password keystore (what every keystore without the marker is): the safe assumption, nothing is claimed to be automatic.
    const protection: WalletHealth["protection"] = hasKeystore ? ctx.wallet.protection() ?? "password" : "none";
    let unlockMode: WalletHealth["unlock_mode"];
    if (protection === "none") unlockMode = "none";
    else if (status.ok && status.source === "env_or_file") unlockMode = "env_or_file"; // what actually unlocked it
    else if (protection === "auto") unlockMode = "auto";
    else if (envConfigured) unlockMode = "env_or_file";
    else unlockMode = "manual";

    const orphans = ctx.wallet.orphanFiles();
    const secretProtection = ctx.wallet.secretProtection;

    const meta = address ? getWalletMeta(ctx.db, address) : undefined;
    let backup: WalletHealth["backup"] = "not_applicable";
    if (hasKeystore && ctx.wallet.keystoreHasRecoveryPhrase()) {
      // Only a wallet that has a recovery phrase can be "backed up" by writing it down.
      backup = meta?.backupConfirmedAt ? "confirmed" : "missing";
    }

    const limit = walletFloatLimit();
    const over: Record<string, boolean> = {};
    for (const [network, balance] of balances) if (balance !== null) over[network] = balance > limit.micros;

    return {
      protection,
      unlock_mode: unlockMode,
      auto_unlock_ok: unlockMode === "manual" || unlockMode === "none" ? null : status.ok,
      unlock_sources: status.attempts.map((a) => ({ source: a.source, ok: a.ok, ...(a.reason ? { reason: a.reason } : {}) })),
      secret_file_present: protection === "auto" ? ctx.wallet.hasUnlockSecret() : null,
      retired_secrets_open_live_key: ctx.wallet.retiredSecretsOpeningLiveKey,
      secret_protected: secretProtection ? secretProtection.ok : null,
      secret_protection_detail: secretProtection && !secretProtection.ok ? secretProtection.detail ?? "the protection could not be verified" : null,
      orphan_files: {
        secrets: orphans.secrets,
        retired: orphans.retired,
        wallet_file_missing: !hasKeystore && (orphans.secrets.length > 0 || orphans.retired > 0),
      },
      backup,
      float_limit: limit.text,
      over_float_limit: over,
    };
  }

  // --- status -------------------------------------------------------------------

  app.get("/v1/admin/wallet", { preHandler: adminGuard }, async (_req, reply) => {
    const networks = getEnabledNetworks();
    const active = getActiveNetwork();
    const address = ctx.wallet.getAddress();
    const balances = await balancesByNetwork(ctx, address, networks);
    const health = buildHealth(address, balances);
    const limit = walletFloatLimit();

    const retiredRows = listRetiredWallets(ctx.db);
    const retiredBalances = new Map<string, Map<string, bigint | null>>();
    await Promise.all(
      [...new Set(retiredRows.map((r) => r.address))].map(async (a) => retiredBalances.set(a, await balancesByNetwork(ctx, a, networks)))
    );

    const selected = balances.get(active.caip2) ?? null;
    return reply.send({
      address,
      unlocked: ctx.wallet.isUnlocked(),
      has_keystore: ctx.wallet.hasKeystore(),
      has_recovery_phrase: ctx.wallet.hasKeystore() && ctx.wallet.keystoreHasRecoveryPhrase(),
      backup_confirmed_at: (address ? getWalletMeta(ctx.db, address)?.backupConfirmedAt : null) ?? null,
      // The default chain, for the one-line balance in the page header.
      network: active.caip2,
      usdc_balance: selected === null ? null : formatMicrosToUsdc(selected),
      networks: networks.map(
        (n): WalletNetworkView => {
          const balance = balances.get(n.caip2) ?? null;
          return {
            network: n.caip2,
            label: n.label,
            explorer_base: n.explorerBase,
            is_mainnet: isMainnetNetwork(n),
            usdc_balance: balance === null ? null : formatMicrosToUsdc(balance),
            over_float_limit: balance === null ? null : balance > limit.micros,
          };
        }
      ),
      retired_wallets: retiredRows.map(
        (r): RetiredWalletView => ({
          address: r.address,
          retired_at: r.retiredAt,
          reason: r.reason,
          keystore_file: r.keystoreFile,
          // (a file that was deleted because it only opened a copy of the live key no longer counts)
          has_secret_file: r.secretFile !== null && fs.existsSync(path.join(ctx.wallet.retiredDir, r.secretFile)),
          replaced_by: r.replacedBy,
          balances: Object.fromEntries(
            networks.map((n) => {
              const balance = retiredBalances.get(r.address)?.get(n.caip2) ?? null;
              return [n.caip2, balance === null ? null : formatMicrosToUsdc(balance)];
            })
          ),
        })
      ),
      health,
    });
  });

  // --- create -------------------------------------------------------------------

  app.post("/v1/admin/wallet/create", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const refused = refuseRemovedOptions((req.body ?? {}) as Body);
    if (refused) return reply.status(400).send({ error: "UNSUPPORTED", message: refused });
    try {
      const created = await ctx.wallet.createWithPhrase();
      recordWalletOrigin(ctx.db, created.address, "generated");
      writeAudit(ctx.db, "admin", "wallet.create", { address: created.address });
      // The phrase is returned this once and exists nowhere else except inside the encrypted keystore.
      return reply.send({ address: created.address, recovery_phrase: created.mnemonic, backup_confirmed: false });
    } catch (e) {
      return sendWalletError(reply, e);
    }
  });

  // --- "I wrote the words down" ---------------------------------------------------

  // The acknowledgement names the wallet whose words were written down. A replace can land between the moment the words are shown and
  // the click (another tab, another administrator): without the address that click would mark the NEW wallet, whose words nobody has
  // seen, as backed up.
  app.post("/v1/admin/wallet/backup/confirm", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const address = ctx.wallet.getAddress();
    if (!ctx.wallet.hasKeystore() || !address) return reply.status(404).send({ error: "NO_WALLET" });
    const named = ((req.body ?? {}) as Body).address;
    if (typeof named !== "string" || named.trim() === "") {
      return reply.status(400).send({ error: "ADDRESS_REQUIRED", message: "Say which wallet's words were written down: send its address." });
    }
    if (named.trim().toLowerCase() !== address.toLowerCase()) {
      return reply.status(409).send({
        error: "WALLET_CHANGED",
        message: "The wallet was replaced after these words were shown: they belong to another wallet, so nothing was confirmed.",
      });
    }
    if (!ctx.wallet.keystoreHasRecoveryPhrase()) return reply.status(409).send({ error: "NO_RECOVERY_PHRASE" });
    const confirmedAt = confirmWalletBackup(ctx.db, address);
    writeAudit(ctx.db, "admin", "wallet.backup.confirm", { address });
    return reply.send({ confirmed: true, backup_confirmed_at: confirmedAt });
  });

  // --- replace ------------------------------------------------------------------

  app.post("/v1/admin/wallet/replace", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Body;
    const oldAddress = ctx.wallet.getAddress();
    if (!ctx.wallet.hasKeystore() || !oldAddress) return reply.status(404).send({ error: "NO_WALLET" });
    if (typeof body.confirm_address !== "string" || body.confirm_address.trim() !== oldAddress) {
      writeAudit(ctx.db, "admin", "wallet.replace.denied", { address: oldAddress, reason: "address_mismatch" });
      return reply.status(400).send({ error: "ADDRESS_MISMATCH", message: "Type the current wallet address exactly as shown to replace it." });
    }
    const refused = refuseRemovedOptions(body);
    if (refused) return reply.status(400).send({ error: "UNSUPPORTED", message: refused });
    const reason = parseReason(body);
    if (reason === null) return reply.status(400).send({ error: "reason must be a short token such as lost_password or suspected_leak" });

    try {
      // WALLET_BUSY comes from the driver: it refuses while any request holds a signer lease (an in-process counter, not
      // database rows) after waiting for them, and again in the synchronous stretch that swaps the files.
      const result = await ctx.wallet.replaceWallet({
        // Runs in the same synchronous stretch as the file swap, after the files moved. If this throws, the driver puts the old files back.
        onSwapped: (info) => {
          ctx.sqlite.transaction(() => {
            recordWalletRetirement(ctx.db, {
              address: info.address,
              retiredAt: info.retiredAt,
              reason,
              keystoreFile: info.keystoreFile,
              secretFile: info.secretFile,
              replacedBy: info.newAddress,
            });
            // a generated wallet must be confirmed (written down) before it counts as backed up
            recordWalletOrigin(ctx.db, info.newAddress, "generated");
            writeAudit(ctx.db, "admin", "wallet.replace", {
              old_address: info.address,
              new_address: info.newAddress,
              reason,
              keystore_file: info.keystoreFile,
              secret_file: info.secretFile,
            });
          })();
        },
      });
      return reply.send({
        address: result.address,
        recovery_phrase: result.mnemonic,
        backup_confirmed: false,
        retired: {
          address: result.retired.address,
          retired_at: result.retired.retiredAt,
          reason,
          keystore_file: result.retired.keystoreFile,
        },
      });
    } catch (e) {
      return sendWalletError(reply, e);
    }
  });
}

/** Maps a driver error to an HTTP status. The messages never contain a secret. */
function sendWalletError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof WalletError) {
    const status = e.code === "NO_WALLET" ? 404 : e.code === "STORAGE_FAILED" ? 500 : 409; // WALLET_BUSY, WALLET_EXISTS, WALLET_CHANGED
    return reply.status(status).send({ error: e.code, message: e.message });
  }
  return reply.status(500).send({ error: "WALLET_ERROR" });
}
