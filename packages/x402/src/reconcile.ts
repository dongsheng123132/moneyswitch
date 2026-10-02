import { createPublicClient, http, toHex, type Address, type Hex } from "viem";
import type { AuthorizationReader } from "@moneyswitch/core";
import { getActiveNetwork, type NetworkConfig } from "./networks.js";
import { findAuthorizationUsedTxViaLogs, scanOptionsFromEnv, type LogRpc } from "./authorization-logs.js";

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

/** Adapts a viem public client to the minimal RPC surface the log scanner needs. */
export function createViemLogRpc(client: ReturnType<typeof createPublicClient>): LogRpc {
  return {
    async getLatestBlock() {
      const block = await client.getBlock({ blockTag: "latest" });
      return { number: block.number, timestampSec: Number(block.timestamp) };
    },
    async getBlockTimestampSec(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return Number(block.timestamp);
    },
    async getLogs({ address, fromBlock, toBlock, topics }) {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{ address, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics }],
      } as never)) as Array<{ transactionHash?: string | null; blockNumber?: string | null }>;
      return logs.map((l) => ({
        transactionHash: l.transactionHash ?? null,
        blockNumber: l.blockNumber ? BigInt(l.blockNumber) : null,
      }));
    },
  };
}

/**
 * v0.5: real on-chain implementation of AuthorizationReader, used by
 * apps/server in production against the active network's RPC endpoint. Tests
 * MUST NOT use this — inject a fake AuthorizationReader instead, so nothing
 * ever calls out to a real (or the running dev testnet :4020/:4021) RPC.
 */
export function createEvmAuthorizationReader(network: NetworkConfig = getActiveNetwork()): AuthorizationReader {
  const client = createPublicClient({ transport: http(network.rpcUrl) });
  const usdcAddress = network.usdcAddress as Address;
  const logRpc = createViemLogRpc(client);

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

    async findAuthorizationUsedTx({ authorizer, nonce, paymentCreatedAtMs, validBeforeSec }) {
      // Public RPCs cap eth_getLogs (Monad testnet: 100 blocks), so this scans a
      // bounded, time-derived block window in chunks — see authorization-logs.ts.
      return findAuthorizationUsedTxViaLogs(
        logRpc,
        { usdcAddress: network.usdcAddress, authorizer, nonce, paymentCreatedAtMs, validBeforeSec },
        scanOptionsFromEnv()
      );
    },
  };
}
