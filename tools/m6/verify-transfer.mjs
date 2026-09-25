// verify-transfer.mjs — verify a Monad testnet USDC transfer from on-chain logs
// Usage: node verify-transfer.mjs --tx 0x... --from 0x... --to 0x... --amount 0.01

import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  parseEventLogs,
  getAddress,
  isAddress,
  erc20Abi,
} from "viem";

const RPC_URL = "https://testnet-rpc.monad.xyz";
const CHAIN_ID = 10143;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const USDC_DECIMALS = 6;

const chain = {
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tx") args.tx = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--amount") args.amount = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.tx) fail("Missing --tx");
  if (!args.from) fail("Missing --from");
  if (!args.to) fail("Missing --to");
  if (!args.amount) fail("Missing --amount");
  if (!isAddress(args.from)) fail(`Invalid --from address: ${args.from}`);
  if (!isAddress(args.to)) fail(`Invalid --to address: ${args.to}`);

  let amountUnit;
  try {
    amountUnit = parseUnits(args.amount, USDC_DECIMALS);
  } catch {
    fail(`Invalid --amount (must be a decimal string, e.g. 0.01): ${args.amount}`);
  }

  const expectedFrom = getAddress(args.from);
  const expectedTo = getAddress(args.to);

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: args.tx });
  } catch (e) {
    console.error(`receipt fetch failed: ${e.message}`);
    process.exit(1);
  }

  if (!receipt) {
    console.error("receipt not found (tx does not exist or is not yet mined)");
    process.exit(1);
  }

  // Only USDC-contract logs are relevant; decode Transfer events.
  const usdcLogs = receipt.logs.filter(
    (log) => log.address && getAddress(log.address) === getAddress(USDC),
  );

  let transfers = [];
  try {
    transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: usdcLogs,
    });
  } catch (e) {
    console.error(`failed to parse Transfer events: ${e.message}`);
    process.exit(1);
  }

  console.log(`receipt.status : ${receipt.status}`);
  console.log(`block number   : ${receipt.blockNumber}`);
  console.log(`USDC Transfers : ${transfers.length}`);

  let matched = false;
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const from = getAddress(t.args.from);
    const to = getAddress(t.args.to);
    const value = t.args.value;
    console.log(
      `  Transfer #${i + 1}: from=${from} to=${to} value=${value.toString()} (${formatUnits(value, USDC_DECIMALS)} USDC)`,
    );
    if (from === expectedFrom && to === expectedTo && value === amountUnit) {
      matched = true;
    }
  }

  if (matched) {
    console.log("MATCH");
    process.exit(0);
  } else {
    console.log("NO_MATCH");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`unexpected error: ${e.message}`);
  process.exit(1);
});