import { Wallet, HDNodeWallet, Interface, getAddress, encryptKeystoreJson, type KeystoreAccount } from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProtector, type Protector, type SecretProtection } from "./protect.js";

export { evaluateAcl, parseAclOutput, type Protector, type ProtectTargets, type SecretProtection } from "./protect.js";

/**
 * How the keystore on disk is protected, RECORDED in wallet.json (non-secret `x-moneyswitch` field) so health
 * never has to guess it from which files happen to exist. A keystore without the field predates this release and
 * is a password keystore.
 *  - "auto":     encrypted with a random 256-bit secret kept in wallet-unlock-<address>.secret. Every wallet created now is like this.
 *  - "password": encrypted with a password a human (or MONEYSWITCH_WALLET_PASSWORD) supplies. Only wallets made by older versions are
 *                like this: they are unlocked at startup, but never created and never switched to any more.
 */
export type Protection = "auto" | "password";

/** Where an unlock credential came from at startup. */
export type UnlockSource = "env_or_file" | "auto";

/** Why one unlock source did not open the wallet. */
export type UnlockFailure = "env_wrong" | "secret_missing" | "secret_empty" | "secret_unreadable" | "secret_wrong";

export interface UnlockAttempt {
  source: UnlockSource;
  ok: boolean;
  /** Present when ok is false. Never contains the credential. */
  reason?: UnlockFailure;
}

export interface StartupUnlock {
  unlocked: boolean;
  /** In the order tried. Empty when there was nothing to try (no wallet, or no credential configured). */
  attempts: UnlockAttempt[];
  /**
   * The wallet's own unlock secret was missing, and a copy that an earlier start had moved to retired/ (while wallet.json
   * belonged to another key) opens the keystore: it was moved back. The value is its name inside retired/.
   */
  restoredSecret?: string;
  /** The unlock secret is missing and these files in retired/ carry this wallet's address in their name but do NOT open it. */
  retiredSecretFiles?: string[];
}

export interface UnlockStatus {
  /** The source that opened the wallet, else the first one tried, else null. */
  source: UnlockSource | null;
  /** true = opened, false = something was tried and failed, null = nothing was tried. */
  ok: boolean | null;
  attempts: UnlockAttempt[];
}

export interface CreatedWallet {
  address: string;
  /** The 12-word recovery phrase. Returned exactly once, never stored outside the encrypted keystore. */
  mnemonic: string;
}

export interface RetiredFiles {
  /** Checksummed address of the wallet that was retired. */
  address: string;
  retiredAt: string;
  /** File names inside <dataDir>/retired/. */
  keystoreFile: string;
  secretFile: string | null;
}

export interface ReplaceHooks {
  /** Runs synchronously before any file is touched; throw to abort. */
  guard?: (info: { oldAddress: string; newAddress: string }) => void;
  /** Runs synchronously once the files are swapped; throw to roll the swap back (record the retirement here). */
  onSwapped?: (info: RetiredFiles & { newAddress: string }) => void;
}

export interface ReplaceResult {
  address: string;
  /** The new wallet's 12-word recovery phrase. Returned once. */
  mnemonic: string;
  retired: RetiredFiles;
}

export type WalletErrorCode = "WALLET_EXISTS" | "NO_WALLET" | "WALLET_BUSY" | "WALLET_CHANGED" | "STORAGE_FAILED";

/** Errors the HTTP layer can map to a status code. Messages never contain a secret. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export interface ScryptParams {
  N: number;
  r?: number;
  p?: number;
}

export interface LocalWalletDriverOptions {
  /**
   * Overrides the scrypt cost of every keystore this driver writes. Leave unset in production: the random 256-bit
   * auto-unlock secret needs no stretching and uses N=2^14 so a restart unlocks quickly. Tests lower it to keep the
   * suite fast.
   */
  scrypt?: ScryptParams;
  /**
   * What protects the data directory and the secret (see protect.ts). Default: the real thing for this OS.
   * `false` switches it off (tests that do not exercise it); a function replaces it (tests of the failure path).
   */
  protect?: false | Protector;
  /** Test seam: the PowerShell executable used on Windows. */
  powershellPath?: string;
  /**
   * How long replaceWallet waits for the requests in flight to finish before it gives up with WALLET_BUSY (default 60 s). While it
   * waits, no new lease is handed out, so steady traffic cannot keep it waiting for ever.
   */
  drainTimeoutMs?: number;
  /**
   * Called when credentials were DELETED from retired/ because they only opened a copy of the live key (see
   * retiredSecretsOpeningLiveKey), so the server can write an audit row. File names only, never contents.
   */
  onRetiredSecretsRemoved?: (event: { files: string[]; trigger: RetiredScrubTrigger }) => void;
}

/** What made the driver look through retired/ for secrets that open the live key: the startup password proving a legacy password wallet reachable. */
export type RetiredScrubTrigger = "startup_password";

/** A signer plus the lease that keeps the wallet from being replaced or locked while a request is using it. */
export interface SignerLease {
  readonly signer: EvmTypedDataSigner;
  /** Idempotent. Call it in a `finally` when the request that took the lease is over. */
  release(): void;
}

/** Default data directory: $MONEYSWITCH_DATA_DIR or ~/.moneyswitch (or /data inside docker, set via env). */
export function defaultDataDir(): string {
  return process.env.MONEYSWITCH_DATA_DIR || path.join(os.homedir(), ".moneyswitch");
}

export function walletFilePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "wallet.json");
}

/**
 * The auto-unlock secret of ONE wallet: the file name carries the address, so a secret can never be mistaken for
 * (or overwrite) the credential of another key, and every crash point leaves a matching wallet.json + secret pair.
 * Mode 0600 / a protected ACL, never returned by an API, never logged.
 */
export function unlockSecretPath(dataDir: string, address: string): string {
  return path.join(dataDir, `wallet-unlock-${address.toLowerCase()}.secret`);
}

/** Replaced wallets and stray credentials are moved here, never deleted. */
export function retiredDirPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "retired");
}

/** The standard Ethereum derivation path (account 0): MetaMask, OKX, Ledger and friends show the same address. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

const AUTO_SCRYPT: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };
/** Upper bound on the decrypt attempts of one look through retired/ for secrets that open the live key. */
const MAX_RETIRED_SCAN_ATTEMPTS = 100;
const MARKER_KEY = "x-moneyswitch";
const SECRET_NAME = /^wallet-unlock-(0x[0-9a-f]{40})\.secret$/;
const TEMP_NAME = /^\.wallet(-unlock)?-[0-9a-f-]{36}\.tmp$/;

const ERC20_ABI = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/**
 * Minimal shape compatible with @x402/evm's `ClientEvmSigner`:
 * `{ address, signTypedData(msg) }`. Kept dependency-free here (no @x402
 * import) so packages/wallet stays a pure signing primitive; packages/x402
 * adapts it to the SDK's exact type.
 */
export interface EvmTypedDataSigner {
  readonly address: `0x${string}`;
  signTypedData(msg: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type AnyWallet = Wallet | HDNodeWallet;

/** One operation at a time per data directory: a create, the unlock at startup and a replace must never interleave. */
const queueTails = new Map<string, Promise<void>>();
async function exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  queueTails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}

/** Collects the inverse of every completed step so a failure part-way restores the previous state. */
class Undo {
  private steps: Array<() => void> = [];
  add(step: () => void): void {
    this.steps.push(step);
  }
  rollback(): void {
    for (const step of this.steps.reverse()) {
      try {
        step();
      } catch {
        /* best effort: every credential involved is still on disk under some name (live or retired/) */
      }
    }
    this.steps = [];
  }
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** On Windows an indexer, a scanner or a backup agent can hold a file for a moment: renames and deletes then fail with EPERM / EBUSY / EACCES. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
function withRetry<T>(op: () => T): T {
  const attempts = process.platform === "win32" ? 6 : 1;
  for (let i = 1; ; i++) {
    try {
      return op();
    } catch (e) {
      if (i >= attempts || !TRANSIENT.has(errorCode(e) ?? "")) throw e;
      sleepSync(25 * i);
    }
  }
}
/** Rename that replaces an existing destination atomically (never delete-then-rename). */
function renameOver(from: string, to: string): void {
  withRetry(() => fs.renameSync(from, to));
}
function removeFile(file: string): void {
  withRetry(() => fs.unlinkSync(file));
}
function removeQuietly(file: string): void {
  try {
    removeFile(file);
  } catch {
    /* already gone */
  }
}

/** Moves a file; across file systems (EXDEV) it is copied and the original removed only after the copy exists. */
function moveFileSync(from: string, to: string): void {
  try {
    renameOver(from, to);
  } catch (e) {
    if (errorCode(e) !== "EXDEV") throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    removeFile(from);
  }
}

/** Flushes a file to disk so a crash right after a rename cannot leave an empty file behind. */
function syncFile(file: string): void {
  try {
    const fd = fs.openSync(file, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* not supported everywhere (some network file systems); the rename is still atomic */
  }
}

/** Writes a complete new file next to its destination (same file system, so a rename is atomic). */
function writeTemp(dir: string, prefix: string, data: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${prefix}-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
  syncFile(temp);
  return temp;
}

/** Atomically replaces `dest` with `data` (temp + rename-over); falls back to a direct write if the rename keeps failing (restore paths only). */
function replaceFile(dest: string, data: string, prefix: string): void {
  const temp = writeTemp(path.dirname(dest), prefix, data);
  try {
    renameOver(temp, dest);
  } catch {
    try {
      fs.writeFileSync(dest, data, { mode: 0o600 });
    } finally {
      removeQuietly(temp);
    }
  }
}

/** Wraps an error thrown by a caller-supplied hook so it is rethrown unchanged after the rollback. */
class HookFailure {
  constructor(readonly cause: unknown) {}
}

/** 20261003T041233123Z: file-name safe, sorts chronologically. */
function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function uniqueName(dir: string, base: string, ext: string): string {
  let name = `${base}${ext}`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  return name;
}

function accountOf(wallet: AnyWallet): KeystoreAccount {
  const account: KeystoreAccount = { address: wallet.address, privateKey: wallet.privateKey };
  // Only a wallet GENERATED here keeps its phrase, inside the encrypted keystore (same rule ethers' own encrypt() applies).
  if (wallet instanceof HDNodeWallet && wallet.mnemonic && wallet.path && wallet.mnemonic.wordlist.locale === "en" && wallet.mnemonic.password === "") {
    account.mnemonic = { path: wallet.path, locale: "en", entropy: wallet.mnemonic.entropy };
  }
  return account;
}

function phraseOf(wallet: AnyWallet): string | null {
  return wallet instanceof HDNodeWallet ? wallet.mnemonic?.phrase ?? null : null;
}

/** Adds the non-secret protection marker to a keystore JSON string. */
function withMarker(json: string, protection: Protection): string {
  const data = JSON.parse(json);
  data[MARKER_KEY] = { version: 1, protection };
  return JSON.stringify(data);
}

async function decryptWith(json: string, credential: string): Promise<AnyWallet | null> {
  try {
    return await Wallet.fromEncryptedJson(json, credential);
  } catch {
    return null;
  }
}

interface LiveKeystore {
  json: string;
  address: string;
  protection: Protection;
  hasPhrase: boolean;
}

interface Staged {
  wallet: AnyWallet;
  /** The complete, already-verified keystore JSON (marker included). */
  keystoreJson: string;
  /** The random auto-unlock secret. */
  secret: string;
}

/**
 * LocalWalletDriver: manages a single ethers v6 encrypted keystore file.
 * The decrypted in-memory `Wallet` (and therefore the private key and recovery phrase) only ever lives inside
 * this class's private field, never leaves the process (the recovery phrase is returned once, by creation and replacement), and is never logged.
 */
export class LocalWalletDriver {
  private unlockedWallet: AnyWallet | null = null;
  /** Bumped whenever the wallet that signs changes (replace, lock, a different wallet unlocked): signers from an older epoch refuse to sign. */
  private epoch = 0;
  /** Requests that currently hold a signer (leaseSigner) and must not lose their wallet under them. */
  private leases = 0;
  private readonly dataDir: string;
  private readonly options: LocalWalletDriverOptions;
  private readonly protector: Protector | null;
  private unlockState: { unlockedBy: UnlockSource | null; attempts: UnlockAttempt[] } = { unlockedBy: null, attempts: [] };
  private protectionState: SecretProtection | null = null;
  /** retired/ secret files that opened a retired copy of the live (password-mode) key at the last look: they are a way in without the password. */
  private retiredOpeners: string[] = [];
  /** A replace is waiting for the requests in flight to finish: no new lease is handed out until it is over. */
  private draining = false;
  /** Wake-ups for a replace that waits for the last lease to be released. */
  private idleWaiters: Array<() => void> = [];
  /** How long replaceWallet waits for open leases (ms). Adjustable at run time (operations, tests). */
  drainTimeoutMs: number;

  constructor(dataDir = defaultDataDir(), options: LocalWalletDriverOptions = {}) {
    this.dataDir = dataDir;
    this.options = options;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 60_000;
    this.protector = options.protect === false ? null : options.protect ?? defaultProtector({ powershellPath: options.powershellPath });
  }

  // -------------------------------------------------------------------------
  // paths and state
  // -------------------------------------------------------------------------

  get keystorePath(): string {
    return walletFilePath(this.dataDir);
  }

  get retiredDir(): string {
    return retiredDirPath(this.dataDir);
  }

  /** Path of the unlock secret that belongs to `address`. */
  secretPathFor(address: string): string {
    return unlockSecretPath(this.dataDir, address);
  }

  /** Path of the live wallet's unlock secret (it may not exist), or null without a readable wallet.json. */
  get secretPath(): string | null {
    const live = this.readLive();
    return live ? this.secretPathFor(live.address) : null;
  }

  hasKeystore(): boolean {
    return fs.existsSync(this.keystorePath);
  }

  /** True when the live wallet's unlock secret file exists. */
  hasUnlockSecret(): boolean {
    const live = this.readLive();
    return live ? fs.existsSync(this.secretPathFor(live.address)) : false;
  }

  /** How wallet.json is protected, as recorded in it ("password" for a keystore from before the marker existed); null without a wallet. */
  protection(): Protection | null {
    return this.readLive()?.protection ?? null;
  }

  isUnlocked(): boolean {
    return this.unlockedWallet !== null;
  }

  /** Requests currently holding a signer lease. */
  get inFlight(): number {
    return this.leases;
  }

  /**
   * What the last real decrypt attempts were, per source and with the reason each one failed. `ok` is null when
   * nothing was tried (password wallet with no startup password, no wallet, or the driver was never asked to
   * unlock itself).
   */
  get unlockStatus(): UnlockStatus {
    const { unlockedBy, attempts } = this.unlockState;
    return {
      source: unlockedBy ?? attempts[0]?.source ?? null,
      ok: unlockedBy ? true : attempts.length ? false : null,
      attempts: attempts.map((a) => ({ ...a })),
    };
  }

  /**
   * Password-mode wallets: names (inside retired/) of unlock secrets that still open a retired copy of the live key, i.e. let anyone
   * who can read the folder in without the password. They are removed whenever the password has just proved the live keystore
   * reachable; this lists what could not be (or has not been, because the wallet is still locked). Empty for an auto-unlock wallet.
   */
  get retiredSecretsOpeningLiveKey(): string[] {
    return [...this.retiredOpeners];
  }

  /** Result of the last check of the data directory + secret protection (ACL / modes); null = not applicable or not checked. */
  get secretProtection(): SecretProtection | null {
    return this.protectionState ? { ...this.protectionState } : null;
  }

  /** Whether the stored keystore carries a recovery phrase. Readable while locked (the flag is plain metadata). */
  keystoreHasRecoveryPhrase(): boolean {
    return this.readLive()?.hasPhrase ?? false;
  }

  /**
   * Credentials lying around without a wallet to go with them: secret files of OTHER keys (every secret when
   * there is no wallet.json at all) and files in retired/. The server reports this instead of silently offering to
   * create a fresh wallet when wallet.json has gone missing.
   */
  orphanFiles(): { secrets: string[]; retired: number } {
    const live = this.readLive()?.address.toLowerCase();
    const secrets: string[] = [];
    try {
      for (const name of fs.readdirSync(this.dataDir)) {
        const m = SECRET_NAME.exec(name);
        if (m && m[1] !== live) secrets.push(getAddress(m[1]));
      }
    } catch {
      /* no data directory yet */
    }
    let retired = 0;
    try {
      retired = fs.readdirSync(this.retiredDir).length;
    } catch {
      /* none */
    }
    return { secrets, retired };
  }

  // -------------------------------------------------------------------------
  // creation
  // -------------------------------------------------------------------------

  /**
   * Creates a wallet from a fresh BIP-39 12-word phrase on m/44'/60'/0'/0/0. The keystore is encrypted with a random secret
   * that is stored next to it (auto-unlock: the server unlocks itself after a restart). The returned phrase is the only copy
   * outside the encrypted keystore.
   */
  async createWithPhrase(): Promise<CreatedWallet> {
    return exclusive(this.dataDir, async () => {
      if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
      const wallet = Wallet.createRandom();
      const staged = await this.stage(wallet);
      await this.protectDirectory(); // the folder is locked down BEFORE the secret is written into it
      this.publishNew(staged);
      this.adopt(staged);
      await this.refreshProtection();
      return { address: wallet.address, mnemonic: wallet.mnemonic!.phrase };
    });
  }

  // -------------------------------------------------------------------------
  // unlocking
  // -------------------------------------------------------------------------

  /**
   * Startup unlock, in this order: the configured password (MONEYSWITCH_WALLET_PASSWORD or _FILE; empty means "not
   * configured"), then the wallet's own unlock secret, else stay locked. Every source that was tried is reported
   * with the reason it failed (never the credential), and a failing source does not stop the next one: a stale
   * password in the environment cannot lock out a wallet whose secret works. Also tidies up after a crash: stale
   * temp files are removed and credentials that belong to no live keystore are moved to retired/ (never deleted).
   */
  async unlockOnStartup(opts: { password?: string | null } = {}): Promise<StartupUnlock> {
    return exclusive(this.dataDir, async () => {
      const live = this.readLive();
      await this.sweepLayout(live);
      if (!live) {
        this.unlockState = { unlockedBy: null, attempts: [] };
        return { unlocked: false, attempts: [] };
      }
      if (this.unlockedWallet) return { unlocked: true, attempts: [] };

      const attempts: UnlockAttempt[] = [];
      let restoredSecret: string | undefined;
      let retiredSecretFiles: string[] | undefined;
      const finish = async (wallet: AnyWallet | null, by: UnlockSource | null): Promise<StartupUnlock> => {
        if (wallet) this.adoptUnlocked(wallet);
        this.unlockState = { unlockedBy: wallet ? by : null, attempts };
        await this.refreshProtection();
        return {
          unlocked: wallet !== null,
          attempts: attempts.map((a) => ({ ...a })),
          ...(restoredSecret ? { restoredSecret } : {}),
          ...(retiredSecretFiles?.length ? { retiredSecretFiles } : {}),
        };
      };

      const configured = typeof opts.password === "string" && opts.password.trim() !== "" ? opts.password : null;
      if (configured !== null) {
        const wallet = await decryptWith(live.json, configured);
        if (wallet && this.stillLive(wallet)) {
          attempts.push({ source: "env_or_file", ok: true });
          await this.scrubRetiredOpeners(live.json, "startup_password").catch(() => undefined); // the password just proved the live keystore reachable
          return finish(wallet, "env_or_file");
        }
        attempts.push({ source: "env_or_file", ok: false, reason: "env_wrong" });
      }

      const secretFile = this.secretPathFor(live.address);
      if (live.protection === "auto" && !fs.existsSync(secretFile)) {
        // An earlier start may have moved this wallet's secret to retired/ because wallet.json belonged to another key at the time.
        // Now that the right wallet.json is back, put it back (never leave the operator with "restore it from a backup").
        const found = await this.restoreOrphanedSecret(live);
        restoredSecret = found.restored ?? undefined;
        retiredSecretFiles = found.candidates;
      }
      if (live.protection === "auto" || fs.existsSync(secretFile)) {
        const secret = this.readSecret(secretFile);
        if (secret.ok) {
          const wallet = await decryptWith(live.json, secret.secret);
          if (wallet && this.stillLive(wallet)) {
            attempts.push({ source: "auto", ok: true });
            return finish(wallet, "auto");
          }
          attempts.push({ source: "auto", ok: false, reason: "secret_wrong" });
        } else {
          attempts.push({ source: "auto", ok: false, reason: secret.reason });
        }
      }
      // Still locked. A password wallet is not cleaned up without its password (a retired pair may be the only way in), but it is
      // flagged when one of them opens it.
      this.retiredOpeners = live.protection === "password" ? await this.findRetiredOpeners(live).catch(() => []) : [];
      return finish(null, null);
    });
  }

  getAddress(): string | null {
    if (this.unlockedWallet) return this.unlockedWallet.address;
    return this.readLive()?.address ?? null;
  }

  /**
   * THE way to get a signer: a signer for the wallet that is unlocked right now, plus an in-flight lease. Replace and
   * lock refuse with WALLET_BUSY while any lease is open. Take it before the first byte of a payment request goes out
   * and release it in a `finally` when the request is over.
   *
   * There is deliberately no lease-free variant (an earlier getSigner() was one): a route that took a signer without a
   * lease would silently opt out of the WALLET_BUSY protection. The signer also checks at signTypedData time that its
   * wallet is still the one in use, and throws WALLET_CHANGED before signing if it was replaced or locked since.
   */
  leaseSigner(): SignerLease | null {
    const wallet = this.unlockedWallet;
    if (!wallet) return null;
    // A replace is waiting for the requests in flight to finish: no NEW one may start, or steady traffic would keep it waiting
    // for ever. Nothing has been signed for the refused request; it can simply try again once the replacement is over.
    if (this.draining) throw new WalletError("WALLET_BUSY", "The wallet is being replaced; no new payment can start until that is done (nothing was signed)");
    this.leases++;
    let released = false;
    return {
      signer: this.makeSigner(wallet, this.epoch),
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        if (this.leases === 0) this.wakeIdleWaiters();
      },
    };
  }

  private wakeIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Starts draining (new leases are refused) and waits until every open lease has been released, at most drainTimeoutMs. The
   * caller clears the flag in a `finally`. Gives up with WALLET_BUSY when requests are still in flight after the bound.
   */
  private async waitForIdle(): Promise<void> {
    this.draining = true;
    if (this.leases === 0) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== wake);
        reject(
          new WalletError(
            "WALLET_BUSY",
            `${this.leases} payment request(s) are still in flight after waiting ${Math.round(this.drainTimeoutMs / 1000)} s; try again when they have finished`
          )
        );
      }, this.drainTimeoutMs);
      timer.unref?.();
      this.idleWaiters.push(wake);
    });
  }

  // -------------------------------------------------------------------------
  // replace
  // -------------------------------------------------------------------------

  /**
   * Replaces the wallet with a newly created one. The old wallet.json and its secret are COPIED into <dataDir>/retired/ (names
   * carrying the old address and a timestamp) before anything live changes; then the new secret is installed under its own name
   * and the new keystore is renamed over wallet.json, so wallet.json never disappears and every crash point leaves a pair that
   * matches. Nothing is ever deleted. Works while the old wallet is locked (the lost-password case). Waits (at most drainTimeoutMs)
   * for the requests in flight and refuses new ones meanwhile; WALLET_BUSY when they do not finish.
   * guard() / the swap / onSwapped() run in one synchronous stretch, so no request can start in between.
   */
  async replaceWallet(hooks: ReplaceHooks = {}): Promise<ReplaceResult> {
    return exclusive(this.dataDir, async () => {
      const old = this.readLive();
      if (!this.hasKeystore() || !old) throw new WalletError("NO_WALLET", "No wallet to replace");
      // From here until the end no NEW payment may start (leaseSigner refuses), and the requests already in flight are given up to
      // drainTimeoutMs to finish. Without this, free requests and 402 probes - or simply steady traffic - could keep the lock on
      // the wallet closed for ever.
      try {
        await this.waitForIdle();
        const wallet = Wallet.createRandom();
        const staged = await this.stage(wallet);
        await this.protectDirectory();
        // --- synchronous from here to the end of the swap ---
        this.assertIdle();
        hooks.guard?.({ oldAddress: old.address, newAddress: wallet.address });
        const retired = this.swapForReplacement(old, staged, hooks);
        this.adopt(staged);
        this.draining = false; // the new wallet is live: payments may start again, with it
        await this.refreshProtection();
        return { address: wallet.address, mnemonic: phraseOf(wallet)!, retired };
      } finally {
        this.draining = false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // balance
  // -------------------------------------------------------------------------

  /** Reads on-chain USDC balance (micro-USDC, 6 decimals) for the wallet address via RPC. */
  async getUsdcBalance(rpcUrl: string, usdcAddress: string): Promise<bigint> {
    return this.getUsdcBalanceOf(this.getAddress(), rpcUrl, usdcAddress);
  }

  /** Same read for any address (the retired wallets list). `signal` lets a caller that stopped waiting cancel the request, besides the 15 s bound. */
  async getUsdcBalanceOf(address: string | null, rpcUrl: string, usdcAddress: string, signal?: AbortSignal): Promise<bigint> {
    if (!address) throw new Error("No wallet address available");
    // Use the same fetch dispatcher as payment requests: the server installs
    // its outbound proxy there. ethers' default HTTP transport bypasses it.
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [
        { to: usdcAddress, data: ERC20_ABI.encodeFunctionData("balanceOf", [address]) }, "latest",
      ] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new Error("USDC balance RPC request failed");
    const body = await response.json() as { result?: string; error?: unknown };
    if (body.error || typeof body.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.result)) {
      throw new Error("Invalid USDC balance RPC response");
    }
    return ERC20_ABI.decodeFunctionResult("balanceOf", body.result)[0] as bigint;
  }

  // -------------------------------------------------------------------------
  // internals: reading
  // -------------------------------------------------------------------------

  private kdfOptions(): { scrypt: ScryptParams } {
    return { scrypt: this.options.scrypt ?? AUTO_SCRYPT };
  }

  private readLive(): LiveKeystore | null {
    let json: string;
    try {
      json = fs.readFileSync(this.keystorePath, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(json);
      const raw = String(parsed.address ?? "");
      return {
        json,
        address: getAddress(raw.startsWith("0x") ? raw : `0x${raw}`),
        protection: parsed?.[MARKER_KEY]?.protection === "auto" ? "auto" : "password",
        hasPhrase: typeof parsed?.["x-ethers"]?.mnemonicCiphertext === "string",
      };
    } catch {
      return null;
    }
  }

  private readSecret(file: string): { ok: true; secret: string } | { ok: false; reason: "secret_missing" | "secret_empty" | "secret_unreadable" } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (e) {
      return { ok: false, reason: errorCode(e) === "ENOENT" ? "secret_missing" : "secret_unreadable" };
    }
    const secret = raw.trim();
    return secret ? { ok: true, secret } : { ok: false, reason: "secret_empty" };
  }

  /** Does the live wallet's own secret file open the live keystore? */
  private async secretOpens(live: LiveKeystore): Promise<boolean> {
    const secret = this.readSecret(this.secretPathFor(live.address));
    return secret.ok ? (await decryptWith(live.json, secret.secret)) !== null : false;
  }

  /** The decrypted wallet is the one wallet.json holds right now. */
  private stillLive(wallet: AnyWallet): boolean {
    return this.readLive()?.address === wallet.address;
  }

  private assertIdle(): void {
    if (this.leases > 0) {
      throw new WalletError("WALLET_BUSY", `${this.leases} payment request(s) are in flight; wait for them to finish, then try again`);
    }
  }

  // -------------------------------------------------------------------------
  // internals: the wallet in memory, signers
  // -------------------------------------------------------------------------

  private setWallet(wallet: AnyWallet | null): void {
    this.unlockedWallet = wallet;
    this.epoch++;
  }

  /** Records `wallet` as the unlocked one; the same key already in use keeps its object (and its epoch), so signers in flight stay valid. */
  private adoptUnlocked(wallet: AnyWallet): void {
    if (this.unlockedWallet && this.unlockedWallet.address === wallet.address && this.unlockedWallet.privateKey === wallet.privateKey) return;
    this.setWallet(wallet);
  }

  /** Records the wallet that was just written as the live one. */
  private adopt(staged: Staged): void {
    this.setWallet(staged.wallet);
    this.unlockState = { unlockedBy: "auto", attempts: [{ source: "auto", ok: true }] };
  }

  private makeSigner(wallet: AnyWallet, epoch: number): EvmTypedDataSigner {
    const driver = this;
    return {
      address: wallet.address as `0x${string}`,
      async signTypedData(msg) {
        if (driver.epoch !== epoch || driver.unlockedWallet !== wallet) {
          throw new WalletError("WALLET_CHANGED", "The wallet was replaced or locked after this request started; nothing was signed");
        }
        const sig = await wallet.signTypedData(msg.domain as any, msg.types as any, msg.message as any);
        return sig as `0x${string}`;
      },
    };
  }

  // -------------------------------------------------------------------------
  // internals: protection of the directory and the secret
  // -------------------------------------------------------------------------

  /**
   * Locks the data directory down BEFORE a secret is written into it (a new file then inherits the restricted ACL). Asynchronous on
   * purpose: on Windows this runs PowerShell, and the server must keep answering requests while it does. Callers await it BEFORE
   * their synchronous stretch of file operations.
   */
  private async protectDirectory(): Promise<void> {
    if (!this.protector) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.protectionState = await this.protector({ dir: this.dataDir });
    } catch (e) {
      this.protectionState = { ok: false, method: process.platform === "win32" ? "acl" : "posix", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /** Applies and verifies the protection of the directory and of the live wallet's secret. Never throws; the result is health.secret_protected. */
  private async refreshProtection(): Promise<void> {
    if (!this.protector) return;
    const live = this.readLive();
    if (!live) {
      this.protectionState = null;
      return;
    }
    const secret = this.secretPathFor(live.address);
    const hasSecret = fs.existsSync(secret);
    if (live.protection !== "auto" && !hasSecret) {
      this.protectionState = null;
      return;
    }
    try {
      this.protectionState = await this.protector({ dir: this.dataDir, file: hasSecret ? secret : undefined });
    } catch (e) {
      this.protectionState = { ok: false, method: process.platform === "win32" ? "acl" : "posix", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  // -------------------------------------------------------------------------
  // internals: staging
  // -------------------------------------------------------------------------

  /**
   * Encrypts `wallet` with a fresh random secret and PROVES the result decrypts back to the same key before anything is
   * written: we never publish a keystore nothing can open.
   */
  private async stage(wallet: AnyWallet): Promise<Staged> {
    const secret = randomBytes(32).toString("hex");
    const encrypted = await encryptKeystoreJson(accountOf(wallet), secret, this.kdfOptions());
    const keystoreJson = withMarker(encrypted, "auto");
    const check = await decryptWith(keystoreJson, secret);
    if (!check || check.address !== wallet.address || check.privateKey !== wallet.privateKey) {
      throw new WalletError("STORAGE_FAILED", "Keystore verification failed");
    }
    return { wallet, keystoreJson, secret };
  }

  // -------------------------------------------------------------------------
  // internals: files
  // -------------------------------------------------------------------------

  /** Retired secrets (names inside retired/) that open a retired AUTO keystore of the live key. Read-only; bounded work. */
  private async findRetiredOpeners(live: LiveKeystore): Promise<string[]> {
    let names: string[];
    try {
      names = fs.readdirSync(this.retiredDir);
    } catch {
      return [];
    }
    // Only keystores of this very key that were protected by an auto secret can be opened by one (a password keystore cannot).
    const keystores: string[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const text = fs.readFileSync(path.join(this.retiredDir, name), "utf-8");
        const parsed = JSON.parse(text);
        const raw = String(parsed.address ?? "");
        if (parsed?.[MARKER_KEY]?.protection === "auto" && getAddress(raw.startsWith("0x") ? raw : `0x${raw}`) === live.address) keystores.push(text);
      } catch {
        /* not a keystore of ours */
      }
    }
    if (keystores.length === 0) return [];
    const openers: string[] = [];
    let attempts = 0;
    for (const name of names.filter((n) => n.endsWith(".secret")).sort()) {
      const secret = this.readSecret(path.join(this.retiredDir, name));
      if (!secret.ok) continue;
      for (const text of keystores) {
        if (++attempts > MAX_RETIRED_SCAN_ATTEMPTS) return openers;
        const wallet = await decryptWith(text, secret.secret);
        if (wallet && wallet.address === live.address) {
          openers.push(name);
          break;
        }
      }
    }
    return openers;
  }

  /**
   * Removes the retired secrets that open a retired copy of the live key. Only for a password-mode live keystore that the caller has
   * just proved reachable (`verifiedJson` is exactly what wallet.json holds): a retired copy of the live key adds nothing, and
   * leaving its auto secret behind would make "no password needed" true again. This is the one place a credential is deleted, and
   * only inside retired/. Whatever cannot be removed is remembered (retiredSecretsOpeningLiveKey) for the health card.
   */
  private async scrubRetiredOpeners(verifiedJson: string, trigger: RetiredScrubTrigger): Promise<{ removed: string[]; failed: string[] }> {
    const live = this.readLive();
    if (!live || live.protection !== "password" || live.json !== verifiedJson) {
      this.retiredOpeners = [];
      return { removed: [], failed: [] };
    }
    const removed: string[] = [];
    const failed: string[] = [];
    for (const name of await this.findRetiredOpeners(live)) {
      try {
        removeFile(path.join(this.retiredDir, name));
        removed.push(name);
      } catch {
        failed.push(name);
      }
    }
    this.retiredOpeners = failed;
    if (removed.length > 0) {
      try {
        this.options.onRetiredSecretsRemoved?.({ files: removed, trigger });
      } catch {
        /* an audit hook must never undo the clean-up */
      }
    }
    return { removed, failed };
  }

  /** Moves a credential that belongs to no live keystore into retired/ (never deletes it). Returns the new path. */
  private retireFile(file: string, kind: "orphan"): string {
    fs.mkdirSync(this.retiredDir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const name = uniqueName(this.retiredDir, `${kind}-${base}-${stamp()}`, ext);
    const dest = path.join(this.retiredDir, name);
    moveFileSync(file, dest);
    return dest;
  }

  /**
   * The unlock secret of the live (auto) keystore is missing. Look in retired/ for secrets that an earlier start moved there under
   * the name orphan-wallet-unlock-<this address>-<time>.secret (it does that when wallet.json belongs to another key), newest first,
   * and move back the first one that really opens this keystore. Candidates that do not open it are left alone and reported by name.
   */
  private async restoreOrphanedSecret(live: LiveKeystore): Promise<{ restored: string | null; candidates: string[] }> {
    const prefix = `orphan-wallet-unlock-${live.address.toLowerCase()}-`;
    let names: string[];
    try {
      names = fs.readdirSync(this.retiredDir).filter((n) => n.startsWith(prefix) && n.endsWith(".secret")).sort().reverse();
    } catch {
      return { restored: null, candidates: [] };
    }
    const doNotOpen: string[] = [];
    for (const name of names) {
      const file = path.join(this.retiredDir, name);
      const secret = this.readSecret(file);
      const wallet = secret.ok ? await decryptWith(live.json, secret.secret) : null;
      if (wallet && wallet.address === live.address) {
        try {
          moveFileSync(file, this.secretPathFor(live.address));
          return { restored: name, candidates: [] };
        } catch {
          /* cannot move it: leave it, and say where it is */
        }
      }
      doNotOpen.push(name);
    }
    return { restored: null, candidates: doNotOpen };
  }

  /**
   * Startup tidy-up. Stale temp files (they may hold an encrypted copy of a key that a retired credential still
   * opens) are deleted: a temp file is never the only copy of anything that has funds. Secrets that belong to no
   * live keystore are MOVED to retired/: those of other keys, and a secret next to a keystore recorded as
   * "password" that cannot open it. A wallet.json that is missing is left alone: nothing is touched, the situation
   * is reported (orphanFiles) and the operator decides.
   */
  private async sweepLayout(live: LiveKeystore | null): Promise<void> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dataDir);
    } catch {
      return;
    }
    for (const name of entries) if (TEMP_NAME.test(name)) removeQuietly(path.join(this.dataDir, name));
    if (!live) return;
    for (const name of entries) {
      const m = SECRET_NAME.exec(name);
      if (m && m[1] !== live.address.toLowerCase()) {
        try {
          this.retireFile(path.join(this.dataDir, name), "orphan");
        } catch {
          /* leave it where it is: still keyed to its own address */
        }
      }
    }
    if (live.protection === "password") {
      const own = this.secretPathFor(live.address);
      if (fs.existsSync(own) && !(await this.secretOpens(live))) {
        try {
          this.retireFile(own, "orphan");
        } catch {
          /* leave it */
        }
      }
    }
  }

  /**
   * Publishes the first keystore of this data directory. The directory is locked down first, then the secret goes
   * in under its OWN name (an existing file of that name is moved to retired/, never unlinked), then the keystore
   * is published via a hard link, which is atomic and fails if a wallet appeared meanwhile.
   */
  private publishNew(staged: Staged): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
    const temps: string[] = [];
    let installed: string | null = null;
    try {
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      const target = this.secretPathFor(staged.wallet.address);
      if (fs.existsSync(target)) this.retireFile(target, "orphan");
      const tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret);
      temps.push(tempSecret);
      renameOver(tempSecret, target);
      temps.splice(temps.indexOf(tempSecret), 1);
      installed = target;
      // link is atomic and fails if another request/process created the destination.
      fs.linkSync(tempKeystore, this.keystorePath);
    } catch (e) {
      // A secret we just generated for a key that never got a keystore protects nothing.
      if (installed && !this.hasKeystore()) removeQuietly(installed);
      if (errorCode(e) === "EEXIST") throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
      throw e;
    } finally {
      for (const temp of temps) removeQuietly(temp);
    }
  }

  /**
   * The replacement itself. Order is what makes every crash point safe:
   *   1. copy wallet.json and its secret into retired/ and compare the copies (live files untouched);
   *   2. install the new secret under ITS OWN name (the old one is not touched);
   *   3. rename the new keystore OVER wallet.json (it never disappears);
   *   4. onSwapped() (the database row); if it throws, wallet.json is renamed back over and the new secret removed;
   *   5. drop the old live secret (a verified copy is in retired/); if that fails, startup moves it.
   */
  private swapForReplacement(old: LiveKeystore, staged: Staged, hooks: ReplaceHooks): RetiredFiles {
    const undo = new Undo();
    const temps: string[] = [];
    const copies: Array<{ copy: string; original: string }> = [];
    const retiredAt = new Date().toISOString();
    const label = `${old.address.toLowerCase()}-${stamp(new Date(retiredAt))}`;
    const dir = this.retiredDir;
    const createdDir = !fs.existsSync(dir);
    const oldSecretFile = this.secretPathFor(old.address);
    const hadOldSecret = fs.existsSync(oldSecretFile);
    const sameAddress = old.address === staged.wallet.address;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const keystoreFile = uniqueName(dir, `wallet-${label}`, ".json");
      const secretFile = hadOldSecret ? uniqueName(dir, `wallet-unlock-${label}`, ".secret") : null;

      // 1. the old credentials, complete, in retired/ BEFORE anything live changes
      fs.copyFileSync(this.keystorePath, path.join(dir, keystoreFile), fs.constants.COPYFILE_EXCL);
      copies.push({ copy: path.join(dir, keystoreFile), original: this.keystorePath });
      if (fs.readFileSync(path.join(dir, keystoreFile), "utf-8") !== old.json) throw new WalletError("STORAGE_FAILED", "Could not copy the old wallet into retired/");
      if (secretFile) {
        fs.copyFileSync(oldSecretFile, path.join(dir, secretFile), fs.constants.COPYFILE_EXCL);
        copies.push({ copy: path.join(dir, secretFile), original: oldSecretFile });
        if (fs.readFileSync(path.join(dir, secretFile), "utf-8") !== fs.readFileSync(oldSecretFile, "utf-8")) throw new WalletError("STORAGE_FAILED", "Could not copy the old secret into retired/");
      }

      // 2. + 3. the new files in place
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      const newSecretFile = this.secretPathFor(staged.wallet.address);
      const tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret);
      temps.push(tempSecret);
      const displaced = fs.existsSync(newSecretFile) ? this.retireFile(newSecretFile, "orphan") : null;
      undo.add(() => {
        // Only take the new secret away when wallet.json is the old keystore again (compared by content). If restoring it failed
        // too, wallet.json is the NEW keystore, its key was never delivered to anyone, and this secret is the only thing that can
        // still open it.
        if (this.readLive()?.json !== old.json) return;
        removeQuietly(newSecretFile);
        if (displaced) renameOver(displaced, newSecretFile);
      });
      renameOver(tempSecret, newSecretFile);
      temps.splice(temps.indexOf(tempSecret), 1);
      renameOver(tempKeystore, this.keystorePath);
      temps.splice(temps.indexOf(tempKeystore), 1);
      undo.add(() => replaceFile(this.keystorePath, old.json, "wallet"));

      // 4. the caller's records
      const retired: RetiredFiles = { address: old.address, retiredAt, keystoreFile, secretFile };
      try {
        hooks.onSwapped?.({ ...retired, newAddress: staged.wallet.address });
      } catch (hookError) {
        throw new HookFailure(hookError);
      }

      // 5. the old live secret has a verified copy in retired/ (a freshly generated key never has the old address; if it did, the
      //    file just installed under that name must not be removed)
      if (hadOldSecret && !sameAddress) removeQuietly(oldSecretFile);
      return retired;
    } catch (e) {
      undo.rollback();
      // Copies made for an attempt that did not happen are exact duplicates of live files: remove those, and only those.
      for (const { copy, original } of copies) {
        try {
          if (fs.readFileSync(copy, "utf-8") === fs.readFileSync(original, "utf-8")) removeFile(copy);
        } catch {
          /* keep it */
        }
      }
      if (createdDir) {
        try {
          fs.rmdirSync(dir);
        } catch {
          /* not empty or already gone */
        }
      }
      if (e instanceof HookFailure) throw e.cause;
      if (e instanceof WalletError) throw e;
      throw new WalletError("STORAGE_FAILED", `Could not replace the wallet files: ${errorCode(e) ?? "I/O error"}`);
    } finally {
      for (const temp of temps) removeQuietly(temp);
    }
  }
}
