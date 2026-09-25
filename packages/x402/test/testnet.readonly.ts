/**
 * T3 (SPEC.md §9): the no-funds-needed part of the testnet suite, run via
 * `pnpm test:testnet`. Checked WHENEVER there is network access (does not
 * require MONEYSWITCH_E2E_TESTNET=1, unlike the funded part which is not
 * implemented in v0.1 scope per the task instructions).
 *
 * Asserts:
 *  - RPC eth_chainId == 10143 (0x279f)
 *  - USDC name() == "USDC", version() == "2", decimals() == 6
 * matching packages/x402/src/networks.ts TESTNET config.
 */
import { JsonRpcProvider, Contract } from "ethers";
import { TESTNET } from "../src/networks.js";

const USDC_ABI = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  console.log(`[test:testnet] RPC: ${TESTNET.rpcUrl}`);
  console.log(`[test:testnet] USDC: ${TESTNET.usdcAddress}`);

  const provider = new JsonRpcProvider(TESTNET.rpcUrl);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`[test:testnet] chainId = ${chainId} (0x${chainId.toString(16)})`);
  if (chainId !== 10143) {
    throw new Error(`FAIL: expected chainId 10143, got ${chainId}`);
  }
  console.log("[test:testnet] PASS chainId == 10143");

  const usdc = new Contract(TESTNET.usdcAddress, USDC_ABI, provider);
  const [name, version, decimals] = await Promise.all([
    usdc.name(),
    usdc.version(),
    usdc.decimals(),
  ]);
  console.log(`[test:testnet] USDC name()=${name} version()=${version} decimals()=${decimals}`);

  if (name !== TESTNET.usdcDomainName) {
    throw new Error(`FAIL: expected USDC name "${TESTNET.usdcDomainName}", got "${name}"`);
  }
  if (version !== TESTNET.usdcDomainVersion) {
    throw new Error(`FAIL: expected USDC version "${TESTNET.usdcDomainVersion}", got "${version}"`);
  }
  if (Number(decimals) !== TESTNET.usdcDecimals) {
    throw new Error(`FAIL: expected USDC decimals ${TESTNET.usdcDecimals}, got ${decimals}`);
  }
  console.log("[test:testnet] PASS USDC name/version/decimals match networks.ts");

  if (process.env.MONEYSWITCH_E2E_TESTNET === "1") {
    console.log(
      "[test:testnet] MONEYSWITCH_E2E_TESTNET=1 set, but the funded real-settlement part " +
        "(T3 需资金部分) is out of scope for this task per explicit instructions " +
        "(“不做：...测试网真实付款（M6）”) — skipping."
    );
  } else {
    console.log(
      "[test:testnet] funded part skipped (MONEYSWITCH_E2E_TESTNET != 1, and out of scope per task instructions)."
    );
  }

  console.log("[test:testnet] 判决: 只读部分 PASS");
}

main().catch((err) => {
  console.error(`[test:testnet] 判决: FAIL — ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
