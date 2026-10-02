/**
 * Opt-in, read-only check against the REAL Monad testnet RPC (like
 * `pnpm test:testnet`; NOT part of the default test run), run via
 * `pnpm test:incident`.
 *
 * Replays the "paid but no delivery" incident: a MoneySwitch vault
 * (0xFEd3f24cee2B3E2d94ad9f561ead4fEA589Ce2e3) signed an EIP-3009 authorization,
 * the seller settled it in block 66811924 (tx 0x20b9a9edf1...), and reconcile
 * could only say "authorization used" because its single wide eth_getLogs call is
 * rejected by the public RPC ("eth_getLogs is limited to a 100 range").
 *
 * It asserts, using only eth_chainId / eth_getBlockByNumber / eth_getLogs / eth_blockNumber:
 *   1. AuthorizationUsed logs for that authorizer near block 66811924 include a tx
 *      starting 0x20b9a9edf1 (found by raw 100-block chunks);
 *   2. the PRODUCTION lookup (createEvmAuthorizationReader().findAuthorizationUsedTx
 *      -> time window -> block range -> chunked getLogs), given only the payment's
 *      creation time, validBefore and nonce, returns exactly that tx hash, even
 *      though the chain head is ~hundreds of thousands of blocks ahead of it;
 *   3. a different nonce finds nothing (no false positive).
 */
import { createPublicClient, http, toHex } from "viem";
import { TESTNET } from "../src/networks.js";
import { createEvmAuthorizationReader, createViemLogRpc } from "../src/reconcile.js";
import {
  AUTHORIZATION_USED_TOPIC0,
  authorizationUsedTopics,
  findAuthorizationUsedTxViaLogs,
  scanOptionsFromEnv,
  type LogRpc,
} from "../src/authorization-logs.js";

const PAYER = "0xFEd3f24cee2B3E2d94ad9f561ead4fEA589Ce2e3";
const INCIDENT_BLOCK = 66811924n;
const EXPECTED_TX_PREFIX = "0x20b9a9edf1";

interface RawLog {
  transactionHash: string;
  blockNumber: string;
  topics: string[];
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`[test:incident] ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`[test:incident] RPC: ${TESTNET.rpcUrl}`);
  console.log(`[test:incident] USDC: ${TESTNET.usdcAddress}`);
  const client = createPublicClient({ transport: http(TESTNET.rpcUrl) });

  const chainId = await client.getChainId();
  check(chainId === 10143, "chainId == 10143", `got ${chainId}`);

  const head = await client.getBlockNumber();
  const incidentBlock = await client.getBlock({ blockNumber: INCIDENT_BLOCK });
  const blockTs = Number(incidentBlock.timestamp);
  console.log(
    `[test:incident] chain head ${head}; incident block ${INCIDENT_BLOCK} (${head - INCIDENT_BLOCK} blocks behind head) at unix ${blockTs}`
  );

  // 1. raw chunked scan around the incident block, any nonce
  const found: RawLog[] = [];
  const chunk = BigInt(scanOptionsFromEnv().chunkBlocks ?? 100);
  for (let from = INCIDENT_BLOCK - 300n; from <= INCIDENT_BLOCK + 300n; from += chunk) {
    const to = from + chunk - 1n;
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: TESTNET.usdcAddress, fromBlock: toHex(from), toBlock: toHex(to), topics: authorizationUsedTopics(PAYER, null) }],
    } as never)) as RawLog[];
    found.push(...logs);
  }
  for (const l of found) {
    console.log(`[test:incident]   AuthorizationUsed authorizer=${PAYER} block=${BigInt(l.blockNumber)} nonce=${l.topics[2]} tx=${l.transactionHash}`);
  }
  const incident = found.find((l) => l.transactionHash.toLowerCase().startsWith(EXPECTED_TX_PREFIX));
  check(Boolean(incident), `an AuthorizationUsed log for ${PAYER} near block ${INCIDENT_BLOCK} has tx ${EXPECTED_TX_PREFIX}...`, incident?.transactionHash ?? "none found");
  check(found.every((l) => l.topics[0] === AUTHORIZATION_USED_TOPIC0), "all returned logs carry the AuthorizationUsed topic0");
  if (!incident) {
    console.log("[test:incident] 判决: FAIL — incident log not found");
    process.exitCode = 1;
    return;
  }
  const nonce = incident.topics[2];

  // 2. the production reader, driven only by (created time, validBefore, nonce)
  let rpcCalls = 0;
  const base = createViemLogRpc(client);
  const counting: LogRpc = {
    getLatestBlock: () => (rpcCalls++, base.getLatestBlock()),
    getBlockTimestampSec: (n) => (rpcCalls++, base.getBlockTimestampSec(n)),
    getLogs: (p) => (rpcCalls++, base.getLogs(p)),
  };
  // Same code path as createEvmAuthorizationReader().findAuthorizationUsedTx, with call counting.
  const createdAtMs = (blockTs - 25) * 1000; // payment reserved ~25s before the seller's settle tx was mined
  const validBeforeSec = blockTs + 35; // x402 default maxTimeoutSeconds is ~60s after signing
  const viaCounting = await findAuthorizationUsedTxViaLogs(
    counting,
    { usdcAddress: TESTNET.usdcAddress, authorizer: PAYER, nonce, paymentCreatedAtMs: createdAtMs, validBeforeSec },
    scanOptionsFromEnv()
  );
  check(viaCounting === incident.transactionHash, "lookup by (created, validBefore, nonce) returns the incident tx", `${viaCounting} using ${rpcCalls} RPC calls`);
  check(rpcCalls <= (scanOptionsFromEnv().maxRpcCalls ?? 60), "stayed within the RPC call cap", `${rpcCalls} calls`);

  const reader = createEvmAuthorizationReader(TESTNET);
  const viaReader = await reader.findAuthorizationUsedTx({
    authorizer: PAYER,
    nonce,
    paymentCreatedAtMs: createdAtMs,
    validBeforeSec,
  });
  check(viaReader === incident.transactionHash, "createEvmAuthorizationReader().findAuthorizationUsedTx returns the incident tx", String(viaReader));

  // 3. no false positive
  const other = "0x" + "ab".repeat(32);
  const none = await reader.findAuthorizationUsedTx({ authorizer: PAYER, nonce: other, paymentCreatedAtMs: createdAtMs, validBeforeSec });
  check(none === null, "a different nonce finds nothing", String(none));

  console.log(
    failures === 0
      ? `[test:incident] 判决: PASS (incident tx ${incident.transactionHash})`
      : `[test:incident] 判决: FAIL — ${failures} check(s) failed`
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[test:incident] 判决: FAIL — ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
