import { Wallet, HDNodeWallet, Interface, getAddress, encryptKeystoreJson, type KeystoreAccount } from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProtector, type Protector, type SecretProtection } from "./protect.js";

export { evaluateSddl, type Protector, type ProtectTargets, type SecretProtection } from "./protect.js";

export type WalletImport =
  | { kind: "private_key"; private_key: string }
  | { kind: "keystore"; keystore: string; source_password: string }
  /** A BIP-39 recovery phrase of 12 or 24 English words, account index 0 (m/44'/60'/0'/0/0). */
  | { kind: "mnemonic"; mnemonic: string };

/** What a caller asks for when it creates or imports: no password = "auto", a password = "manual". */
export type UnlockMode = "auto" | "manual";

/**
 * How the keystore on disk is protected, RECORDED in wallet.json (non-secret `x-moneyswitch` field) so health
 * never has to guess it from which files happen to exist. A keystore without the field predates this release and
 * is a password keystore.
 *  - "auto":     encrypted with a random 256-bit secret kept in wallet-unlock-<address>.secret.
 *  - "password": encrypted with a password a human (or MONEYSWITCH_WALLET_PASSWORD) supplies.
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
  mode: UnlockMode;
}

export interface ImportedWallet {
  address: string;
  mode: UnlockMode;
  /** Always false: an import keeps only the account-0 private key, never a seed. */
  hasRecoveryPhrase: boolean;
}

export type RevealedSecret =
  | { kind: "mnemonic"; phrase: string }
  | { kind: "private_key"; privateKey: string };

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
  mode: UnlockMode;
  /** Only when a new wallet was created: its recovery phrase (returned once). */
  mnemonic?: string;
  hasRecoveryPhrase: boolean;
  retired: RetiredFiles;
}

export type WalletErrorCode =
  | "WALLET_EXISTS"
  | "NO_WALLET"
  | "WALLET_LOCKED"
  | "WALLET_BUSY"
  | "WALLET_CHANGED"
  | "ALREADY_AUTO"
  | "NOT_AUTO"
  | "INVALID_IMPORT"
  | "EXPECTED_ADDRESS_MISMATCH"
  | "NO_RECOVERY_PHRASE"
  | "BACKUP_NEEDS_PASSWORD"
  | "UNLOCK_FAILED"
  | "STORAGE_FAILED";

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
   * Overrides the scrypt cost of every keystore this driver writes. Leave unset in production: human passwords
   * use ethers' default (N=2^17); the random 256-bit auto-unlock secret needs no stretching and uses N=2^14 so a
   * restart unlocks quickly. Tests lower it to keep the suite fast.
   */
  scrypt?: ScryptParams;
  /**
   * What protects the data directory and the secret (see protect.ts). Default: the real thing for this OS.
   * `false` switches it off (tests that do not exercise it); a function replaces it (tests of the failure path).
   */
  protect?: false | Protector;
  /** Test seam: the PowerShell executable used on Windows. */
  powershellPath?: string;
}

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

/** One operation at a time per data directory: a toggle, an unlock and a replace must never interleave. */
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

function normalizeWord(word: unknown): string {
  return typeof word === "string" ? word.trim().toLowerCase() : "";
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
  mode: UnlockMode;
  protection: Protection;
  /** The complete, already-verified keystore JSON (marker included). */
  keystoreJson: string;
  /** The random auto-unlock secret (auto mode only). */
  secret: string | null;
}

/**
 * LocalWalletDriver: manages a single ethers v6 encrypted keystore file.
 * The decrypted in-memory `Wallet` (and therefore the private key and recovery phrase) only ever lives inside
 * this class's private field, never leaves the process except through reveal(), and is never logged.
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

  constructor(dataDir = defaultDataDir(), options: LocalWalletDriverOptions = {}) {
    this.dataDir = dataDir;
    this.options = options;
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
  // creation and import
  // -------------------------------------------------------------------------

  /**
   * Creates a wallet from a fresh BIP-39 12-word phrase on m/44'/60'/0'/0/0. Without a password the keystore is
   * encrypted with a random secret that is stored next to it (auto-unlock, the default); with a password nothing
   * is stored and the password is needed on every start (manual). The returned phrase is the only copy outside
   * the encrypted keystore.
   */
  async createWithPhrase(opts: { password?: string } = {}): Promise<CreatedWallet> {
    const mode: UnlockMode = opts.password === undefined ? "auto" : "manual";
    return exclusive(this.dataDir, async () => {
      if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
      const wallet = Wallet.createRandom();
      const staged = await this.stage(wallet, mode, opts.password);
      this.publishNew(staged);
      this.adopt(staged);
      return { address: wallet.address, mnemonic: wallet.mnemonic!.phrase, mode };
    });
  }

  /**
   * Imports a private key, an encrypted keystore or a recovery phrase into an empty data directory. Whatever the
   * source, ONLY the account-0 private key is kept: never the seed, never a non-default derivation path. (A phrase
   * that also controls other accounts must not live on a hot server.) `expectedAddress` makes the import refuse
   * when the key does not belong to the address the operator expects.
   */
  async importFrom(source: WalletImport, opts: { password?: string; expectedAddress?: string } = {}): Promise<ImportedWallet> {
    const mode: UnlockMode = opts.password === undefined ? "auto" : "manual";
    return exclusive(this.dataDir, async () => {
      if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; import cannot replace it");
      const wallet = await this.parseImport(source);
      this.assertExpectedAddress(wallet, opts.expectedAddress);
      const staged = await this.stage(wallet, mode, opts.password);
      this.publishNew(staged);
      this.adopt(staged);
      return { address: wallet.address, mode, hasRecoveryPhrase: false };
    });
  }

  /** Legacy shape kept for callers that only want a password-protected wallet: manual mode, address only. */
  async createWallet(password: string): Promise<{ address: string }> {
    const { address } = await this.createWithPhrase({ password });
    return { address };
  }

  /** Legacy shape: manual mode with the given new password. */
  async importWallet(source: WalletImport, password: string): Promise<{ address: string }> {
    const { address } = await this.importFrom(source, { password });
    return { address };
  }

  // -------------------------------------------------------------------------
  // unlocking
  // -------------------------------------------------------------------------

  /**
   * wallet.json as it is, for a password wallet. An auto wallet's file is encrypted with a secret that is never
   * exported, so handing it out would be handing out something nothing can open: that needs a password
   * (exportKeystoreWithPassword) instead.
   */
  exportKeystore(): string {
    const live = this.readLive();
    if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No wallet to back up");
    if (live?.protection === "auto") {
      throw new WalletError("BACKUP_NEEDS_PASSWORD", "This wallet is encrypted with the server's auto-unlock secret, which is never exported; export it with a password instead");
    }
    return fs.readFileSync(this.keystorePath, "utf-8");
  }

  /** A portable keystore of the unlocked wallet (no server marker), encrypted with `password` (the operator's choice). */
  async exportKeystoreWithPassword(password: string): Promise<string> {
    const wallet = this.requireUnlocked();
    return encryptKeystoreJson(accountOf(wallet), password, this.kdfOptions("manual"));
  }

  /**
   * Decrypts the keystore into memory with a human password. Runs under the same lock as replace and the toggles,
   * and refuses to adopt a wallet that is no longer the one on disk (a replace or an outside edit while scrypt was
   * running). Throws on a wrong password without leaking details.
   */
  async unlock(password: string): Promise<{ address: string }> {
    return exclusive(this.dataDir, async () => {
      if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No keystore found; create one first via POST /v1/admin/wallet/create");
      const live = this.readLive();
      if (!live) throw new WalletError("UNLOCK_FAILED", "Failed to unlock wallet: invalid password or corrupted keystore");
      const wallet = await decryptWith(live.json, password);
      if (!wallet) throw new WalletError("UNLOCK_FAILED", "Failed to unlock wallet: invalid password or corrupted keystore");
      this.assertStillLive(wallet);
      this.adoptUnlocked(wallet);
      return { address: wallet.address };
    });
  }

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
      const finish = (wallet: AnyWallet | null, by: UnlockSource | null): StartupUnlock => {
        if (wallet) this.adoptUnlocked(wallet);
        this.unlockState = { unlockedBy: wallet ? by : null, attempts };
        this.refreshProtection();
        return { unlocked: wallet !== null, attempts: attempts.map((a) => ({ ...a })) };
      };

      const configured = typeof opts.password === "string" && opts.password.trim() !== "" ? opts.password : null;
      if (configured !== null) {
        const wallet = await decryptWith(live.json, configured);
        if (wallet && this.stillLive(wallet)) {
          attempts.push({ source: "env_or_file", ok: true });
          return finish(wallet, "env_or_file");
        }
        attempts.push({ source: "env_or_file", ok: false, reason: "env_wrong" });
      }

      const secretFile = this.secretPathFor(live.address);
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
      return finish(null, null);
    });
  }

  /** Forgets the unlocked key. Refuses (WALLET_BUSY) while a request holds a signer lease. */
  lock(): void {
    if (this.leases > 0) {
      throw new WalletError("WALLET_BUSY", `${this.leases} payment request(s) are in flight; wait for them to finish before locking the wallet`);
    }
    this.setWallet(null);
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
    this.leases++;
    let released = false;
    return {
      signer: this.makeSigner(wallet, this.epoch),
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
      },
    };
  }

  // -------------------------------------------------------------------------
  // recovery phrase
  // -------------------------------------------------------------------------

  /**
   * The words of a wallet generated here, or the private key of one that was imported. The only way key material
   * leaves the driver; the HTTP layer makes it admin-only, address-confirmed, audited and no-store.
   */
  reveal(): RevealedSecret {
    const wallet = this.requireUnlocked();
    const phrase = phraseOf(wallet);
    return phrase ? { kind: "mnemonic", phrase } : { kind: "private_key", privateKey: wallet.privateKey };
  }

  /**
   * Checks words of the recovery phrase at 1-based positions (the dashboard asks for two random ones). Returns
   * false on any mismatch; throws if the wallet is locked or has no phrase to check against.
   */
  checkRecoveryWords(positions: number[], words: string[]): boolean {
    const wallet = this.requireUnlocked();
    const phrase = phraseOf(wallet);
    if (!phrase) throw new WalletError("NO_RECOVERY_PHRASE", "This wallet has no recovery phrase");
    const list = phrase.split(" ");
    if (positions.length === 0 || positions.length !== words.length) return false;
    return positions.every(
      (position, i) => Number.isInteger(position) && position >= 1 && position <= list.length && list[position - 1] === normalizeWord(words[i])
    );
  }

  // -------------------------------------------------------------------------
  // auto-unlock on / off
  // -------------------------------------------------------------------------

  /**
   * Turns auto-unlock on: re-encrypts the (already unlocked) wallet with a fresh random secret and stores the
   * secret next to it. The new keystore is built and test-decrypted before anything on disk changes; the secret is
   * installed first (a crash then leaves the old keystore with a stale secret, which startup moves to retired/),
   * the keystore is swapped by rename-over, and a failure puts everything back. No copy of the old keystore stays.
   */
  async enableAutoUnlock(): Promise<{ address: string }> {
    return exclusive(this.dataDir, async () => {
      const wallet = this.requireUnlocked();
      const live = this.readLive();
      if (!live) throw new WalletError("NO_WALLET", "No wallet");
      this.assertSameWallet(wallet, live);
      if (live.protection === "auto" && (await this.secretOpens(live))) throw new WalletError("ALREADY_AUTO", "Auto-unlock is already on");
      const staged = await this.stage(wallet, "auto");
      this.swapProtection(live, staged);
      this.unlockState = { unlockedBy: "auto", attempts: [{ source: "auto", ok: true }] };
      this.refreshProtection();
      return { address: wallet.address };
    });
  }

  /**
   * Turns auto-unlock off: re-encrypts the unlocked wallet with `newPassword`, and only once that keystore is
   * verified and in place removes the old secret. Nothing is left on disk that opens the key without the password.
   */
  async disableAutoUnlock(newPassword: string): Promise<{ address: string }> {
    return exclusive(this.dataDir, async () => {
      const wallet = this.requireUnlocked();
      const live = this.readLive();
      if (!live) throw new WalletError("NO_WALLET", "No wallet");
      this.assertSameWallet(wallet, live);
      if (live.protection !== "auto" && !fs.existsSync(this.secretPathFor(live.address))) throw new WalletError("NOT_AUTO", "Auto-unlock is not on");
      const staged = await this.stage(wallet, "manual", newPassword);
      this.swapProtection(live, staged);
      this.unlockState = { unlockedBy: null, attempts: [] };
      this.protectionState = null;
      return { address: wallet.address };
    });
  }

  // -------------------------------------------------------------------------
  // replace
  // -------------------------------------------------------------------------

  /**
   * Replaces the wallet with a new one (created, or imported). The old wallet.json and its secret are COPIED into
   * <dataDir>/retired/ (names carrying the old address and a timestamp) before anything live changes; then the new
   * secret is installed under its own name and the new keystore is renamed over wallet.json, so wallet.json never
   * disappears and every crash point leaves a pair that matches. Nothing is ever deleted. Works while the old
   * wallet is locked (the lost-password case). Refuses with WALLET_BUSY while any request holds a signer lease.
   * guard() / the swap / onSwapped() run in one synchronous stretch, so no request can start in between.
   */
  async replaceWallet(
    spec: { kind: "create" } | { kind: "import"; source: WalletImport },
    opts: { password?: string; expectedAddress?: string } = {},
    hooks: ReplaceHooks = {}
  ): Promise<ReplaceResult> {
    const mode: UnlockMode = opts.password === undefined ? "auto" : "manual";
    return exclusive(this.dataDir, async () => {
      const old = this.readLive();
      if (!this.hasKeystore() || !old) throw new WalletError("NO_WALLET", "No wallet to replace");
      this.assertIdle();
      const wallet = spec.kind === "create" ? Wallet.createRandom() : await this.parseImport(spec.source);
      if (spec.kind === "import") this.assertExpectedAddress(wallet, opts.expectedAddress);
      const staged = await this.stage(wallet, mode, opts.password);
      // --- synchronous from here to the end of the swap ---
      this.assertIdle();
      hooks.guard?.({ oldAddress: old.address, newAddress: wallet.address });
      const retired = this.swapForReplacement(old, staged, hooks);
      this.adopt(staged);
      return {
        address: wallet.address,
        mode,
        ...(spec.kind === "create" ? { mnemonic: phraseOf(wallet)! } : {}),
        hasRecoveryPhrase: phraseOf(wallet) !== null,
        retired,
      };
    });
  }

  // -------------------------------------------------------------------------
  // balance
  // -------------------------------------------------------------------------

  /** Reads on-chain USDC balance (micro-USDC, 6 decimals) for the wallet address via RPC. */
  async getUsdcBalance(rpcUrl: string, usdcAddress: string): Promise<bigint> {
    return this.getUsdcBalanceOf(this.getAddress(), rpcUrl, usdcAddress);
  }

  /** Same read for any address (the retired wallets list). */
  async getUsdcBalanceOf(address: string | null, rpcUrl: string, usdcAddress: string): Promise<bigint> {
    if (!address) throw new Error("No wallet address available");
    // Use the same fetch dispatcher as payment requests: the server installs
    // its outbound proxy there. ethers' default HTTP transport bypasses it.
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [
        { to: usdcAddress, data: ERC20_ABI.encodeFunctionData("balanceOf", [address]) }, "latest",
      ] }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
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

  private requireUnlocked(): AnyWallet {
    if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No wallet");
    if (!this.unlockedWallet) throw new WalletError("WALLET_LOCKED", "The wallet is locked; unlock it first");
    return this.unlockedWallet;
  }

  private kdfOptions(mode: UnlockMode): { scrypt?: ScryptParams } {
    const scrypt = this.options.scrypt ?? (mode === "auto" ? AUTO_SCRYPT : undefined);
    return scrypt ? { scrypt } : {};
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

  private assertStillLive(wallet: AnyWallet): void {
    if (!this.stillLive(wallet)) {
      throw new WalletError("UNLOCK_FAILED", "Failed to unlock wallet: the wallet file changed while it was being unlocked");
    }
  }

  /**
   * Re-encrypting the unlocked key over wallet.json is only right if wallet.json IS that key's keystore. If the file was
   * replaced behind the driver's back, doing it would silently overwrite someone else's wallet with this one.
   */
  private assertSameWallet(wallet: AnyWallet, live: LiveKeystore): void {
    if (wallet.address !== live.address) {
      throw new WalletError(
        "WALLET_CHANGED",
        "wallet.json is no longer the wallet that is unlocked (it was replaced outside this server); restart the server or unlock again before changing the unlock mode"
      );
    }
  }

  private assertIdle(): void {
    if (this.leases > 0) {
      throw new WalletError("WALLET_BUSY", `${this.leases} payment request(s) are in flight; wait for them to finish, then try again`);
    }
  }

  private assertExpectedAddress(wallet: AnyWallet, expected: string | undefined): void {
    if (expected === undefined) return;
    let normalized: string | null = null;
    try {
      normalized = getAddress(expected);
    } catch {
      /* not an address at all */
    }
    if (normalized !== wallet.address) {
      throw new WalletError("EXPECTED_ADDRESS_MISMATCH", `That key belongs to ${wallet.address}, not to the address you expected`);
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
    this.unlockState =
      staged.protection === "auto" ? { unlockedBy: "auto", attempts: [{ source: "auto", ok: true }] } : { unlockedBy: null, attempts: [] };
    if (staged.protection === "auto") this.refreshProtection();
    else this.protectionState = null;
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

  /** Locks the data directory down BEFORE a secret is written into it (a new file then inherits the restricted ACL). */
  private protectDirectory(): void {
    if (!this.protector) return;
    try {
      this.protectionState = this.protector({ dir: this.dataDir });
    } catch (e) {
      this.protectionState = { ok: false, method: process.platform === "win32" ? "acl" : "posix", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /** Applies and verifies the protection of the directory and of the live wallet's secret. Never throws; the result is health.secret_protected. */
  private refreshProtection(): void {
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
      this.protectionState = this.protector({ dir: this.dataDir, file: hasSecret ? secret : undefined });
    } catch (e) {
      this.protectionState = { ok: false, method: process.platform === "win32" ? "acl" : "posix", detail: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  // -------------------------------------------------------------------------
  // internals: import / staging
  // -------------------------------------------------------------------------

  /**
   * Validates an import request and reduces it to the bare account-0 key (a plain Wallet). Errors never echo the
   * input: ethers messages can contain the key.
   */
  private async parseImport(source: WalletImport): Promise<Wallet> {
    try {
      if (source.kind === "private_key") {
        if (typeof source.private_key !== "string" || !/^(0x)?[a-fA-F0-9]{64}$/.test(source.private_key.trim())) throw new Error();
        return new Wallet(`0x${source.private_key.trim().replace(/^0x/, "")}`);
      }
      if (source.kind === "keystore") {
        if (typeof source.keystore !== "string" || source.keystore.length > 128_000 || typeof source.source_password !== "string") throw new Error();
        const parsed = JSON.parse(source.keystore);
        const crypto = parsed.crypto ?? parsed.Crypto;
        const kdf = crypto?.kdfparams;
        if (parsed.version !== 3 || crypto?.cipher !== "aes-128-ctr") throw new Error();
        // Bound untrusted backup KDF work before asking ethers to decrypt it.
        if (crypto.kdf === "scrypt") {
          if (![kdf?.n, kdf?.r, kdf?.p].every((v) => Number.isSafeInteger(v) && v > 0) || kdf.n > 1_048_576 || kdf.r > 32 || kdf.p > 16 || kdf.n * kdf.r * kdf.p > 4_194_304) throw new Error();
        } else if (crypto.kdf === "pbkdf2") {
          if (!Number.isSafeInteger(kdf?.c) || kdf.c < 1 || kdf.c > 2_000_000) throw new Error();
        } else throw new Error();
        // The keystore may carry a seed (x-ethers) on any derivation path: keep neither, only the key it signs with.
        const opened = await Wallet.fromEncryptedJson(source.keystore, source.source_password);
        return new Wallet(opened.privateKey);
      }
      if (source.kind === "mnemonic") {
        if (typeof source.mnemonic !== "string" || source.mnemonic.length > 1_024) throw new Error();
        const words = source.mnemonic.trim().toLowerCase().split(/\s+/);
        if (words.length !== 12 && words.length !== 24) throw new Error();
        // HDNodeWallet.fromPhrase checks the word list and the checksum; account 0 on m/44'/60'/0'/0/0. The phrase itself is dropped.
        return new Wallet(HDNodeWallet.fromPhrase(words.join(" ")).privateKey);
      }
      throw new Error();
    } catch {
      // ethers errors can include the supplied private key; never propagate them.
      throw new WalletError("INVALID_IMPORT", "Invalid wallet import or incorrect backup password");
    }
  }

  /**
   * Encrypts `wallet` for `mode` and PROVES the result decrypts back to the same key before anything is written:
   * we never publish a keystore nothing can open.
   */
  private async stage(wallet: AnyWallet, mode: UnlockMode, password?: string): Promise<Staged> {
    const secret = mode === "auto" ? randomBytes(32).toString("hex") : null;
    const credential = secret ?? password;
    if (typeof credential !== "string" || credential === "") throw new WalletError("STORAGE_FAILED", "A password is required");
    const protection: Protection = mode === "auto" ? "auto" : "password";
    const encrypted = await encryptKeystoreJson(accountOf(wallet), credential, this.kdfOptions(mode));
    const keystoreJson = withMarker(encrypted, protection);
    const check = await decryptWith(keystoreJson, credential);
    if (!check || check.address !== wallet.address || check.privateKey !== wallet.privateKey) {
      throw new WalletError("STORAGE_FAILED", "Keystore verification failed");
    }
    return { wallet, mode, protection, keystoreJson, secret };
  }

  // -------------------------------------------------------------------------
  // internals: files
  // -------------------------------------------------------------------------

  /** Moves a credential that belongs to no live keystore into retired/ (never deletes it). Returns the new path. */
  private retireFile(file: string, kind: "orphan"): string {
    fs.mkdirSync(this.retiredDir, { recursive: true, mode: 0o700 });
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const name = uniqueName(this.retiredDir, `${kind}-${base}-${stamp()}`, ext);
    const dest = path.join(this.retiredDir, name);
    try {
      renameOver(file, dest);
    } catch (e) {
      if (errorCode(e) !== "EXDEV") throw e;
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      removeFile(file);
    }
    return dest;
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
      if (staged.secret) this.protectDirectory();
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      if (staged.secret) {
        const target = this.secretPathFor(staged.wallet.address);
        if (fs.existsSync(target)) this.retireFile(target, "orphan");
        const tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret);
        temps.push(tempSecret);
        renameOver(tempSecret, target);
        temps.splice(temps.indexOf(tempSecret), 1);
        installed = target;
      }
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
   * Re-protects the SAME key (auto <-> password). Nothing about the old keystore stays on disk afterwards, and
   * every step leaves a wallet.json that something the operator holds can open:
   *   ON  (to auto):     new secret installed under the wallet's own name (a stale one is moved to retired/),
   *                      then the new keystore renamed over wallet.json.
   *   OFF (to password): the new keystore renamed over wallet.json, verified, and only then the old secret removed.
   * A failure at any step restores the previous keystore (rename-over) and secret.
   */
  private swapProtection(live: LiveKeystore, staged: Staged): void {
    const secretFile = this.secretPathFor(live.address);
    const adding = staged.secret !== null;
    const undo = new Undo();
    const temps: string[] = [];
    try {
      if (adding) this.protectDirectory();
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      let tempSecret: string | null = null;
      if (adding) {
        tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret!);
        temps.push(tempSecret);
        const stale = fs.existsSync(secretFile) ? this.retireFile(secretFile, "orphan") : null;
        undo.add(() => {
          removeQuietly(secretFile);
          if (stale) renameOver(stale, secretFile);
        });
        renameOver(tempSecret, secretFile);
        temps.splice(temps.indexOf(tempSecret), 1);
      }

      renameOver(tempKeystore, this.keystorePath);
      temps.splice(temps.indexOf(tempKeystore), 1);
      undo.add(() => replaceFile(this.keystorePath, live.json, "wallet"));

      // What is on disk now must be what was verified in memory.
      if (fs.readFileSync(this.keystorePath, "utf-8") !== staged.keystoreJson) {
        throw new WalletError("STORAGE_FAILED", "Keystore write verification failed");
      }

      if (!adding && fs.existsSync(secretFile)) {
        // The password keystore is verified and in place: the old secret opens nothing any more.
        removeFile(secretFile);
      }
    } catch (e) {
      undo.rollback();
      if (e instanceof WalletError) throw e;
      throw new WalletError("STORAGE_FAILED", `Could not update the wallet files: ${errorCode(e) ?? "I/O error"}`);
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
      if (staged.secret) {
        this.protectDirectory();
        const newSecretFile = this.secretPathFor(staged.wallet.address);
        const tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret);
        temps.push(tempSecret);
        const displaced = fs.existsSync(newSecretFile) ? this.retireFile(newSecretFile, "orphan") : null;
        undo.add(() => {
          removeQuietly(newSecretFile);
          if (displaced) renameOver(displaced, newSecretFile);
        });
        renameOver(tempSecret, newSecretFile);
        temps.splice(temps.indexOf(tempSecret), 1);
      }
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

      // 5. the old live secret has a verified copy in retired/; with a new secret of the same name it was already replaced
      if (hadOldSecret && !(sameAddress && staged.secret)) removeQuietly(oldSecretFile);
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
