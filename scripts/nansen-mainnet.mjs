#!/usr/bin/env node
/**
 * Pays Nansen's x402 token-screener endpoint through a running MoneySwitch
 * server, using REAL USDC on Monad mainnet (docs/nansen-mainnet.md has the
 * full runbook). This script does NOT start any service and does NOT touch
 * the wallet directly — it only calls POST /v1/fetch on an already-running
 * server, the same way any other agent would.
 *
 * Verified 2026-09-27: Nansen's 402 response for
 * POST https://api.nansen.ai/api/v1/token-screener lists
 * accepts {scheme:"exact", network:"eip155:143", asset:USDC, amount:"10000"
 * ($0.01), extra:{name:"USDC",version:"2"}}, facilitator Molandak (same as
 * ours).
 *
 * Usage:
 *   MONEYSWITCH_URL=http://127.0.0.1:4020 MONEYKEY=mk_live_... \
 *     node scripts/nansen-mainnet.mjs [--endpoint token-screener] [--chains monad] [--timeframe 24h] [--dry]
 */
const NANSEN_BASE = "https://api.nansen.ai/api/v1";
const EXPLORER_TX_BASE = "https://monadvision.com/tx/";

function parseArgs(argv) {
  const args = { endpoint: "token-screener", chains: "monad", timeframe: "24h", dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--chains") args.chains = argv[++i];
    else if (a === "--timeframe") args.timeframe = argv[++i];
    else if (a === "--dry") args.dry = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const moneySwitchUrl = (process.env.MONEYSWITCH_URL || "http://127.0.0.1:4020").replace(/\/+$/, "");
const moneyKey = process.env.MONEYKEY;

if (!args.dry && !moneyKey) {
  console.error(
    "MONEYKEY is required (a mk_live_... MoneyKey, see docs/nansen-mainnet.md) — refusing to run without one, " +
      "since this path can move real mainnet USDC. Example:\n" +
      "  MONEYSWITCH_URL=http://127.0.0.1:4020 MONEYKEY=mk_live_xxx node scripts/nansen-mainnet.mjs"
  );
  process.exit(1);
}

const nansenUrl = `${NANSEN_BASE}/${args.endpoint}`;

const requestBody = {
  url: nansenUrl,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { chains: [args.chains], timeframe: args.timeframe },
  max_price: "0.01",
};

if (args.dry) {
  console.log("[nansen:mainnet] --dry: would POST to", `${moneySwitchUrl}/v1/fetch`);
  console.log("[nansen:mainnet] Authorization: Bearer <MONEYKEY> (redacted)");
  console.log("[nansen:mainnet] request body:");
  console.log(JSON.stringify(requestBody, null, 2));
  process.exit(0);
}

async function main() {
  console.log(`[nansen:mainnet] calling Nansen ${args.endpoint} via ${moneySwitchUrl}/v1/fetch (REAL Monad mainnet USDC)...`);
  const res = await fetch(`${moneySwitchUrl}/v1/fetch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${moneyKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const envelope = await res.json().catch(() => null);
  if (!envelope) {
    console.error(`[nansen:mainnet] server returned non-JSON response (http ${res.status})`);
    process.exit(1);
  }

  console.log(`[nansen:mainnet] http status: ${res.status}`);
  console.log(`[nansen:mainnet] status: ${envelope.status}  code: ${envelope.code ?? "-"}`);
  console.log(`[nansen:mainnet] upstream http_status: ${envelope.http_status ?? "-"}`);

  if (envelope.code === "PAYMENT_REJECTED") {
    console.log(`[nansen:mainnet] seller rejected our signed payment: ${envelope.reason ?? "(no reason given)"}`);
    console.log(
      "[nansen:mainnet] budget is HELD, not lost: the signed EIP-3009 authorization stays valid for ~5 minutes " +
        "(validBefore); if Nansen never settles it, MoneySwitch's on-chain reconcile loop releases the held budget " +
        "automatically once it expires."
    );
  }

  if (envelope.payment) {
    const p = envelope.payment;
    console.log("[nansen:mainnet] payment:");
    console.log(`  amount: ${p.amount ?? "-"} USDC`);
    if (p.tx_hash) {
      console.log(`  tx hash: ${p.tx_hash}`);
      console.log(`  explorer: ${EXPLORER_TX_BASE}${p.tx_hash}`);
    } else {
      console.log("  tx hash: (none yet — see remaining/status above)");
    }
  }

  console.log(
    `[nansen:mainnet] remaining budget: today=${envelope.remaining_today ?? "?"} USDC total=${envelope.remaining_total ?? "?"} USDC`
  );

  printTopTokens(envelope.body);

  if (envelope.status !== "ok") {
    process.exitCode = 1;
  }
}

/** Best-effort, defensive summary of the top ~5 tokens from Nansen's response body. */
function printTopTokens(body) {
  let data = body;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      console.log("[nansen:mainnet] response body is not JSON, skipping summary.");
      return;
    }
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
  if (!rows) {
    console.log("[nansen:mainnet] no `data` array found in the response body — nothing to summarize.");
    return;
  }
  console.log(`[nansen:mainnet] top ${Math.min(5, rows.length)} of ${rows.length} tokens:`);
  for (const row of rows.slice(0, 5)) {
    if (!row || typeof row !== "object") continue;
    const symbol = row.symbol ?? row.token_symbol ?? row.ticker ?? "?";
    const name = row.name ?? row.token_name ?? "";
    const price = row.price ?? row.price_usd ?? row.priceUsd ?? "?";
    const volume = row.volume ?? row.volume_24h ?? row.volume24h ?? row.volumeUsd ?? "?";
    console.log(`  ${symbol}${name ? ` (${name})` : ""}: price=${price} volume=${volume}`);
  }
}

main().catch((err) => {
  console.error("[nansen:mainnet] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
