import type { FastifyInstance, FastifyReply } from "fastify";
import {
  confirmWalletBackup,
  formatMicrosToUsdc,
  getWalletMeta,
  hasReservedPayments,
  listRetiredWallets,
  parseUsdcToMicros,
  recordWalletOrigin,
  recordWalletRetirement,
  writeAudit,
} from "@moneyswitch/core";
import { getActiveNetwork, getEnabledNetworks, type NetworkConfig } from "@moneyswitch/x402";
import { WalletError, type WalletImport } from "@moneyswitch/wallet";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth.js";

/**
 * Wallet lifecycle (docs/wallet-setup.md, SPEC-v0.6.md "Wallet model"). Everything here is
 * administrator-only (a MoneyKey is always 403). Responses that carry a secret
 * (recovery phrase, private key, keystore) are `Cache-Control: no-store`; nothing secret is
 * ever written to the audit log or to the request log.
 */

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_FLOAT_LIMIT = "50";
const BALANCE_TTL_MS = 5_000;
const BALANCE_FAILURE_TTL_MS = 2_000;

type Body = Record<string, unknown>;

class WalletBusyError extends Error {}

export interface WalletHealth {
  unlock_mode: "auto" | "env_or_file" | "manual" | "none";
  auto_unlock_ok: boolean | null;
  backup: "confirmed" | "missing" | "not_applicable";
  float_limit: string;
  over_float_limit: Record<string, boolean>;
  retired_wallets: Array<{ address: string; retired_at: string; reason: string }>;
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

function demoBalanceMicros(ctx: AppContext): number {
  const start = ctx.config.demo?.startingBalanceMicros ?? 0;
  const spent = ctx.sqlite.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'settled'`).get() as { s: number };
  return Math.max(0, start - Number(spent.s));
}

/** Balance on every enabled chain where it can be read (null = unknown). Demo: simulated, active chain only. */
async function balancesByNetwork(ctx: AppContext, address: string | null, networks: NetworkConfig[]): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  if (!address) return out;
  if (ctx.config.demo) {
    const active = getActiveNetwork().caip2;
    for (const n of networks) out.set(n.caip2, n.caip2 === active ? BigInt(demoBalanceMicros(ctx)) : null);
    return out;
  }
  await Promise.all(networks.map(async (n) => out.set(n.caip2, await readBalance(ctx, address, n))));
  return out;
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

/** A password means manual mode; no password means auto-unlock (the default). `mode` may say it explicitly but must agree. */
function parseUnlockChoice(body: Body): { password: string | undefined } | { error: string } {
  const { mode } = body;
  if (mode !== undefined && mode !== "auto" && mode !== "manual") return { error: "mode must be auto or manual" };
  const supplied = body.password !== undefined && body.password !== null;
  if (supplied && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH)) {
    return { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (mode === "auto" && supplied) return { error: "auto-unlock mode does not take a password" };
  if (mode === "manual" && !supplied) return { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  return { password: supplied ? (body.password as string) : undefined };
}

/** Builds the driver's import source from the known fields only (nothing else in the body is passed on). */
function parseImportSource(body: Body): WalletImport | null {
  if (body.kind === "private_key") return { kind: "private_key", private_key: body.private_key as string };
  if (body.kind === "keystore") return { kind: "keystore", keystore: body.keystore as string, source_password: body.source_password as string };
  if (body.kind === "mnemonic") return { kind: "mnemonic", mnemonic: body.mnemonic as string };
  return null;
}

function parseReason(body: Body): string | null {
  if (body.reason === undefined || body.reason === null) return "replaced";
  // A short machine token, never free text: this lands in the audit log and the retirement table.
  return typeof body.reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(body.reason) ? body.reason : null;
}

export function registerWalletRoutes(app: FastifyInstance, ctx: AppContext) {
  const adminGuard = requireAdmin(ctx);

  /** Mode, last real decrypt attempt, backup state, float limit and retired wallets. */
  async function buildHealth(address: string | null, balances: Map<string, bigint | null>): Promise<WalletHealth> {
    const hasKeystore = ctx.wallet.hasKeystore();
    const envConfigured = Boolean(ctx.config.walletPassword && ctx.config.walletPassword.trim() !== "");
    const status = ctx.wallet.unlockStatus;
    let unlockMode: WalletHealth["unlock_mode"];
    if (!hasKeystore) unlockMode = "none";
    else if (status.ok && status.source) unlockMode = status.source; // what actually unlocked it
    else if (envConfigured) unlockMode = "env_or_file";
    else if (ctx.wallet.hasUnlockSecret()) unlockMode = "auto";
    else unlockMode = "manual";

    const meta = address ? getWalletMeta(ctx.db, address) : undefined;
    let backup: WalletHealth["backup"] = "not_applicable";
    if (hasKeystore && !ctx.config.demo && ctx.wallet.keystoreHasRecoveryPhrase()) {
      // Only a wallet that has a recovery phrase can be "backed up" by writing it down. One imported from a
      // bare private key has nothing to confirm: its owner already holds the key.
      backup = meta?.backupConfirmedAt ? "confirmed" : "missing";
    }

    const limit = walletFloatLimit();
    const over: Record<string, boolean> = {};
    for (const [network, balance] of balances) if (balance !== null) over[network] = balance > limit.micros;

    return {
      unlock_mode: unlockMode,
      auto_unlock_ok: unlockMode === "manual" || unlockMode === "none" ? null : status.ok,
      backup,
      float_limit: limit.text,
      over_float_limit: over,
      retired_wallets: listRetiredWallets(ctx.db).map((r) => ({ address: r.address, retired_at: r.retiredAt, reason: r.reason })),
    };
  }

  function pickNetwork(requested: string | undefined): NetworkConfig | undefined {
    return requested ? getEnabledNetworks().find((n) => n.caip2 === requested) : getActiveNetwork();
  }

  app.get("/v1/admin/wallet", { preHandler: adminGuard }, async (req, reply) => {
    const network = pickNetwork((req.query as { network?: string }).network);
    if (!network) return reply.status(400).send({ error: "UNSUPPORTED_NETWORK" });
    const address = ctx.wallet.getAddress();
    const balances = await balancesByNetwork(ctx, address, getEnabledNetworks());
    const selected = balances.get(network.caip2) ?? null;
    const health = await buildHealth(address, balances);
    return reply.send({
      address,
      unlocked: ctx.wallet.isUnlocked(),
      has_keystore: ctx.wallet.hasKeystore(),
      // An unlock credential is in place: MONEYSWITCH_WALLET_PASSWORD(_FILE), or the wallet's own wallet-unlock.secret.
      // (Independent of whether a wallet exists yet, as before.)
      auto_unlock_configured: Boolean(ctx.config.walletPassword?.trim()) || ctx.wallet.hasUnlockSecret(),
      usdc_balance: selected === null ? null : formatMicrosToUsdc(selected),
      network: network.caip2,
      simulated: Boolean(ctx.config.demo),
      has_recovery_phrase: ctx.wallet.hasKeystore() && ctx.wallet.keystoreHasRecoveryPhrase(),
      backup_confirmed_at: (address ? getWalletMeta(ctx.db, address)?.backupConfirmedAt : null) ?? null,
      health,
    });
  });

  app.post("/v1/admin/wallet/create", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const choice = parseUnlockChoice((req.body ?? {}) as Body);
    if ("error" in choice) return reply.status(400).send({ error: choice.error });
    try {
      const created = await ctx.wallet.createWithPhrase({ password: choice.password });
      recordWalletOrigin(ctx.db, created.address, "generated");
      writeAudit(ctx.db, "admin", "wallet.create", { address: created.address, unlock_mode: created.mode });
      // The phrase is returned this once and exists nowhere else except inside the encrypted keystore.
      return reply.send({ address: created.address, recovery_phrase: created.mnemonic, unlock_mode: created.mode, backup_confirmed: false });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : "wallet_error" });
    }
  });

  app.post("/v1/admin/wallet/import", { preHandler: adminGuard, bodyLimit: 200_000 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Body;
    const choice = parseUnlockChoice(body);
    if ("error" in choice) return reply.status(400).send({ error: choice.error });
    const source = parseImportSource(body);
    if (!source) return reply.status(400).send({ error: "unsupported wallet import format" });
    try {
      const imported = await ctx.wallet.importFrom(source, { password: choice.password });
      // The operator brought the credential, so there is nothing for them to write down.
      recordWalletOrigin(ctx.db, imported.address, "imported", { backupConfirmed: true });
      writeAudit(ctx.db, "admin", "wallet.import", { address: imported.address, kind: source.kind, unlock_mode: imported.mode });
      return reply.send({ address: imported.address });
    } catch {
      return reply
        .status(400)
        .send({ error: "Import failed: check the recovery phrase, private key or backup password; an existing wallet cannot be replaced (use Replace wallet)" });
    }
  });

  app.post("/v1/admin/wallet/backup", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!ctx.wallet.hasKeystore()) return reply.status(404).send({ error: "No wallet to back up" });
    const body = (req.body ?? {}) as Body;
    const address = ctx.wallet.getAddress();
    try {
      if (body.password !== undefined && body.password !== null) {
        // A portable copy protected by a password the operator picks now: the only kind of keystore
        // that is worth downloading from an auto-unlock wallet (its own wallet.json needs a secret nobody is shown).
        if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
          return reply.status(400).send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        if (!ctx.wallet.isUnlocked()) return reply.status(409).send({ error: "WALLET_LOCKED" });
        const keystore = await ctx.wallet.exportKeystoreWithPassword(body.password);
        writeAudit(ctx.db, "admin", "wallet.backup", { address, password_protected: true });
        return reply.send({ address, keystore });
      }
      if (ctx.wallet.hasUnlockSecret()) {
        return reply.status(409).send({
          error: "BACKUP_NEEDS_PASSWORD",
          message: "This wallet is encrypted with the server's auto-unlock secret, which is never exported. Send a password to get a portable backup, or write down the recovery phrase.",
        });
      }
      const keystore = ctx.wallet.exportKeystore();
      writeAudit(ctx.db, "admin", "wallet.backup", { address, password_protected: false });
      return reply.send({ address, keystore });
    } catch (e) {
      return sendWalletError(reply, e);
    }
  });

  app.post("/v1/admin/wallet/unlock", { preHandler: adminGuard }, async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== "string") return reply.status(400).send({ error: "unlock_failed" });
    try {
      const { address } = await ctx.wallet.unlock(password);
      writeAudit(ctx.db, "admin", "wallet.unlock", { address });
      return reply.send({ address, unlocked: true });
    } catch {
      return reply.status(400).send({ error: "unlock_failed" });
    }
  });

  // --- recovery phrase: confirm the backup, reveal it again -------------------

  app.post("/v1/admin/wallet/backup/confirm", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { positions, words } = (req.body ?? {}) as { positions?: unknown; words?: unknown };
    const validPositions =
      Array.isArray(positions) &&
      positions.length === 2 &&
      positions.every((p) => Number.isInteger(p) && p >= 1 && p <= 24) &&
      positions[0] !== positions[1];
    const validWords = Array.isArray(words) && words.length === 2 && words.every((w) => typeof w === "string" && w.length > 0 && w.length <= 32);
    if (!validPositions || !validWords) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: "positions must be two different numbers between 1 and 24 and words the two matching words" });
    }
    const address = ctx.wallet.getAddress();
    if (!ctx.wallet.hasKeystore() || !address) return reply.status(404).send({ error: "NO_WALLET" });
    if (!ctx.wallet.isUnlocked()) return reply.status(409).send({ error: "WALLET_LOCKED" });
    if (!ctx.wallet.keystoreHasRecoveryPhrase()) return reply.status(409).send({ error: "NO_RECOVERY_PHRASE" });
    if (!ctx.wallet.checkRecoveryWords(positions as number[], words as string[])) {
      writeAudit(ctx.db, "admin", "wallet.backup.confirm_failed", { address });
      return reply.status(400).send({ error: "WORDS_MISMATCH" });
    }
    const confirmedAt = confirmWalletBackup(ctx.db, address);
    writeAudit(ctx.db, "admin", "wallet.backup.confirm", { address });
    return reply.send({ confirmed: true, backup_confirmed_at: confirmedAt });
  });

  app.post("/v1/admin/wallet/reveal", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const address = ctx.wallet.getAddress();
    if (!ctx.wallet.hasKeystore() || !address) return reply.status(404).send({ error: "NO_WALLET" });
    const { confirm_address } = (req.body ?? {}) as { confirm_address?: unknown };
    if (typeof confirm_address !== "string" || confirm_address.trim() !== address) {
      writeAudit(ctx.db, "admin", "wallet.reveal.denied", { address, reason: "address_mismatch" });
      return reply.status(400).send({ error: "ADDRESS_MISMATCH", message: "Type the wallet address exactly as shown to reveal its recovery phrase." });
    }
    if (!ctx.wallet.isUnlocked()) return reply.status(409).send({ error: "WALLET_LOCKED" });
    const secret = ctx.wallet.reveal();
    // The audit row says THAT it was revealed, never what.
    writeAudit(ctx.db, "admin", "wallet.reveal", { address, kind: secret.kind });
    return reply.send(
      secret.kind === "mnemonic"
        ? { address, kind: "mnemonic", recovery_phrase: secret.phrase }
        : { address, kind: "private_key", private_key: secret.privateKey }
    );
  });

  // --- auto-unlock on / off ---------------------------------------------------

  app.post("/v1/admin/wallet/auto-unlock", { preHandler: adminGuard }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Body;
    if (typeof body.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be true or false" });
    if (body.enabled && body.password !== undefined) return reply.status(400).send({ error: "password is only used when turning auto-unlock off" });
    if (!body.enabled && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH)) {
      return reply.status(400).send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    try {
      const { address } = body.enabled ? await ctx.wallet.enableAutoUnlock() : await ctx.wallet.disableAutoUnlock(body.password as string);
      writeAudit(ctx.db, "admin", body.enabled ? "wallet.auto_unlock.enable" : "wallet.auto_unlock.disable", { address });
      return reply.send({ address, unlock_mode: body.enabled ? "auto" : "manual", auto_unlock_ok: body.enabled ? true : null });
    } catch (e) {
      return sendWalletError(reply, e);
    }
  });

  // --- replace ----------------------------------------------------------------

  app.post("/v1/admin/wallet/replace", { preHandler: adminGuard, bodyLimit: 200_000 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Body;
    const oldAddress = ctx.wallet.getAddress();
    if (!ctx.wallet.hasKeystore() || !oldAddress) return reply.status(404).send({ error: "NO_WALLET" });
    if (typeof body.confirm_address !== "string" || body.confirm_address.trim() !== oldAddress) {
      writeAudit(ctx.db, "admin", "wallet.replace.denied", { address: oldAddress, reason: "address_mismatch" });
      return reply.status(400).send({ error: "ADDRESS_MISMATCH", message: "Type the current wallet address exactly as shown to replace it." });
    }
    const choice = parseUnlockChoice(body);
    if ("error" in choice) return reply.status(400).send({ error: choice.error });
    const reason = parseReason(body);
    if (reason === null) return reply.status(400).send({ error: "reason must be a short token such as lost_password or suspected_leak" });
    let spec: { kind: "create" } | { kind: "import"; source: WalletImport };
    if (body.kind === undefined || body.kind === "create") spec = { kind: "create" };
    else {
      const source = parseImportSource(body);
      if (!source) return reply.status(400).send({ error: "unsupported wallet import format" });
      spec = { kind: "import", source };
    }

    try {
      const result = await ctx.wallet.replaceWallet(spec, { password: choice.password }, {
        // Runs in the same synchronous stretch as the file swap: no payment can start in between.
        guard: () => {
          if (hasReservedPayments(ctx.db)) throw new WalletBusyError();
        },
        // Same stretch, after the files moved. If this throws, the driver puts the old files back.
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
            // an imported wallet counts as backed up (the operator already holds its credential); a generated one must be confirmed
            if (spec.kind === "create") recordWalletOrigin(ctx.db, info.newAddress, "generated");
            else recordWalletOrigin(ctx.db, info.newAddress, "imported", { backupConfirmed: true });
            writeAudit(ctx.db, "admin", "wallet.replace", {
              old_address: info.address,
              new_address: info.newAddress,
              reason,
              source: spec.kind === "create" ? "create" : spec.source.kind,
              unlock_mode: choice.password === undefined ? "auto" : "manual",
              keystore_file: info.keystoreFile,
              secret_file: info.secretFile,
            });
          })();
        },
      });
      return reply.send({
        address: result.address,
        unlock_mode: result.mode,
        ...(result.mnemonic ? { recovery_phrase: result.mnemonic, backup_confirmed: false } : {}),
        retired: {
          address: result.retired.address,
          retired_at: result.retired.retiredAt,
          reason,
          keystore_file: result.retired.keystoreFile,
        },
      });
    } catch (e) {
      if (e instanceof WalletBusyError) {
        return reply.status(409).send({
          error: "WALLET_BUSY",
          message: "A payment is in flight. Wait for it to finish (a few seconds to a few minutes), then try again.",
        });
      }
      if (e instanceof WalletError && e.code === "INVALID_IMPORT") {
        return reply.status(400).send({ error: "Import failed: check the recovery phrase, private key or backup password" });
      }
      return sendWalletError(reply, e);
    }
  });

  // --- retired wallets with their live balance ----------------------------------

  app.get("/v1/admin/wallet/retired", { preHandler: adminGuard }, async (req, reply) => {
    const network = pickNetwork((req.query as { network?: string }).network);
    if (!network) return reply.status(400).send({ error: "UNSUPPORTED_NETWORK" });
    const rows = listRetiredWallets(ctx.db);
    const balances = new Map<string, bigint | null>();
    if (!ctx.config.demo) {
      await Promise.all([...new Set(rows.map((r) => r.address))].map(async (address) => balances.set(address, await readBalance(ctx, address, network))));
    }
    return reply.send({
      network: network.caip2,
      folder: "retired",
      retired_wallets: rows.map((r) => {
        const balance = balances.get(r.address) ?? null;
        return {
          address: r.address,
          retired_at: r.retiredAt,
          reason: r.reason,
          keystore_file: r.keystoreFile,
          has_secret_file: r.secretFile !== null,
          replaced_by: r.replacedBy,
          usdc_balance: balance === null ? null : formatMicrosToUsdc(balance),
        };
      }),
    });
  });
}

/** Maps a driver error to an HTTP status. The messages never contain a secret. */
function sendWalletError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof WalletError) {
    const status =
      e.code === "NO_WALLET" ? 404 : e.code === "STORAGE_FAILED" ? 500 : e.code === "INVALID_IMPORT" ? 400 : 409;
    return reply.status(status).send({ error: e.code, message: e.message });
  }
  return reply.status(500).send({ error: "WALLET_ERROR" });
}
