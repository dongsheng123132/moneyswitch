import { createPublicClient, http, type Address, type Hex } from "viem";
import type { AuthorizationReader } from "@moneyswitch/core";
import { getActiveNetwork, type NetworkConfig } from "./networks.js";

/** EIP-3009 `authorizationState(address,bytes32) view returns (bool)` — standard on USDC and compatible tokens. */
const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** EIP-3009 `event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`. */
const AUTHORIZATION_USED_EVENT = {
  type: "event",
  name: "AuthorizationUsed",
  inputs: [
    { name: "authorizer", type: "address", indexed: true },
    { name: "nonce", type: "bytes32", indexed: true },
  ],
} as const;

/** Only used to bound how far back eth_getLogs scans; overridable for other chains via env. */
const DEFAULT_BLOCK_TIME_MS = Number(process.env.MONEYSWITCH_RECONCILE_BLOCK_TIME_MS || 500);
/** Extra safety margin added on top of (now - paymentCreatedAt) when estimating fromBlock. */
const LOOKBACK_MARGIN_MS = 10 * 60 * 1000;
/** Hard cap on how many blocks eth_getLogs is asked to scan in one call, regardless of the estimate above. */
const MAX_LOOKBACK_BLOCKS = 500_000n;

/**
 * v0.5: real on-chain implementation of AuthorizationReader, used by
 * apps/server in production against the active network's RPC endpoint. Tests
 * MUST NOT use this — inject a fake AuthorizationReader instead, so nothing
 * ever calls out to a real (or the running dev testnet :4020/:4021) RPC.
 */
export function createEvmAuthorizationReader(network: NetworkConfig = getActiveNetwork()): AuthorizationReader {
  const client = createPublicClient({ transport: http(network.rpcUrl) });
  const usdcAddress = network.usdcAddress as Address;

  return {
    async authorizationState(authorizer, nonce) {
      const state = await client.readContract({
        address: usdcAddress,
        abi: AUTHORIZATION_STATE_ABI,
        functionName: "authorizationState",
        args: [authorizer as Address, nonce as Hex],
      });
      return Boolean(state);
    },

    async findAuthorizationUsedTx({ authorizer, nonce, paymentCreatedAtMs }) {
      const latestBlock = await client.getBlockNumber();
      const elapsedMs = Math.max(0, Date.now() - paymentCreatedAtMs) + LOOKBACK_MARGIN_MS;
      const estimatedBlocks = BigInt(Math.ceil(elapsedMs / DEFAULT_BLOCK_TIME_MS));
      const lookbackBlocks = estimatedBlocks > MAX_LOOKBACK_BLOCKS ? MAX_LOOKBACK_BLOCKS : estimatedBlocks;
      const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

      const logs = await client.getLogs({
        address: usdcAddress,
        event: AUTHORIZATION_USED_EVENT,
        args: { authorizer: authorizer as Address, nonce: nonce as Hex },
        fromBlock,
        toBlock: latestBlock,
      });

      const log = logs[0];
      return log?.transactionHash ?? null;
    },
  };
}
