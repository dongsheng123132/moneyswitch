import { Wallet, Interface, getAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type WalletImport =
  | { kind: "private_key"; private_key: string }
  | { kind: "keystore"; keystore: string; source_password: string };

/** Default data directory: $MONEYSWITCH_DATA_DIR or ~/.moneyswitch (or /data inside docker, set via env). */
export function defaultDataDir(): string {
  return process.env.MONEYSWITCH_DATA_DIR || path.join(os.homedir(), ".moneyswitch");
}

export function walletFilePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "wallet.json");
}

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

/**
 * LocalWalletDriver: manages a single ethers v6 encrypted keystore file.
 * The decrypted in-memory `Wallet` (and therefore the private key) only
 * ever lives inside this class's private field, never leaves the process,
 * and is never logged.
 */
export class LocalWalletDriver {
  private unlockedWallet: Wallet | null = null;
  private readonly dataDir: string;

  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
  }

  get keystorePath(): string {
    return walletFilePath(this.dataDir);
  }

  hasKeystore(): boolean {
    return fs.existsSync(this.keystorePath);
  }

  isUnlocked(): boolean {
    return this.unlockedWallet !== null;
  }

  /** Publishes a complete encrypted file without ever replacing an existing wallet. */
  private async saveNewWallet(wallet: Wallet | ReturnType<typeof Wallet.createRandom>, password: string): Promise<{ address: string }> {
    if (this.hasKeystore()) throw new Error("Wallet already exists; use a separate data directory for another wallet");
    const json = await wallet.encrypt(password);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = path.join(this.dataDir, `.wallet-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, json, { mode: 0o600, flag: "wx" });
      // link is atomic and fails if another request/process created the destination.
      fs.linkSync(temp, this.keystorePath);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    this.unlockedWallet = new Wallet(wallet.privateKey);
    return { address: wallet.address };
  }

  /** Creates a fresh wallet; secrets never leave the driver in plaintext. */
  async createWallet(password: string): Promise<{ address: string }> {
    return this.saveNewWallet(Wallet.createRandom(), password);
  }

  async importWallet(source: WalletImport, password: string): Promise<{ address: string }> {
    if (this.hasKeystore()) throw new Error("Wallet already exists; import cannot replace it");
    let wallet: Wallet;
    try {
      if (source.kind === "private_key") {
        if (typeof source.private_key !== "string" || !/^(0x)?[a-fA-F0-9]{64}$/.test(source.private_key.trim())) throw new Error();
        wallet = new Wallet(`0x${source.private_key.trim().replace(/^0x/, "")}`);
      } else if (source.kind === "keystore") {
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
        wallet = await Wallet.fromEncryptedJson(source.keystore, source.source_password) as Wallet;
      } else throw new Error();
    } catch {
      // ethers errors can include the supplied private key; never propagate them.
      throw new Error("Invalid wallet import or incorrect backup password");
    }
    return this.saveNewWallet(wallet, password);
  }

  /** An encrypted backup is useful even while locked, but still needs its password. */
  exportKeystore(): string {
    if (!this.hasKeystore()) throw new Error("No wallet to back up");
    return fs.readFileSync(this.keystorePath, "utf-8");
  }

  /** Decrypts the keystore into memory. Throws on wrong password without leaking details. */
  async unlock(password: string): Promise<{ address: string }> {
    if (!this.hasKeystore()) {
      throw new Error("No keystore found; create one first via POST /v1/admin/wallet/create");
    }
    const json = fs.readFileSync(this.keystorePath, "utf-8");
    let wallet: Wallet;
    try {
      wallet = (await Wallet.fromEncryptedJson(json, password)) as Wallet;
    } catch {
      throw new Error("Failed to unlock wallet: invalid password or corrupted keystore");
    }
    this.unlockedWallet = wallet;
    return { address: wallet.address };
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

  /** Reads on-chain USDC balance (micro-USDC, 6 decimals) for the wallet address via RPC. */
  async getUsdcBalance(rpcUrl: string, usdcAddress: string): Promise<bigint> {
    const address = this.getAddress();
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
}
