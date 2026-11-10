#!/usr/bin/env node
/**
 * L3+ — the PRODUCT demo: MoneySwitch itself pays a QDay/tUSD8 API on the real testnet.
 *
 * The fork script proves the protocol; this one proves the thing you actually ship: a MoneySwitch server with its own
 * wallet and a MoneyKey, an AI-style HTTP call to `/v1/fetch`, a 402 from a QDay seller, a real tUSD8 settlement, and the
 * payment — with its transaction hash — showing up in the key's own history.
 *
 * The MoneySwitch wallet never needs tQDAY: the buyer only signs an EIP-3009 authorization, and the facilitator's relayer
 * pays the gas. So funding this script needs just one thing: tUSD8 in the demo wallet, which then tops up the MoneySwitch
 * wallet. (Faucet steps: docs/qday/README.md §4.)
 *
 * Usage: node packages/x402/scripts/qday-product-demo.mjs
 * Env:   QDAY_DEMO_KEY_FILE, QDAY_RPC_URL, QDAY_RECEIVER (optional: pay through QDayPayReceiver),
 *        MONEYSWITCH_PORT (default 4020), DEMO_SELLER_PORT (4021), QDAY_FACILITATOR_PORT (4098)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RPC = process.env.QDAY_RPC_URL || "https://rpc-test.qday.info";
const TUSD8 = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
const EXPLORER = "https://explorer-test.qday.info";
const MS_PORT = Number(process.env.MONEYSWITCH_PORT || 4020);
const SELLER_PORT = Number(process.env.DEMO_SELLER_PORT || 4021);
const FAC_PORT = Number(process.env.QDAY_FACILITATOR_PORT || 4098);
const PRICE = parseUnits("0.01", 6); // 0.01 tUSD8, the seller's /premium-report price
const QDAY = {
  id: 44005,
  name: "QDay Aevum testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const children = [];
const say = (s = "") => console.log(s);

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.setEncoding("utf8").on("data", (d) => {
    for (const l of d.split("\n")) if (l.trim()) console.log(`[${name}] ${l}`);
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    for (const l of d.split("\n")) if (l.trim()) console.error(`[${name}] ${l}`);
  });
  children.push(child);
  return child;
}
const stop = () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
};
async function waitFor(url) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return res;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`${url} never answered`);
}
async function jsonCall(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  const keyFile = process.env.QDAY_DEMO_KEY_FILE || `${REPO}/.data/qday-demo/demo-key.json`;
  const wallets = JSON.parse(readFileSync(keyFile, "utf8"));
  const funder = privateKeyToAccount(wallets.payerAndRelayer.privateKey);
  const merchant = getAddress(wallets.merchant.address);
  const receiver = process.env.QDAY_RECEIVER ? getAddress(process.env.QDAY_RECEIVER) : null;
  const payTo = receiver ?? merchant;
  const publicClient = createPublicClient({ chain: QDAY, transport: http(RPC) });

  const funderTusd8 = await publicClient.readContract({
    address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [funder.address],
  });
  say(`funder        : ${funder.address} (${formatUnits(funderTusd8, 6)} tUSD8)`);
  if (funderTusd8 < parseUnits("0.02", 6)) {
    say("");
    say("✗ NOT FUNDED YET — the demo wallet needs ≥0.02 tUSD8 (0.01 to top up the MoneySwitch wallet, 0.01 to pay).");
    say("  Claim 1 tUSD8 at https://faucet.qday.info (tUSD8 tab, Trellis email sign-in) and send it to:");
    say(`    ${funder.address}`);
    say("  Details: docs/qday/README.md §4");
    process.exitCode = 2;
    return;
  }

  // 1. A throwaway MoneySwitch instance, so the demo never touches a real deployment.
  const dataDir = mkdtempSync(join(tmpdir(), "moneyswitch-qday-"));
  say(`▶ MoneySwitch server on :${MS_PORT} (data dir ${dataDir})`);
  const server = start("server", ["apps/server/dist/index.js"], {
    MONEYSWITCH_DATA_DIR: dataDir,
    MONEYSWITCH_PORT: String(MS_PORT),
    MONEYSWITCH_NETWORKS: "eip155:44005",
    MONEYSWITCH_DEFAULT_NETWORK: "eip155:44005",
    MONEYSWITCH_PUBLIC_URL: `http://127.0.0.1:${MS_PORT}`,
  });
  let adminToken = null;
  server.stdout.on("data", (chunk) => {
    const match = /(ms_admin_[A-Za-z0-9_-]+)/.exec(chunk);
    if (match && !adminToken) adminToken = match[1];
  });
  await waitFor(`http://127.0.0.1:${MS_PORT}/v1/setup/status`);
  for (let i = 0; i < 80 && !adminToken; i++) await sleep(250);
  if (!adminToken) throw new Error("the server never printed an admin token");
  const admin = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

  // 2. MoneySwitch's own wallet, then top it up with tUSD8 from the demo wallet.
  const created = await jsonCall(`http://127.0.0.1:${MS_PORT}/v1/admin/wallet/create`, { method: "POST", headers: admin });
  if (created.status !== 200) throw new Error(`wallet create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const walletAddress = getAddress(created.body.address);
  say(`✔ MoneySwitch wallet: ${walletAddress}`);

  const funderWallet = createWalletClient({ account: funder, chain: QDAY, transport: http(RPC) });
  const topUp = await funderWallet.writeContract({
    address: TUSD8, abi: erc20Abi, functionName: "transfer", args: [walletAddress, parseUnits("0.01", 6)], chain: QDAY,
  });
  await publicClient.waitForTransactionReceipt({ hash: topUp });
  say(`✔ topped up 0.01 tUSD8 → ${EXPLORER}/tx/${topUp}`);

  // 3. A MoneyKey with a hard per-request limit — the thing that makes this different from "a script with a key".
  const keyRes = await jsonCall(`http://127.0.0.1:${MS_PORT}/v1/keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      name: "qday-demo-agent",
      total_budget: "0.05",
      daily_budget: "0.05",
      per_request_limit: "0.01",
      allowed_hosts: [`127.0.0.1:${SELLER_PORT}`],
    }),
  });
  if (keyRes.status !== 200) throw new Error(`key create failed: ${keyRes.status} ${JSON.stringify(keyRes.body)}`);
  const moneyKey = keyRes.body.key ?? keyRes.body.secret ?? keyRes.body.money_key;
  if (!moneyKey) throw new Error(`no key in the response: ${JSON.stringify(keyRes.body)}`);
  say(`✔ MoneyKey issued (per-request limit 0.01 tUSD8)`);

  // 4. Facilitator + seller quoting QDay/tUSD8.
  say(`▶ facilitator :${FAC_PORT}, seller :${SELLER_PORT} (payTo ${payTo})`);
  start("facilitator", ["apps/qday-facilitator/dist/index.js"], {
    QDAY_FACILITATOR_PORT: String(FAC_PORT),
    QDAY_RPC_URL: RPC,
    QDAY_RELAYER_KEY: wallets.payerAndRelayer.privateKey,
    ...(receiver ? { QDAY_RECEIVER_ADDRESS: receiver } : {}),
  });
  await waitFor(`http://127.0.0.1:${FAC_PORT}/health`);
  start("seller", ["apps/demo-seller/dist/index.js"], {
    DEMO_SELLER_PORT: String(SELLER_PORT),
    DEMO_SELLER_PAY_TO: payTo,
    DEMO_SELLER_NETWORK: "eip155:44005",
    DEMO_SELLER_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  });
  await waitFor(`http://127.0.0.1:${SELLER_PORT}/free`);

  // 5. The AI's call: one HTTP request through the wallet, paid in tUSD8 on QDay.
  say("▶ POST /v1/fetch (the AI asks; the wallet pays)");
  const started = Date.now();
  const paid = await jsonCall(`http://127.0.0.1:${MS_PORT}/v1/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${moneyKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${SELLER_PORT}/premium-report`, method: "GET", max_price: "0.01" }),
  });
  say(`  → ${paid.status} in ${Date.now() - started} ms: ${JSON.stringify(paid.body).slice(0, 400)}`);

  const history = await jsonCall(`http://127.0.0.1:${MS_PORT}/v1/history`, {
    headers: { authorization: `Bearer ${moneyKey}` },
  });
  const rows = Array.isArray(history.body) ? history.body : history.body?.payments ?? history.body?.data ?? [];
  const tx = rows.find?.((r) => /^0x[0-9a-fA-F]{64}$/.test(r.tx_hash ?? r.txHash ?? r.transaction ?? "")) ;
  const txHash = tx ? (tx.tx_hash ?? tx.txHash ?? tx.transaction) : null;

  const walletAfter = await publicClient.readContract({
    address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress],
  });
  say("");
  say("─── result ───────────────────────────────────────────────");
  say(`MoneySwitch wallet tUSD8 after payment: ${formatUnits(walletAfter, 6)} (was 0.01)`);
  say(`key history rows                      : ${rows.length}`);
  if (txHash) say(`settlement tx                         : ${EXPLORER}/tx/${txHash}`);
  say(JSON.stringify(rows.slice(0, 2), null, 2).slice(0, 1200));
  if (paid.status !== 200) throw new Error(`/v1/fetch failed: ${paid.status} ${JSON.stringify(paid.body)}`);
  if (!txHash) throw new Error("no transaction hash in the key history — the payment did not settle on-chain");
  say("");
  say(`tx: ${EXPLORER}/tx/${txHash}`);
  say("✔ PRODUCT DEMO PASS: MoneySwitch paid a QDay tUSD8 API and recorded the on-chain receipt");
  say("──────────────────────────────────────────────────────────");
}

main()
  .catch((error) => {
    console.error(`\n✗ PRODUCT DEMO FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(stop);
