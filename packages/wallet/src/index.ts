import { Wallet, HDNodeWallet, Interface, getAddress, encryptKeystoreJson, type KeystoreAccount } from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

export type WalletImport =
  | { kind: "private_key"; private_key: string }
  | { kind: "keystore"; keystore: string; source_password: string }
  /** A BIP-39 recovery phrase of 12 or 24 English words, account index 0 (m/44'/60'/0'/0/0). */
  | { kind: "mnemonic"; mnemonic: string };

/**
 * How the keystore is protected:
 *  - "auto":   encrypted with a random 256-bit secret kept next to it in
 *              wallet-unlock.secret; the server unlocks itself on every start.
 *  - "manual": encrypted with a password a human supplies (today's behaviour);
 *              nothing but that password can unlock it.
 */
export type UnlockMode = "auto" | "manual";

/** Where an unlock credential came from at startup. */
export type UnlockSource = "env_or_file" | "auto";

export interface UnlockAttempt {
  source: UnlockSource;
  ok: boolean;
  /** Present when ok is false. Never contains the credential. */
  reason?: "wrong_credential" | "secret_empty" | "secret_unreadable";
}

export interface StartupUnlock {
  unlocked: boolean;
  /** In the order tried. Empty when there was nothing to try (no wallet, or no credential configured). */
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
  /** Whether the stored keystore carries a recovery phrase (a private-key import does not). */
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
  /** Runs synchronously before any file is touched; throw to abort (for example while a payment is in flight). */
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
  | "ALREADY_AUTO"
  | "NOT_AUTO"
  | "INVALID_IMPORT"
  | "NO_RECOVERY_PHRASE"
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
   * Overrides the scrypt cost of every keystore this driver writes. Leave unset
   * in production: human passwords use ethers' default (N=2^17); the random
   * 256-bit auto-unlock secret needs no stretching and uses N=2^14 so a restart
   * unlocks quickly. Tests lower it to keep the suite fast.
   */
  scrypt?: ScryptParams;
}

/** Default data directory: $MONEYSWITCH_DATA_DIR or ~/.moneyswitch (or /data inside docker, set via env). */
export function defaultDataDir(): string {
  return process.env.MONEYSWITCH_DATA_DIR || path.join(os.homedir(), ".moneyswitch");
}

export function walletFilePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "wallet.json");
}

/** The auto-unlock secret (mode 0600 where the OS supports it). Never returned by any API, never logged. */
export function unlockSecretPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "wallet-unlock.secret");
}

/** Replaced wallets are moved here, never deleted. */
export function retiredDirPath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "retired");
}

/** The standard Ethereum derivation path (account 0): MetaMask, OKX, Ledger and friends show the same address. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

const AUTO_SCRYPT: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };

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

/** One operation at a time per data directory: a toggle must never interleave with a replace. */
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
        /* best effort: the previous files are still on disk under their backup names */
      }
    }
    this.steps = [];
  }
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
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

/** Atomically replaces `dest` with `data`; falls back to a direct write if the rename is refused (restore paths only). */
function replaceFile(dest: string, data: string, prefix: string): void {
  const temp = writeTemp(path.dirname(dest), prefix, data);
  try {
    fs.renameSync(temp, dest);
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
  // Same rule ethers' own HDNodeWallet.encrypt() applies: keep the phrase inside the encrypted keystore.
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

interface Staged {
  wallet: AnyWallet;
  mode: UnlockMode;
  /** The complete, already-verified keystore JSON. */
  keystoreJson: string;
  /** The random auto-unlock secret (auto mode only). */
  secret: string | null;
}

/**
 * LocalWalletDriver: manages a single ethers v6 encrypted keystore file.
 * The decrypted in-memory `Wallet` (and therefore the private key and recovery
 * phrase) only ever lives inside this class's private field, never leaves the
 * process except through reveal(), and is never logged.
 */
export class LocalWalletDriver {
  private unlockedWallet: AnyWallet | null = null;
  private readonly dataDir: string;
  private readonly options: LocalWalletDriverOptions;
  private status: { source: UnlockSource | null; ok: boolean | null } = { source: null, ok: null };

  constructor(dataDir = defaultDataDir(), options: LocalWalletDriverOptions = {}) {
    this.dataDir = dataDir;
    this.options = options;
  }

  get keystorePath(): string {
    return walletFilePath(this.dataDir);
  }

  get secretPath(): string {
    return unlockSecretPath(this.dataDir);
  }

  get retiredDir(): string {
    return retiredDirPath(this.dataDir);
  }

  hasKeystore(): boolean {
    return fs.existsSync(this.keystorePath);
  }

  /** True when wallet-unlock.secret exists (the wallet is in, or was meant to be in, auto-unlock mode). */
  hasUnlockSecret(): boolean {
    return fs.existsSync(this.secretPath);
  }

  isUnlocked(): boolean {
    return this.unlockedWallet !== null;
  }

  /**
   * Result of the last real decrypt attempt with an automatic credential:
   * `ok` is null when no attempt was made (manual mode, no wallet, or the
   * driver was never asked to unlock itself).
   */
  get unlockStatus(): { source: UnlockSource | null; ok: boolean | null } {
    return { ...this.status };
  }

  /** Whether the stored keystore carries a recovery phrase. Readable while locked (the flag is plain metadata). */
  keystoreHasRecoveryPhrase(): boolean {
    try {
      const json = JSON.parse(fs.readFileSync(this.keystorePath, "utf-8"));
      return typeof json?.["x-ethers"]?.mnemonicCiphertext === "string";
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // creation and import
  // -------------------------------------------------------------------------

  /**
   * Creates a wallet from a fresh BIP-39 12-word phrase on m/44'/60'/0'/0/0.
   * Without a password the keystore is encrypted with a random secret that is
   * stored next to it (auto-unlock, the default); with a password nothing is
   * stored and the password is needed on every start (manual).
   * The returned phrase is the only copy outside the encrypted keystore.
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

  /** Imports a private key, an encrypted keystore or a recovery phrase into an empty data directory. */
  async importFrom(source: WalletImport, opts: { password?: string } = {}): Promise<ImportedWallet> {
    const mode: UnlockMode = opts.password === undefined ? "auto" : "manual";
    return exclusive(this.dataDir, async () => {
      if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; import cannot replace it");
      const wallet = await this.parseImport(source);
      const staged = await this.stage(wallet, mode, opts.password);
      this.publishNew(staged);
      this.adopt(staged);
      return { address: wallet.address, mode, hasRecoveryPhrase: phraseOf(wallet) !== null };
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

  /** An encrypted backup is useful even while locked, but still needs its password. */
  exportKeystore(): string {
    if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No wallet to back up");
    return fs.readFileSync(this.keystorePath, "utf-8");
  }

  /**
   * A portable keystore of the unlocked wallet, encrypted with `password` (the
   * operator's choice). Needed in auto mode, where wallet.json is encrypted with
   * a secret that is deliberately never exported.
   */
  async exportKeystoreWithPassword(password: string): Promise<string> {
    const wallet = this.requireUnlocked();
    return encryptKeystoreJson(accountOf(wallet), password, this.kdfOptions("manual"));
  }

  /** Decrypts the keystore into memory with a human password. Throws on wrong password without leaking details. */
  async unlock(password: string): Promise<{ address: string }> {
    if (!this.hasKeystore()) {
      throw new WalletError("NO_WALLET", "No keystore found; create one first via POST /v1/admin/wallet/create");
    }
    const json = fs.readFileSync(this.keystorePath, "utf-8");
    let wallet: AnyWallet;
    try {
      wallet = await Wallet.fromEncryptedJson(json, password);
    } catch {
      throw new WalletError("UNLOCK_FAILED", "Failed to unlock wallet: invalid password or corrupted keystore");
    }
    this.unlockedWallet = wallet;
    return { address: wallet.address };
  }

  /**
   * Startup unlock, in this order: the configured password (MONEYSWITCH_WALLET_PASSWORD
   * or _FILE; empty means "not configured"), then wallet-unlock.secret, else stay
   * locked. A source that exists but does not decrypt is reported in `attempts`
   * (never with the credential) and the next source is still tried, so a stale
   * password in the environment cannot lock out a wallet whose secret works.
   */
  async unlockOnStartup(opts: { password?: string | null } = {}): Promise<StartupUnlock> {
    const attempts: UnlockAttempt[] = [];
    if (!this.hasKeystore()) return { unlocked: false, attempts };
    if (this.unlockedWallet) return { unlocked: true, attempts };
    const configured = typeof opts.password === "string" && opts.password.trim() !== "" ? opts.password : null;
    if (configured !== null) {
      const wallet = await this.tryCredential(configured);
      if (wallet) {
        attempts.push({ source: "env_or_file", ok: true });
        this.unlockedWallet = wallet;
        this.status = { source: "env_or_file", ok: true };
        return { unlocked: true, attempts };
      }
      attempts.push({ source: "env_or_file", ok: false, reason: "wrong_credential" });
    }
    if (this.hasUnlockSecret()) {
      const secret = this.readSecret();
      if (secret.ok) {
        const wallet = await this.tryCredential(secret.secret);
        if (wallet) {
          attempts.push({ source: "auto", ok: true });
          this.unlockedWallet = wallet;
          this.status = { source: "auto", ok: true };
          return { unlocked: true, attempts };
        }
        attempts.push({ source: "auto", ok: false, reason: "wrong_credential" });
      } else {
        attempts.push({ source: "auto", ok: false, reason: secret.reason });
      }
    }
    this.status = attempts.length ? { source: attempts[0].source, ok: false } : { source: null, ok: null };
    return { unlocked: false, attempts };
  }

  lock(): void {
    this.unlockedWallet = null;
  }

  getAddress(): string | null {
    if (this.unlockedWallet) return this.unlockedWallet.address;
    if (this.hasKeystore()) {
      try {
        const json = JSON.parse(fs.readFileSync(this.keystorePath, "utf-8"));
        return getAddress(json.address.startsWith("0x") ? json.address : `0x${json.address}`);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Returns a ClientEvmSigner-shaped object bound to the unlocked wallet, or null if locked. */
  getSigner(): EvmTypedDataSigner | null {
    const wallet = this.unlockedWallet;
    if (!wallet) return null;
    return {
      address: wallet.address as `0x${string}`,
      async signTypedData(msg) {
        const sig = await wallet.signTypedData(
          msg.domain as any,
          msg.types as any,
          msg.message as any
        );
        return sig as `0x${string}`;
      },
    };
  }

  // -------------------------------------------------------------------------
  // recovery phrase
  // -------------------------------------------------------------------------

  /**
   * The words (or, for a wallet imported from a bare key, the private key) of
   * the unlocked wallet. The only way key material leaves the driver; the HTTP
   * layer makes this admin-only, address-confirmed, audited and no-store.
   */
  reveal(): RevealedSecret {
    const wallet = this.requireUnlocked();
    const phrase = phraseOf(wallet);
    return phrase ? { kind: "mnemonic", phrase } : { kind: "private_key", privateKey: wallet.privateKey };
  }

  /**
   * Checks words of the recovery phrase at 1-based positions (the dashboard asks
   * for two random ones). Returns false on any mismatch; throws if the wallet is
   * locked or has no phrase to check against.
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
   * Turns auto-unlock on: re-encrypts the (already unlocked) wallet with a fresh
   * random secret and stores the secret next to it. Crash-safe: the new keystore
   * is verified before anything on disk changes, the previous keystore is kept as
   * wallet.json.bak-<timestamp>, the secret is installed before the keystore is
   * swapped, and a failure part-way puts everything back.
   */
  async enableAutoUnlock(): Promise<{ address: string }> {
    return exclusive(this.dataDir, async () => {
      const wallet = this.requireUnlocked();
      if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No wallet");
      if (this.hasUnlockSecret() && (await this.secretDecryptsKeystore())) {
        throw new WalletError("ALREADY_AUTO", "Auto-unlock is already on");
      }
      const staged = await this.stage(wallet, "auto");
      this.swapKeystore(staged, { removeSecret: false });
      this.status = { source: "auto", ok: true };
      return { address: wallet.address };
    });
  }

  /**
   * Turns auto-unlock off: re-encrypts the unlocked wallet with `newPassword`
   * and removes wallet-unlock.secret afterwards. Same crash-safety as enabling.
   */
  async disableAutoUnlock(newPassword: string): Promise<{ address: string }> {
    return exclusive(this.dataDir, async () => {
      const wallet = this.requireUnlocked();
      if (!this.hasKeystore()) throw new WalletError("NO_WALLET", "No wallet");
      if (!this.hasUnlockSecret()) throw new WalletError("NOT_AUTO", "Auto-unlock is not on");
      const staged = await this.stage(wallet, "manual", newPassword);
      this.swapKeystore(staged, { removeSecret: true });
      this.status = { source: null, ok: null };
      return { address: wallet.address };
    });
  }

  // -------------------------------------------------------------------------
  // replace
  // -------------------------------------------------------------------------

  /**
   * Replaces the wallet with a new one (created, or imported). The old
   * wallet.json (and wallet-unlock.secret) are MOVED to <dataDir>/retired/ under
   * names carrying the old address and a timestamp; nothing is ever deleted.
   * Works while the old wallet is locked (the lost-password case). The new
   * wallet is built and verified first, then guard() / the file swap / onSwapped()
   * run in one synchronous stretch, so no other request can interleave.
   */
  async replaceWallet(
    spec: { kind: "create" } | { kind: "import"; source: WalletImport },
    opts: { password?: string } = {},
    hooks: ReplaceHooks = {}
  ): Promise<ReplaceResult> {
    const mode: UnlockMode = opts.password === undefined ? "auto" : "manual";
    return exclusive(this.dataDir, async () => {
      const oldAddress = this.getAddress();
      if (!this.hasKeystore() || !oldAddress) throw new WalletError("NO_WALLET", "No wallet to replace");
      const wallet = spec.kind === "create" ? Wallet.createRandom() : await this.parseImport(spec.source);
      const staged = await this.stage(wallet, mode, opts.password);
      // --- synchronous from here to the end of the swap ---
      hooks.guard?.({ oldAddress, newAddress: wallet.address });
      const retired = this.swapForReplacement(oldAddress, staged, hooks);
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
  // internals
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

  /** Decrypts wallet.json with one credential; null when it does not fit. */
  private async tryCredential(credential: string): Promise<AnyWallet | null> {
    try {
      return await Wallet.fromEncryptedJson(fs.readFileSync(this.keystorePath, "utf-8"), credential);
    } catch {
      return null;
    }
  }

  private readSecret(): { ok: true; secret: string } | { ok: false; reason: "secret_empty" | "secret_unreadable" } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.secretPath, "utf-8");
    } catch {
      return { ok: false, reason: "secret_unreadable" };
    }
    const secret = raw.trim();
    return secret ? { ok: true, secret } : { ok: false, reason: "secret_empty" };
  }

  private async secretDecryptsKeystore(): Promise<boolean> {
    const secret = this.readSecret();
    return secret.ok ? (await this.tryCredential(secret.secret)) !== null : false;
  }

  /** Records the wallet that was just written as the live one. */
  private adopt(staged: Staged): void {
    this.unlockedWallet = staged.wallet;
    this.status = staged.mode === "auto" ? { source: "auto", ok: true } : { source: null, ok: null };
  }

  /** Validates an import request. Errors never echo the input: ethers messages can contain the key. */
  private async parseImport(source: WalletImport): Promise<AnyWallet> {
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
        return await Wallet.fromEncryptedJson(source.keystore, source.source_password);
      }
      if (source.kind === "mnemonic") {
        if (typeof source.mnemonic !== "string" || source.mnemonic.length > 1_024) throw new Error();
        const words = source.mnemonic.trim().toLowerCase().split(/\s+/);
        if (words.length !== 12 && words.length !== 24) throw new Error();
        // HDNodeWallet.fromPhrase checks the word list and the checksum; account 0 on m/44'/60'/0'/0/0.
        return HDNodeWallet.fromPhrase(words.join(" "));
      }
      throw new Error();
    } catch {
      // ethers errors can include the supplied private key; never propagate them.
      throw new WalletError("INVALID_IMPORT", "Invalid wallet import or incorrect backup password");
    }
  }

  /**
   * Encrypts `wallet` for `mode` and PROVES the result decrypts back to the same
   * address before anything is written: we never publish a keystore nothing can open.
   */
  private async stage(wallet: AnyWallet, mode: UnlockMode, password?: string): Promise<Staged> {
    const secret = mode === "auto" ? randomBytes(32).toString("hex") : null;
    const credential = secret ?? password;
    if (typeof credential !== "string" || credential === "") throw new WalletError("STORAGE_FAILED", "A password is required");
    const keystoreJson = await encryptKeystoreJson(accountOf(wallet), credential, this.kdfOptions(mode));
    let check: AnyWallet;
    try {
      check = await Wallet.fromEncryptedJson(keystoreJson, credential);
    } catch {
      throw new WalletError("STORAGE_FAILED", "Keystore verification failed");
    }
    if (check.address !== wallet.address || check.privateKey !== wallet.privateKey) {
      throw new WalletError("STORAGE_FAILED", "Keystore verification failed");
    }
    return { wallet, mode, keystoreJson, secret };
  }

  /**
   * Publishes the first keystore of this data directory. The secret goes first
   * (a leftover one protects nothing while no keystore exists), then the keystore
   * via a hard link, which is atomic and fails if a wallet appeared meanwhile.
   */
  private publishNew(staged: Staged): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.hasKeystore()) throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
    const temps: string[] = [];
    let secretInstalled = false;
    try {
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      if (staged.secret) {
        const tempSecret = writeTemp(this.dataDir, "wallet-unlock", staged.secret);
        temps.push(tempSecret);
        try {
          fs.linkSync(tempSecret, this.secretPath);
        } catch (e) {
          if (errorCode(e) !== "EEXIST") throw e;
          fs.unlinkSync(this.secretPath); // stale: there is no keystore it could belong to
          fs.linkSync(tempSecret, this.secretPath);
        }
        secretInstalled = true;
      }
      // link is atomic and fails if another request/process created the destination.
      fs.linkSync(tempKeystore, this.keystorePath);
    } catch (e) {
      if (secretInstalled && !this.hasKeystore()) removeQuietly(this.secretPath);
      if (errorCode(e) === "EEXIST") throw new WalletError("WALLET_EXISTS", "Wallet already exists; use a separate data directory for another wallet");
      throw e;
    } finally {
      for (const temp of temps) removeQuietly(temp);
    }
  }

  /** Name for the safety copy of the previous keystore. */
  private backupName(): string {
    const base = `${this.keystorePath}.bak-${stamp()}`;
    let name = base;
    for (let i = 1; fs.existsSync(name); i++) name = `${base}-${i}`;
    return name;
  }

  /**
   * Swaps wallet.json for `staged` (and installs / removes the auto-unlock secret).
   * Order matters: the previous keystore is copied to wallet.json.bak-<timestamp>
   * first and stays there; the new secret is installed BEFORE the new keystore
   * (a crash in between leaves the old keystore plus a stale secret, still
   * openable with the old password); when the secret is being removed that
   * happens AFTER the new keystore is in place. The sequence is atomic renames,
   * and any failure restores the files it had already changed.
   */
  private swapKeystore(staged: Staged, opts: { removeSecret: boolean }): void {
    const previousKeystore = fs.readFileSync(this.keystorePath, "utf-8");
    const previousSecret = this.hasUnlockSecret() ? fs.readFileSync(this.secretPath, "utf-8") : null;
    const backup = this.backupName();
    const undo = new Undo();
    const temps: string[] = [];
    try {
      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      const tempSecret = staged.secret ? writeTemp(this.dataDir, "wallet-unlock", staged.secret) : null;
      if (tempSecret) temps.push(tempSecret);

      fs.copyFileSync(this.keystorePath, backup, fs.constants.COPYFILE_EXCL);

      if (tempSecret) {
        fs.renameSync(tempSecret, this.secretPath);
        temps.splice(temps.indexOf(tempSecret), 1);
        undo.add(() => {
          if (previousSecret !== null) replaceFile(this.secretPath, previousSecret, "wallet-unlock");
          else removeQuietly(this.secretPath);
        });
      }

      fs.renameSync(tempKeystore, this.keystorePath);
      temps.splice(temps.indexOf(tempKeystore), 1);
      undo.add(() => replaceFile(this.keystorePath, previousKeystore, "wallet"));

      // What is on disk now must be what was verified in memory.
      if (fs.readFileSync(this.keystorePath, "utf-8") !== staged.keystoreJson) {
        throw new WalletError("STORAGE_FAILED", "Keystore write verification failed");
      }

      if (opts.removeSecret) {
        fs.unlinkSync(this.secretPath);
        undo.add(() => {
          if (previousSecret !== null) replaceFile(this.secretPath, previousSecret, "wallet-unlock");
        });
      }
    } catch (e) {
      undo.rollback();
      // The safety copy is only redundant clutter if the previous keystore is back in place.
      try {
        if (fs.readFileSync(this.keystorePath, "utf-8") === previousKeystore) removeQuietly(backup);
      } catch {
        /* keep the backup: it may be the only copy left */
      }
      if (e instanceof WalletError) throw e;
      throw new WalletError("STORAGE_FAILED", `Could not update the wallet files: ${errorCode(e) ?? "I/O error"}`);
    } finally {
      for (const temp of temps) removeQuietly(temp);
    }
  }

  /**
   * Moves the current keystore (and secret) into retired/ and installs the new
   * ones. Everything is renames inside one data directory; the old files are
   * never deleted, and a failure (or a throwing hook) moves them back.
   */
  private swapForReplacement(oldAddress: string, staged: Staged, hooks: ReplaceHooks): RetiredFiles {
    const undo = new Undo();
    const temps: string[] = [];
    const retiredAt = new Date().toISOString();
    const label = `${oldAddress.toLowerCase()}-${stamp(new Date(retiredAt))}`;
    const dir = this.retiredDir;
    const createdDir = !fs.existsSync(dir);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const keystoreFile = uniqueName(dir, `wallet-${label}`, ".json");
      const secretFile = this.hasUnlockSecret() ? uniqueName(dir, `wallet-unlock-${label}`, ".secret") : null;

      const tempKeystore = writeTemp(this.dataDir, "wallet", staged.keystoreJson);
      temps.push(tempKeystore);
      const tempSecret = staged.secret ? writeTemp(this.dataDir, "wallet-unlock", staged.secret) : null;
      if (tempSecret) temps.push(tempSecret);

      fs.renameSync(this.keystorePath, path.join(dir, keystoreFile));
      undo.add(() => fs.renameSync(path.join(dir, keystoreFile), this.keystorePath));
      if (secretFile) {
        fs.renameSync(this.secretPath, path.join(dir, secretFile));
        undo.add(() => fs.renameSync(path.join(dir, secretFile), this.secretPath));
      }
      if (tempSecret) {
        fs.renameSync(tempSecret, this.secretPath);
        temps.splice(temps.indexOf(tempSecret), 1);
        undo.add(() => removeQuietly(this.secretPath));
      }
      fs.renameSync(tempKeystore, this.keystorePath);
      temps.splice(temps.indexOf(tempKeystore), 1);
      undo.add(() => removeQuietly(this.keystorePath));

      const retired: RetiredFiles = { address: oldAddress, retiredAt, keystoreFile, secretFile };
      try {
        hooks.onSwapped?.({ ...retired, newAddress: staged.wallet.address });
      } catch (hookError) {
        throw new HookFailure(hookError);
      }
      return retired;
    } catch (e) {
      undo.rollback();
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
