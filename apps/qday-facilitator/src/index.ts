import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { createQDayFacilitator } from "./server.js";

/**
 * `node dist/index.js` — the self-hosted QDay facilitator the network config points at by default
 * (`MONEYSWITCH_QDAY_FACILITATOR_URL`, http://127.0.0.1:4098).
 *
 * Environment:
 * - QDAY_FACILITATOR_PORT  default 4098
 * - QDAY_RPC_URL           default https://rpc-test.qday.info
 * - QDAY_TUSD8_ADDRESS     default the tUSD8 in packages/x402/src/networks.ts
 * - QDAY_RELAYER_KEY       hex private key of the relayer that pays tQDAY gas. Without it the service still verifies
 *                          (read-only mode) but every /settle answers `relayer_not_configured`.
 * - QDAY_RELAYER_KEY_FILE  reads the same key from a file instead (keeps it out of the environment/history).
 * - QDAY_RECEIVER_ADDRESS  the deployed QDayPayReceiver; quotes whose payTo is this contract are settled through
 *                          its pay() so the transfer, the merchant payout and the order record are one transaction.
 */

function loadRelayerKey(): Hex | undefined {
  const direct = process.env.QDAY_RELAYER_KEY?.trim();
  const file = process.env.QDAY_RELAYER_KEY_FILE?.trim();
  const raw = direct || (file ? readFileSync(file, "utf8").trim() : "");
  if (!raw) return undefined;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("[qday-facilitator] QDAY_RELAYER_KEY must be a 32-byte hex private key");
    process.exit(2);
  }
  return key;
}

const port = Number(process.env.QDAY_FACILITATOR_PORT || 4098);
const facilitator = createQDayFacilitator({
  rpcUrl: process.env.QDAY_RPC_URL,
  asset: process.env.QDAY_TUSD8_ADDRESS,
  network: process.env.QDAY_NETWORK,
  relayerKey: loadRelayerKey(),
  receiverAddress: (process.env.QDAY_RECEIVER_ADDRESS as `0x${string}` | undefined) || undefined,
});

await facilitator.app.listen({ port, host: "127.0.0.1" });
console.log(`[qday-facilitator] listening on http://127.0.0.1:${port}`);
console.log(
  facilitator.relayerAddress
    ? `[qday-facilitator] relayer ${facilitator.relayerAddress} — it must hold tQDAY for gas (faucet.qday.info)`
    : "[qday-facilitator] read-only mode: no QDAY_RELAYER_KEY, /verify works and /settle answers relayer_not_configured"
);
console.log("[qday-facilitator] endpoints: GET /supported, GET /health, POST /verify, POST /settle");
