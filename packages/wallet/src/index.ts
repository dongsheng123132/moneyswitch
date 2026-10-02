import { Wallet, JsonRpcProvider, Contract, getAddress, FetchRequest } from "ethers";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Default data directory: $MONEYSWITCH_DATA_DIR or ~/.moneyswitch (or /data inside docker, set via env). */
export function defaultDataDir(): string {
  return process.env.MONEYSWITCH_DATA_DIR || path.join(os.homedir(), ".moneyswitch");
}

export function walletFilePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "wallet.json");
}

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

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

  /** Creates a brand-new random wallet, encrypts it with `password`, writes the keystore. Does NOT accept an imported private key (v0.1 policy). */
  async createWallet(password: string): Promise<{ address: string }> {
    if (this.hasKeystore()) {
      throw new Error("Keystore already exists; v0.1 does not support overwrite/import");
    }
    const wallet = Wallet.createRandom();
    const json = await wallet.encrypt(password);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.keystorePath, json, { mode: 0o600 });
    this.unlockedWallet = new Wallet(wallet.privateKey);
    return { address: wallet.address };
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
    const request = new FetchRequest(rpcUrl);
    request.timeout = 15_000;
    const provider = new JsonRpcProvider(request);
    try {
      const contract = new Contract(usdcAddress, ERC20_ABI, provider);
      return await contract.balanceOf(address) as bigint;
    } finally {
      provider.destroy();
    }
  }
}
