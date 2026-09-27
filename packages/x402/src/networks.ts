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
  /** Human-readable name shown in the Dashboard/CLI, e.g. "Monad testnet". */
  label: string;
  /** Block explorer base URL (no trailing slash), e.g. "https://testnet.monadvision.com". */
  explorerBase: string;
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
  label: env("MONEYSWITCH_TESTNET_LABEL", "Monad testnet"),
  explorerBase: env("MONEYSWITCH_TESTNET_EXPLORER_BASE", "https://testnet.monadvision.com"),
};

export const MAINNET: NetworkConfig = {
  caip2: env("MONEYSWITCH_MAINNET_CAIP2", "eip155:143"),
  // Verified 2026-09-27: https://rpc.monad.xyz responds with chainId 0x8f (143).
  rpcUrl: env("MONEYSWITCH_MAINNET_RPC_URL", "https://rpc.monad.xyz"),
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
  label: env("MONEYSWITCH_MAINNET_LABEL", "Monad mainnet"),
  explorerBase: env("MONEYSWITCH_MAINNET_EXPLORER_BASE", "https://monadvision.com"),
};

/** Mainnet is defined but disabled by default (MONEYSWITCH_MAINNET_ENABLED=true opts in); testnet is used otherwise. */
export const MAINNET_ENABLED = env("MONEYSWITCH_MAINNET_ENABLED", "false") === "true";

export function getActiveNetwork(): NetworkConfig {
  if (MAINNET_ENABLED) return MAINNET;
  return TESTNET;
}

/** True when the active network is Monad mainnet (real USDC, real funds). */
export function isMainnet(): boolean {
  return getActiveNetwork() === MAINNET;
}

export const SCHEME = "exact" as const;
