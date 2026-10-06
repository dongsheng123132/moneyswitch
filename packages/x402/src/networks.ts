/**
 * Verified external facts (SPEC.md §1, checked 2026-09-25). Every value here
 * can be overridden by an environment variable, but the defaults below are
 * the "already verified" testnet facts — do not change them from memory.
 */

import { chainNetworkMode, type MoneyKeyRow, type NetworkMode } from "@moneyswitch/core";

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
  /** Whether this chain moves real money ("mainnet") or test tokens with no value ("testnet"). Decides which keys may pay on it (SPEC.md §1). */
  kind: NetworkMode;
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
  kind: "testnet",
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
  kind: "mainnet",
  label: env("MONEYSWITCH_MAINNET_LABEL", "Monad mainnet"),
  explorerBase: env("MONEYSWITCH_MAINNET_EXPLORER_BASE", "https://monadvision.com"),
};

/** Mainnet is defined but disabled by default (MONEYSWITCH_MAINNET_ENABLED=true opts in); testnet is used otherwise. */
export const MAINNET_ENABLED = env("MONEYSWITCH_MAINNET_ENABLED", "false") === "true";

/** Circle-issued USDC, verified against https://developers.circle.com/stablecoins/usdc-contract-addresses. */
export const BASE: NetworkConfig = {
  caip2: "eip155:8453",
  rpcUrl: env("MONEYSWITCH_BASE_RPC_URL", "https://mainnet.base.org"),
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdcDomainName: "USD Coin", usdcDomainVersion: "2", usdcDecimals: 6,
  facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
  kind: "mainnet", label: "Base mainnet", explorerBase: "https://basescan.org",
};

export const BASE_SEPOLIA: NetworkConfig = {
  caip2: "eip155:84532",
  rpcUrl: env("MONEYSWITCH_BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  usdcDomainName: "USDC", usdcDomainVersion: "2", usdcDecimals: 6,
  facilitatorUrl: "https://x402.org/facilitator",
  kind: "testnet", label: "Base Sepolia", explorerBase: "https://sepolia.basescan.org",
};

export const NETWORKS: Readonly<Record<string, NetworkConfig>> = Object.freeze(
  Object.fromEntries([TESTNET, MAINNET, BASE, BASE_SEPOLIA].map((n) => [n.caip2, n]))
);

export function getNetwork(caip2: string): NetworkConfig {
  const network = NETWORKS[caip2];
  if (!network) throw new Error(`Unsupported payment network: ${caip2}`);
  return network;
}

/** Explicit list is also the operator's opt-in to any mainnet in it; legacy installations keep their old network. */
export function getEnabledNetworks(): NetworkConfig[] {
  const raw = process.env.MONEYSWITCH_NETWORKS;
  if (raw === undefined) return [MAINNET_ENABLED ? MAINNET : TESTNET];
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("MONEYSWITCH_NETWORKS must name at least one CAIP-2 network");
  return ids.map(getNetwork);
}

/**
 * The enabled networks a key of one network type may pay on (SPEC.md §1, §6): the instance's enabled networks (MONEYSWITCH_NETWORKS order
 * kept) of that kind. null = a key with no type (issued before v0.7.2): where the instance enables one kind only, every enabled network, as
 * it always was; where it enables BOTH kinds, the testnets only, so that enabling a mainnet never lets an old key spend real money.
 */
export function getEnabledNetworksFor(mode: NetworkMode | null): NetworkConfig[] {
  const enabled = getEnabledNetworks();
  if (mode !== null) return enabled.filter((n) => n.kind === mode);
  const hasMainnet = enabled.some((n) => n.kind === "mainnet");
  return hasMainnet && enabled.some((n) => n.kind === "testnet") ? enabled.filter((n) => n.kind === "testnet") : enabled;
}

/**
 * The enabled networks a key may pay on, from its chain [key, parent, ..., root] read fresh (SPEC.md §6): the type is the first one set
 * from the key upwards, so a key without a type follows its parent; two different types in one chain leave the key no network at all.
 * This is the one place a key's chains are worked out: payments, GET /v1/status and the admin views all use it.
 */
export function getEnabledNetworksForChain(chain: readonly MoneyKeyRow[]): NetworkConfig[] {
  const type = chainNetworkMode(chain);
  return type.conflict ? [] : getEnabledNetworksFor(type.mode);
}

export function getActiveNetwork(): NetworkConfig {
  const networks = getEnabledNetworks();
  const requested = process.env.MONEYSWITCH_DEFAULT_NETWORK;
  if (!requested) return networks[0];
  const network = networks.find((n) => n.caip2 === requested);
  if (!network) throw new Error("MONEYSWITCH_DEFAULT_NETWORK must be enabled in MONEYSWITCH_NETWORKS");
  return network;
}

/** True when the active network is Monad mainnet (real USDC, real funds). */
export function isMainnet(): boolean {
  return isMainnetNetwork(getActiveNetwork());
}

export function isMainnetNetwork(network: NetworkConfig): boolean {
  return network.kind === "mainnet";
}

export const SCHEME = "exact" as const;
