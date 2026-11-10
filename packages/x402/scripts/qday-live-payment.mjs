#!/usr/bin/env node
/**
 * L3 — one REAL tUSD8 payment on the QDay Aevum testnet (chain 44005), through the whole x402 loop.
 *
 * This is the same flow as `qday-x402-fork.mjs`, with two differences that matter for a submission: the RPC is the real
 * network, and the payer and relayer are the demo wallets in `.data/qday-demo/demo-key.json` — so the transaction hash it
 * prints is a real testnet transaction you can open in the explorer. It has to be funded first (faucet is a browser step,
 * see docs/qday/README.md §4): tQDAY for the relayer's gas and at least 0.01 tUSD8 for the payer.
 *
 * Usage:
 *   node packages/x402/scripts/qday-live-payment.mjs                  # M1: pay the merchant address directly
 *   QDAY_RECEIVER=0x… node packages/x402/scripts/qday-live-payment.mjs  # M2: pay through QDayPayReceiver (atomic receipt)
 *
 * Env: QDAY_DEMO_KEY_FILE (default .data/qday-demo/demo-key.json), QDAY_RPC_URL, QDAY_FACILITATOR_PORT, DEMO_SELLER_PORT
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RPC = process.env.QDAY_RPC_URL || "https://rpc-test.qday.info";
const NETWORK = "eip155:44005";
const TUSD8 = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
const EXPLORER = "https://explorer-test.qday.info";
const PORT = {
  facilitator: Number(process.env.QDAY_FACILITATOR_PORT || 4098),
  seller: Number(process.env.DEMO_SELLER_PORT || 4021),
};
const QDAY = {
  id: 44005,
  name: "QDay Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];
const PRICE = parseUnits("0.01", 6); // the demo-seller's /premium-report price

const children = [];
const say = (s = "") => console.log(s);

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk) => {
      for (const l of chunk.split("\n")) if (l.trim()) console.log(`[${name}] ${l}`);
    });
  }
  children.push(child);
}
const stop = () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
};
async function waitFor(url) {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`${url} never answered`);
}

async function main() {
  const keyFile = process.env.QDAY_DEMO_KEY_FILE || `${REPO}/.data/qday-demo/demo-key.json`;
  const wallets = JSON.parse(readFileSync(keyFile, "utf8"));
  const payer = privateKeyToAccount(wallets.payerAndRelayer.privateKey);
  const merchant = getAddress(wallets.merchant.address);
  const receiver = process.env.QDAY_RECEIVER ? getAddress(process.env.QDAY_RECEIVER) : null;
  const payTo = receiver ?? merchant;
  // Through the receiver contract the money lands on its on-chain beneficiary, not on this script's merchant key.
  let beneficiary = merchant;
  if (receiver) {
    try {
      const recorded = JSON.parse(readFileSync(`${REPO}/.data/qday-demo/receiver.json`, "utf8"));
      if (recorded?.beneficiary) beneficiary = getAddress(recorded.beneficiary);
    } catch {
      /* no local record: fall back to the merchant address for the balance assertion */
    }
  }

  const publicClient = createPublicClient({ chain: QDAY, transport: http(RPC) });
  const [chainId, gas, balance] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBalance({ address: payer.address }),
    publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] }),
  ]);
  const merchantBefore = await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [beneficiary] });
  const receiverBefore = receiver
    ? await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [receiver] })
    : 0n;

  say(`network         : chainId ${chainId} (${chainId === 44005 ? "QDay Aevum ✓" : "UNEXPECTED"}) @ ${RPC}`);
  say(`payer/relayer   : ${payer.address}`);
  say(`  tQDAY (gas)   : ${formatUnits(gas, 18)}`);
  say(`  tUSD8         : ${formatUnits(balance, 6)}`);
  say(`payTo           : ${payTo}${receiver ? " (QDayPayReceiver)" : " (merchant, direct)"}`);
  say(`beneficiary     : ${beneficiary} (balance ${formatUnits(merchantBefore, 6)} tUSD8)`);

  // Preflight: say exactly what is missing instead of failing inside a signed payment.
  const problems = [];
  if (chainId !== 44005) problems.push(`RPC reports chainId ${chainId}, expected 44005`);
  if (gas === 0n) problems.push(`relayer ${payer.address} has no tQDAY — claim it at https://faucet.qday.info (tQDAY tab)`);
  if (balance < PRICE) problems.push(`payer has ${formatUnits(balance, 6)} tUSD8, needs ${formatUnits(PRICE, 6)} — claim at https://faucet.qday.info (tUSD8 tab)`);
  if (problems.length) {
    say("");
    say("✗ NOT FUNDED YET (this step needs a human in a browser, see docs/qday/README.md §4):");
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 2;
    return;
  }

  say("");
  say(`▶ starting qday-facilitator on :${PORT.facilitator}`);
  start("facilitator", ["apps/qday-facilitator/dist/index.js"], {
    QDAY_FACILITATOR_PORT: String(PORT.facilitator),
    QDAY_RPC_URL: RPC,
    QDAY_RELAYER_KEY: wallets.payerAndRelayer.privateKey,
    ...(receiver ? { QDAY_RECEIVER_ADDRESS: receiver } : {}),
  });
  await waitFor(`http://127.0.0.1:${PORT.facilitator}/health`);

  say(`▶ starting demo-seller on :${PORT.seller} charging 0.01 tUSD8`);
  start("seller", ["apps/demo-seller/dist/index.js"], {
    DEMO_SELLER_PORT: String(PORT.seller),
    DEMO_SELLER_PAY_TO: payTo,
    DEMO_SELLER_NETWORK: NETWORK,
    DEMO_SELLER_FACILITATOR_URL: `http://127.0.0.1:${PORT.facilitator}`,
  });
  await waitFor(`http://127.0.0.1:${PORT.seller}/free`);

  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(payer) }],
    // tUSD8 is not one of the SDK's default assets for this chain, so the payer opts in explicitly and caps the amount.
    spendControls: { allowedAssets: [{ network: NETWORK, asset: TUSD8, maxAmountPerPayment: PRICE.toString() }] },
  });

  say(`▶ GET /premium-report — paying 0.01 tUSD8 on ${NETWORK}`);
  const res = await paidFetch(`http://127.0.0.1:${PORT.seller}/premium-report`);
  const body = await res.json().catch(() => null);
  const header = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (res.status !== 200) throw new Error(`paid request failed: ${res.status} ${JSON.stringify(body)}`);
  const receipt = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
  const tx = receipt?.transaction;
  if (!tx) throw new Error(`no transaction hash in the receipt: ${JSON.stringify(receipt)}`);

  const [onchain, merchantAfter, payerAfter, receiverAfter] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: tx }),
    publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [beneficiary] }),
    publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] }),
    receiver
      ? publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [receiver] })
      : Promise.resolve(0n),
  ]);

  say("");
  say("─── result ───────────────────────────────────────────────");
  say(`HTTP            : ${res.status} ${JSON.stringify(body)}`);
  say(`receipt         : ${JSON.stringify(receipt)}`);
  say(`tx              : ${tx}`);
  say(`explorer        : ${EXPLORER}/tx/${tx}`);
  say(`on-chain        : block ${onchain.blockNumber}, status ${onchain.status}, logs ${onchain.logs.length}`);
  say(`payer delta     : ${formatUnits(balance - payerAfter, 6)} tUSD8`);
  say(`beneficiary +   : ${formatUnits(merchantAfter - merchantBefore, 6)} tUSD8`);
  if (receiver) {
    say(`receiver balance: ${formatUnits(receiverAfter, 6)} tUSD8 (must be 0 — nothing stranded)`);
    if (receiverAfter !== receiverBefore) throw new Error(`receiver kept tUSD8 — inspect ${EXPLORER}/tx/${tx}`);
    const emitted = onchain.logs.some((l) => l.address.toLowerCase() === receiver.toLowerCase());
    if (!emitted) throw new Error(`no PaymentReceived log from the receiver in ${tx}`);
  }
  if (merchantAfter - merchantBefore !== PRICE) {
    throw new Error(`beneficiary did not receive ${formatUnits(PRICE, 6)} tUSD8 — inspect ${EXPLORER}/tx/${tx}`);
  }
  say("✔ L3 PASS: a real tUSD8 payment settled on QDay Aevum");
  say("──────────────────────────────────────────────────────────");
}

main()
  .catch((error) => {
    console.error(`\n✗ L3 FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(stop);
