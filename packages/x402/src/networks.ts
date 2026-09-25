/**
 * Verified external facts (SPEC.md §1, checked 2026-09-25). Every value here
 * can be overridden by an environment variable, but the defaults below are
 * the "already verified" testnet facts — do not change them from memory.
 */

export interface NetworkConfig {
  /** CAIP-2 network id, e.g. "eip155:10143". */
  caip2: string;
  /** JSON-RPC endpoint. */
  rpcUrl: string;
  /** USDC ERC-20 contract address on this network. */
  usdcAddress: string;
  /** EIP-712 domain name for USDC's transferWithAuthorization. */
  usdcDomainName: string;
  /** EIP-712 domain version for USDC's transferWithAuthorization. */
  usdcDomainVersion: string;
  /** USDC decimals (6, read on-chain in T3). */
  usdcDecimals: number;
  /** x402 facilitator base URL. */
  facilitatorUrl: string;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const TESTNET: NetworkConfig = {
  caip2: env("MONEYSWITCH_TESTNET_CAIP2", "eip155:10143"),
  rpcUrl: env("MONEYSWITCH_TESTNET_RPC_URL", "https://testnet-rpc.monad.xyz"),
  usdcAddress: env(
    "MONEYSWITCH_TESTNET_USDC_ADDRESS",
    "0x534b2f3A21130d7a60830c2Df862319e593943A3"
  ),
  usdcDomainName: env("MONEYSWITCH_TESTNET_USDC_NAME", "USDC"),
  usdcDomainVersion: env("MONEYSWITCH_TESTNET_USDC_VERSION", "2"),
  usdcDecimals: Number(env("MONEYSWITCH_TESTNET_USDC_DECIMALS", "6")),
  facilitatorUrl: env(
    "MONEYSWITCH_FACILITATOR_URL",
    "https://x402-facilitator.molandak.org"
  ),
};

export const MAINNET: NetworkConfig = {
  caip2: env("MONEYSWITCH_MAINNET_CAIP2", "eip155:143"),
  rpcUrl: env("MONEYSWITCH_MAINNET_RPC_URL", ""),
  usdcAddress: env(
    "MONEYSWITCH_MAINNET_USDC_ADDRESS",
    "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"
  ),
  usdcDomainName: env("MONEYSWITCH_MAINNET_USDC_NAME", "USDC"),
  usdcDomainVersion: env("MONEYSWITCH_MAINNET_USDC_VERSION", "2"),
  usdcDecimals: Number(env("MONEYSWITCH_MAINNET_USDC_DECIMALS", "6")),
  facilitatorUrl: env(
    "MONEYSWITCH_FACILITATOR_URL",
    "https://x402-facilitator.molandak.org"
  ),
};

/** v0.1: mainnet is defined but disabled by default; only testnet is used unless explicitly enabled. */
export const MAINNET_ENABLED = env("MONEYSWITCH_MAINNET_ENABLED", "false") === "true";

export function getActiveNetwork(): NetworkConfig {
  if (MAINNET_ENABLED) return MAINNET;
  return TESTNET;
}

export const SCHEME = "exact" as const;
