// fund-vault.mjs — Monad testnet USDC funder (DRY RUN by default)
// Usage: node fund-vault.mjs --to 0x... --amount 2 [--yes]

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  isAddress,
  getAddress,
  erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://testnet-rpc.monad.xyz";
const EXPECTED_CHAIN_ID = 10143;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const USDC_DECIMALS = 6;
const MAX_AMOUNT = "5";

const chain = {
  id: EXPECTED_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

function parseArgs(argv) {
  const args = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") {
      args.to = argv[++i];
    } else if (a === "--amount") {
      args.amount = argv[++i];
    } else if (a === "--yes") {
      args.yes = true;
    }
  }
  return args;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function usage() {
  return "Usage: node fund-vault.mjs --to 0x... --amount 2 [--yes]";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.to) fail(`${usage()}\nMissing --to`);
  if (!args.amount) fail(`${usage()}\nMissing --amount`);
  if (!isAddress(args.to)) fail(`Invalid --to address: ${args.to}`);

  let amountUnit;
  try {
    amountUnit = parseUnits(args.amount, USDC_DECIMALS);
  } catch {
    fail(`Invalid --amount (must be a decimal string, e.g. 2 or 0.01): ${args.amount}`);
  }
  if (amountUnit <= 0n) {
    fail(`--amount must be > 0: ${args.amount}`);
  }
  if (amountUnit > parseUnits(MAX_AMOUNT, USDC_DECIMALS)) {
    fail(`--amount exceeds max ${MAX_AMOUNT} USDC: ${args.amount}`);
  }

  // Read deployer key from ~/.humancli/monad-testnet-deployer.json
  const keyPath = path.join(os.homedir(), ".humancli", "monad-testnet-deployer.json");
  let deployer;
  try {
    deployer = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (e) {
    fail(`Cannot read deployer file ${keyPath}: ${e.message}`);
  }
  const from = deployer.address;
  const privateKey = deployer.privateKey;
  if (!isAddress(from) || typeof privateKey !== "string" || privateKey.length === 0) {
    fail(`Deployer file ${keyPath} has invalid address/privateKey`);
  }
  if (getAddress(args.to) === getAddress(from)) {
    fail("--to must be different from the deployer address");
  }

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  // chainId must be read from RPC; mismatch -> exit 2 immediately
  let chainId;
  try {
    chainId = await publicClient.getChainId();
  } catch (e) {
    fail(`RPC chainId read failed: ${e.message}`);
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    fail(`chainId mismatch: expected ${EXPECTED_CHAIN_ID}, got ${chainId}`);
  }

  const [usdcBalance, monBalance] = await Promise.all([
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [from],
    }),
    publicClient.getBalance({ address: from }),
  ]);

  console.log(`from      : ${getAddress(from)}`);
  console.log(`to        : ${getAddress(args.to)}`);
  console.log(`amount    : ${args.amount} USDC`);
  console.log(`chainId   : ${chainId} (from RPC)`);
  console.log(`from USDC : ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC`);
  console.log(`from MON  : ${formatUnits(monBalance, 18)} MON`);

  if (!args.yes) {
    console.log("DRY RUN，加 --yes 才会发送");
    process.exit(0);
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

  let hash;
  try {
    hash = await walletClient.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(args.to), amountUnit],
    });
  } catch (e) {
    console.error(`transfer failed: ${e.message}`);
    process.exit(1);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`tx hash   : ${hash}`);
  console.log(`status    : ${receipt.status}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`unexpected error: ${e.message}`);
  process.exit(1);
});