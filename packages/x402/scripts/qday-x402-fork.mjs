#!/usr/bin/env node
/**
 * L1 end-to-end for the QDay integration: the WHOLE x402 loop, against a local anvil fork of QDay Aevum.
 *
 * Why a fork: the real chain needs a faucet claim (browser + cooldown) and tQDAY gas, and a CI run must not depend on
 * either. `anvil --fork-url https://rpc-test.qday.info` gives us the REAL tUSD8 contract, its REAL EIP-712 domain and the
 * real balances of the top holder, so the signature that settles here is the signature that would settle on the testnet —
 * only the block production is local.
 *
 * What it proves, in order:
 *   1. a payer signs EIP-3009 `TransferWithAuthorization` for the exact 402 quote (@x402/fetch + @x402/evm, unmodified SDK);
 *   2. our self-hosted facilitator verifies it against the forked token and broadcasts it from a relayer (tQDAY gas);
 *   3. the seller answers 200 with a PAYMENT-RESPONSE receipt carrying the on-chain transaction hash;
 *   4. tUSD8 actually moves: payer -price, merchant +price.
 *
 * Usage: node packages/x402/scripts/qday-x402-fork.mjs          (starts what it needs)
 *        QDAY_FORK_PORT=8546 node ...                          (reuses an anvil already listening there)
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)); // fileURLToPath: the repo path contains 族-research (percent-encoding breaks cwd)
const PORT = {
  fork: Number(process.env.QDAY_FORK_PORT || 8546),
  facilitator: Number(process.env.QDAY_FACILITATOR_PORT || 4098),
  seller: Number(process.env.DEMO_SELLER_PORT || 4021),
};
const RPC = `http://127.0.0.1:${PORT.fork}`;
const NETWORK = "eip155:44005";
/** viem needs a chain object for contract writes (chain ids outside its built-in list). */
const QDAY = {
  id: 44005,
  name: "QDay Aevum testnet (anvil fork)",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const TUSD8 = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
const REAL_HOLDER = getAddress("0x94ef5db164e7bbf4149e298c5588c035ea8e9c05"); // top tUSD8 holder on the real chain

// The standard anvil accounts. Test keys only; they exist because anvil prints them, never in a deployed system.
const ANVIL_KEYS = {
  relayer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  merchant: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  payer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];

const children = [];
const line = (s = "") => console.log(s);

function spawnChild(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so stopChildren() takes the whole tree down
  });
  const tag = `[${name}]`;
  const pipe = (stream, out) =>
    stream.setEncoding("utf8").on("data", (chunk) => {
      for (const l of chunk.split("\n")) if (l.trim()) out(`${tag} ${l}`);
    });
  pipe(child.stdout, console.log);
  pipe(child.stderr, console.error);
  children.push({ name, child });
  return child;
}

function stopChildren() {
  for (const { child } of children.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

async function waitFor(name, url, expectOk = true) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (!expectOk || res.ok) return res;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`${name} never answered on ${url}`);
}

async function main() {
  const publicClient = createPublicClient({ chain: QDAY, transport: http(RPC) });
  const payer = privateKeyToAccount(ANVIL_KEYS.payer);
  const merchant = privateKeyToAccount(ANVIL_KEYS.merchant);
  const relayer = privateKeyToAccount(ANVIL_KEYS.relayer);

  // 0. A fork of QDay Aevum — reuse one that is already up, otherwise start it (and stop it afterwards).
  let weStartedFork = false;
  try {
    await publicClient.getChainId();
  } catch {
    line(`▶ starting anvil fork of QDay Aevum on :${PORT.fork} (real state, local blocks)`);
    spawnChild("anvil", `${process.env.HOME}/.foundry/bin/anvil`, [
      "--fork-url", "https://rpc-test.qday.info",
      "--chain-id", "44005",
      "--port", String(PORT.fork),
      "--no-rate-limit",
      "--silent",
    ]);
    weStartedFork = true;
    await waitFor("anvil", RPC).catch(async () => {
      // anvil answers POST only; fall back to a JSON-RPC probe
      for (let i = 0; i < 120; i++) {
        try {
          await publicClient.getChainId();
          return;
        } catch {
          await sleep(250);
        }
      }
      throw new Error("anvil fork did not come up");
    });
  }
  const chainId = await publicClient.getChainId();
  if (chainId !== 44005) throw new Error(`fork reports chainId ${chainId}, expected 44005`);
  line(`✔ fork ready: chainId ${chainId}, block ${await publicClient.getBlockNumber()}`);

  // 1. Fund the payer with real tUSD8 out of a real holder, on the fork (no faucet, no gas spent on the testnet).
  line(`▶ funding payer ${payer.address} with 50 tUSD8 from ${REAL_HOLDER}`);
  await publicClient.request({ method: "anvil_impersonateAccount", params: [REAL_HOLDER] });
  await publicClient.request({ method: "anvil_setBalance", params: [REAL_HOLDER, "0xde0b6b3a7640000"] });
  const holderWallet = createWalletClient({ account: REAL_HOLDER, chain: QDAY, transport: http(RPC) });
  const fundTx = await holderWallet.writeContract({
    address: TUSD8, abi: ERC20_ABI, functionName: "transfer",
    args: [payer.address, parseUnits("50", 6)],
    chain: QDAY,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  await publicClient.request({ method: "anvil_stopImpersonatingAccount", params: [REAL_HOLDER] });
  line(`✔ payer tUSD8 balance: ${formatUnits(await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] }), 6)}`);

  // 2. The self-hosted QDay facilitator — verifies and settles, paying tQDAY gas from the relayer.
  line(`▶ starting qday-facilitator on :${PORT.facilitator} (relayer ${relayer.address})`);
  spawnChild("facilitator", process.execPath, ["apps/qday-facilitator/dist/index.js"], {
    QDAY_FACILITATOR_PORT: String(PORT.facilitator),
    QDAY_RPC_URL: RPC,
    QDAY_RELAYER_KEY: ANVIL_KEYS.relayer,
  });
  await waitFor("facilitator", `http://127.0.0.1:${PORT.facilitator}/health`);
  const health = await (await fetch(`http://127.0.0.1:${PORT.facilitator}/health`)).json();
  line(`✔ facilitator up: settling=${health.settling}, relayer tQDAY=${health.relayerTQDAY}`);

  // 3. A seller that quotes tUSD8 on QDay (the same demo-seller, one env var away from Monad).
  line(`▶ starting demo-seller on :${PORT.seller} charging 0.01 tUSD8 to ${merchant.address}`);
  spawnChild("seller", process.execPath, ["apps/demo-seller/dist/index.js"], {
    DEMO_SELLER_PORT: String(PORT.seller),
    DEMO_SELLER_PAY_TO: merchant.address,
    DEMO_SELLER_NETWORK: NETWORK,
    DEMO_SELLER_FACILITATOR_URL: `http://127.0.0.1:${PORT.facilitator}`,
  });
  await waitFor("seller", `http://127.0.0.1:${PORT.seller}/free`);
  line("✔ seller up");

  // 4. The unmodified x402 SDK client does the 402 → sign → retry dance.
  const before = {
    payer: await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] }),
    merchant: await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [merchant.address] }),
  };
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(payer) }],
    // The SDK only pre-approves the assets it knows as "default" for a chain; tUSD8 on QDay is not one of them, so the
    // payer opts in explicitly and caps the per-payment amount at the quoted price. (MoneySwitch's own client needs the
    // same opt-in — see docs/qday/ for where it belongs.)
    spendControls: {
      allowedAssets: [{ network: NETWORK, asset: TUSD8, maxAmountPerPayment: parseUnits("0.01", 6).toString() }],
    },
  });
  line(`▶ GET /premium-report (pays 0.01 tUSD8 on ${NETWORK})`);
  const res = await paidFetch(`http://127.0.0.1:${PORT.seller}/premium-report`);
  const body = await res.json().catch(() => null);
  const receiptHeader = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (res.status !== 200) throw new Error(`paid request failed: ${res.status} ${JSON.stringify(body)}`);
  const receipt = receiptHeader ? JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) : null;
  line(`✔ HTTP ${res.status} ${JSON.stringify(body)}`);

  // 5. Prove the money moved on-chain, not just in the header.
  const after = {
    payer: await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address] }),
    merchant: await publicClient.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: "balanceOf", args: [merchant.address] }),
  };
  const paid = after.payer - before.payer;
  const received = after.merchant - before.merchant;
  line("");
  line("─── result ───────────────────────────────────────────────");
  line(`receipt        : ${receipt ? JSON.stringify(receipt) : "(seller sent no PAYMENT-RESPONSE header)"}`);
  line(`payer delta    : ${formatUnits(-paid, 6)} tUSD8 paid`);
  line(`merchant delta : ${formatUnits(received, 6)} tUSD8`);
  if (-paid !== parseUnits("0.01", 6) || received !== -paid) {
    throw new Error(`unexpected balance movement: payer ${paid}, merchant ${received}`);
  }
  const tx = receipt?.transaction ?? null;
  if (!tx || !/^0x[0-9a-f]{64}$/i.test(tx)) throw new Error(`no transaction hash in the receipt: ${JSON.stringify(receipt)}`);
  const onchain = await publicClient.getTransactionReceipt({ hash: tx });
  line(`settle tx      : ${tx}`);
  line(`on-chain       : block ${onchain.blockNumber}, status ${onchain.status}, logs ${onchain.logs.length}`);
  line("✔ L1 PASS: a tUSD8 x402 payment settled through the self-hosted QDay facilitator");
  line("──────────────────────────────────────────────────────────");
}

main()
  .then(() => {
    stopChildren();
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n✗ L1 FAIL: ${error?.message ?? error}`);
    stopChildren();
    process.exit(1);
  });
