#!/usr/bin/env bash
# REAL TESTNET evidence in one command: MoneySwitch — the actual product, with the persistent wallet that holds the real
# tUSD8 — pays a QDay/tUSD8 API through its own budgeted MoneyKey, and the SAME run screenshots the dashboard that shows
# that payment (wallet balance, the key with its limits, the bill with its on-chain transaction hash).
#
#   bash packages/x402/scripts/qday-ui-shots.sh
#
# Outputs:
#   docs/qday/media/live-product-capture.txt              terminal log of this run (feeds render-demo-video.py)
#   docs/qday/media/dashboard-{wallet,keys,bills}-live.png
#
# The wallet is reused, never re-created: its key lives in the data dir below, so throwing the dir away throws the tUSD8
# with it (that is exactly how 0.04 tUSD8 was stranded once — see docs/qday/live-runbook.md). The funder wallet is only
# touched when this wallet is too poor to pay; normally it needs nothing, because the buyer only signs an EIP-3009
# authorization and the facilitator's relayer pays the tQDAY gas.
#
# Env: QDAY_MS_DATA_DIR   (default .data/qday-demo/moneyswitch)
#      QDAY_MS_ADMIN_TOKEN(only if you kept the token; otherwise the script resets it and never prints it into the log)
#      QDAY_KEY_NAME      (default qday-demo-agent)
#      QDAY_RPC_URL       (default https://rpc-test.qday.info)
#      QDAY_SKIP_PAYMENT=1 re-shoot the dashboard only (no new key, no new payment, the capture file is left alone) —
#                          use it after editing a screenshot, so a cosmetic change never costs another 0.01 tUSD8
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
MEDIA="$REPO/docs/qday/media"
RPC="${QDAY_RPC_URL:-https://rpc-test.qday.info}"
EXPLORER="https://explorer-test.qday.info"
PORT="${MONEYSWITCH_PORT:-4030}"
SELLER_PORT=4022
FAC_PORT=4099
CDP_PORT=9223
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DATA="${QDAY_MS_DATA_DIR:-$REPO/.data/qday-demo/moneyswitch}"
WALLET_FILE="$REPO/.data/qday-demo/demo-key.json"
RECEIVER_FILE="$REPO/.data/qday-demo/receiver.json"
CAP="$MEDIA/live-product-capture.txt"
KEY_NAME="${QDAY_KEY_NAME:-qday-demo-agent}"
SKIP_PAYMENT="${QDAY_SKIP_PAYMENT:-0}"
PROFILE="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$PROFILE" 2>/dev/null || true; }
trap cleanup EXIT
say() { printf '%s\n' "$*"; }
# In QDAY_SKIP_PAYMENT=1 mode the capture file belongs to the paying run that already happened: never append to it.
cap() { if [ "$SKIP_PAYMENT" = "1" ]; then printf '%s\n' "$*"; else printf '%s\n' "$*" | tee -a "$CAP"; fi; }

mkdir -p "$MEDIA" "$DATA"
if [ "$SKIP_PAYMENT" != "1" ]; then
  : > "$CAP"
  cap "MoneySwitch × QDay Aevum testnet (chainId 44005) — 产品级：AI 拿一把有额度的 MoneyKey 调收费接口，钱包在真网付出 tUSD8"
  cap ""
  cap "#> bash packages/x402/scripts/qday-ui-shots.sh"
  cap ""
fi

# ── the chain facts come from the code, not from a copy in this script ───────────────────────────────────────────────
TUSD8="$(cd "$REPO/packages/x402" && node --input-type=module -e \
  'const { QDAY_TESTNET } = await import("./dist/index.js"); console.log(QDAY_TESTNET.usdcAddress);')"
[ -f "$RECEIVER_FILE" ] || { say "missing $RECEIVER_FILE — deploy it first: bash packages/x402/scripts/qday-deploy-receiver.sh"; exit 2; }
RECEIVER="$(python3 -c "import json;print(json.load(open('$RECEIVER_FILE'))['address'])")"
read -r FUNDER FUNDER_KEY < <(python3 - "$WALLET_FILE" <<'PY'
import json,sys
w=json.load(open(sys.argv[1]))
print(w["payerAndRelayer"]["address"], w["payerAndRelayer"]["privateKey"])
PY
)

# One small helper for every chain read/write: balance of an address in tUSD8 (human units) or a transfer.
tusd() { # tusd balance <address>
  ( cd "$REPO/packages/x402" && node --input-type=module - "$1" "$TUSD8" "$RPC" <<'JS'
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
const [addr, token, rpc] = process.argv.slice(2);
const chain = { id: 44005, name: "QDay Aevum testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
console.log(formatUnits(await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [addr] }), 6));
JS
  )
}

# ── 1. the server, on this data dir (its wallet is the one funded with real tUSD8) ───────────────────────────────────
# The admin token is printed exactly once, ever, on a data dir's first boot. Later boots print nothing, so if the token
# was not kept this script rotates it (scripts/admin-reset-token.mjs is the documented recovery path) and keeps it out of
# the capture file — a token in a committed document would be a leak.
ADMIN="${QDAY_MS_ADMIN_TOKEN:-}"
if [ -z "$ADMIN" ]; then
  ADMIN="$(node "$REPO/scripts/admin-reset-token.mjs" --data-dir "$DATA" | grep -oE 'ms_admin_[A-Za-z0-9_-]+' | head -1 || true)"
  [ -n "$ADMIN" ] || { say "✗ could not rotate the admin token for $DATA"; exit 1; }
fi
say "▶ MoneySwitch server on :$PORT (data dir $DATA)"
MONEYSWITCH_DATA_DIR="$DATA" MONEYSWITCH_PORT="$PORT" MONEYSWITCH_NETWORKS=eip155:44005 \
  MONEYSWITCH_DEFAULT_NETWORK=eip155:44005 MONEYSWITCH_PUBLIC_URL="http://127.0.0.1:$PORT" \
  node "$REPO/apps/server/dist/index.js" >"$DATA/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/v1/setup/status" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$PORT/v1/setup/status" >/dev/null || { say "✗ server never came up"; tail -5 "$DATA/server.log"; exit 1; }
say "✔ server up"

WALLET_ADDR="$(curl -s "http://127.0.0.1:$PORT/v1/admin/wallet" -H "authorization: Bearer $ADMIN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("address") or "")')"
if [ -z "$WALLET_ADDR" ]; then
  WALLET_ADDR="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/admin/wallet/create" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' | python3 -c 'import json,sys;print(json.load(sys.stdin)["address"])')"
  say "✔ created MoneySwitch wallet: $WALLET_ADDR"
else
  say "✔ reusing MoneySwitch wallet: $WALLET_ADDR"
fi
BEFORE="$(tusd "$WALLET_ADDR")"
say "  tUSD8 on the wallet: $BEFORE"
cap "MoneySwitch wallet : $WALLET_ADDR  (tUSD8 $BEFORE · the buyer only signs, the relayer pays the gas)"
cap "relayer (facilitator): $FUNDER"
cap ""

# ── 2. funding: only if this wallet really is short (normally it is not) ─────────────────────────────────────────────
if python3 -c "import sys; sys.exit(0 if float('${BEFORE:-0}') < 0.03 else 1)"; then
  say "▶ the wallet is short (${BEFORE:-0} tUSD8) — asking the funder for 0.03"
  ( cd "$REPO/packages/x402" && node --input-type=module - "$FUNDER_KEY" "$WALLET_ADDR" "$TUSD8" "$RPC" <<'JS'
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const [key, to, token, rpc] = process.argv.slice(2);
const chain = { id: 44005, name: "QDay Aevum testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, parseUnits("0.03", 6)], chain });
await pub.waitForTransactionReceipt({ hash });
console.log(`  top-up tx ${hash}`);
JS
  )
  cap "funder topped the wallet up with 0.03 tUSD8"
  BEFORE="$(tusd "$WALLET_ADDR")"
fi

if [ "$SKIP_PAYMENT" != "1" ]; then
# ── 3. a MoneyKey with hard limits — the thing a script-with-a-key does not have ─────────────────────────────────────
# approval_threshold must be <= per_request_limit (the server refuses anything else) and approval is required at
# `amount >= threshold`, so the line sits just above the 0.01 price: the payment goes through, and a pricier call would
# have to be approved by the owner first.
KEY_JSON="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/keys" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"$KEY_NAME\",\"total_budget\":\"0.05\",\"daily_budget\":\"0.05\",\"per_request_limit\":\"0.02\",\"approval_threshold\":\"0.015\",\"allowed_hosts\":[\"127.0.0.1:$SELLER_PORT\"]}")"
MONEY_KEY="$(printf '%s' "$KEY_JSON" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("key") or "")')"
[ -n "$MONEY_KEY" ] || { say "✗ key creation failed: $KEY_JSON"; exit 1; }
say "✔ MoneyKey issued ($KEY_NAME · per-request 0.02 · approval above 0.015 · daily 0.05)"
cap "MoneyKey           : $KEY_NAME  (daily 0.05 · per-request limit 0.02 · 超过 0.015 要人工批准 · host allow-list 127.0.0.1:$SELLER_PORT)"
cap ""

# ── 4. facilitator + seller, both pointed at the real chain and the deployed receiver ────────────────────────────────
say "▶ facilitator :$FAC_PORT, seller :$SELLER_PORT (payTo QDayPayReceiver $RECEIVER)"
QDAY_FACILITATOR_PORT="$FAC_PORT" QDAY_RPC_URL="$RPC" QDAY_RELAYER_KEY="$FUNDER_KEY" QDAY_RECEIVER_ADDRESS="$RECEIVER" \
  node "$REPO/apps/qday-facilitator/dist/index.js" >"$DATA/fac.log" 2>&1 &
PIDS+=($!)
DEMO_SELLER_PORT="$SELLER_PORT" DEMO_SELLER_PAY_TO="$RECEIVER" DEMO_SELLER_NETWORK=eip155:44005 \
  DEMO_SELLER_FACILITATOR_URL="http://127.0.0.1:$FAC_PORT" \
  node "$REPO/apps/demo-seller/dist/index.js" >"$DATA/seller.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$SELLER_PORT/free" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$SELLER_PORT/free" >/dev/null || { say "✗ seller never came up"; tail -5 "$DATA/seller.log"; exit 1; }
say "✔ seller quoting 0.01 tUSD8 on eip155:44005"

# ── 5. the actual payment: one HTTP request through the wallet ──────────────────────────────────────────────────────
cap "#> curl -X POST http://127.0.0.1:$PORT/v1/fetch   # AI 说：我要这个接口，最多 0.01"
cap "▶ POST /v1/fetch  → the AI asks, the wallet pays"
STARTED="$(python3 -c 'import time;print(int(time.time()*1000))')"
PAID="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/fetch" -H "authorization: Bearer $MONEY_KEY" -H 'content-type: application/json' \
  -d "{\"url\":\"http://127.0.0.1:$SELLER_PORT/premium-report\",\"method\":\"GET\",\"max_price\":\"0.01\"}")"
ELAPSED=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - STARTED ))
printf '%s' "$PAID" >"$DATA/fetch.json"
read -r HTTP_STATUS CHARGED TX < <(printf '%s' "$PAID" | python3 -c 'import json,sys
d=json.load(sys.stdin); p=d.get("payment") or {}
print(d.get("http_status") or d.get("status"), d.get("charged"), p.get("tx_hash") or "")')
say "  → $HTTP_STATUS in ${ELAPSED} ms, charged=$CHARGED tx=$TX"
cap "  → $HTTP_STATUS in ${ELAPSED} ms · charged=$CHARGED · network eip155:44005"
[ -n "${TX:-}" ] || { say "✗ no transaction hash — the payment did not settle"; printf '%s\n' "$PAID" | head -c 600; exit 1; }

# ── 6. prove it on-chain: receipt, the key's own history, and the money's path ──────────────────────────────────────
HISTORY="$(curl -s "http://127.0.0.1:$PORT/v1/history" -H "authorization: Bearer $MONEY_KEY")"
RECEIPT="$( cd "$REPO/packages/x402" && node --input-type=module - "$TX" "$RPC" <<'JS'
import { createPublicClient, http } from "viem";
const [tx, rpc] = process.argv.slice(2);
const chain = { id: 44005, name: "QDay Aevum testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const r = await pub.getTransactionReceipt({ hash: tx });
console.log(JSON.stringify({ block: Number(r.blockNumber), status: r.status, logs: r.logs.length }));
JS
)"
AFTER="$(tusd "$WALLET_ADDR")"
RECEIVER_BAL="$(tusd "$RECEIVER")"
say ""
say "─── result ───────────────────────────────────────────────"
say "wallet tUSD8   : $BEFORE → $AFTER"
say "receipt        : $RECEIPT"
say "key history    : $(printf '%s' "$HISTORY" | python3 -c 'import json,sys
d=json.load(sys.stdin); rows=d.get("history") or []
r=rows[0] if rows else {}
print(r.get("status"), r.get("amount"), r.get("tx_hash"))')"
say "receiver bal   : $RECEIVER_BAL tUSD8 (must be 0 — nothing stranded)"
say "explorer       : $EXPLORER/tx/$TX"
cap ""
cap "  wallet tUSD8   : $BEFORE → $AFTER"
cap "  on-chain       : $RECEIPT"
cap "  key history    : $(printf '%s' "$HISTORY" | python3 -c 'import json,sys
d=json.load(sys.stdin); rows=d.get("history") or []
r=rows[0] if rows else {}
print(r.get("status"), r.get("amount"), r.get("tx_hash"))')"
cap "  receiver bal   : $RECEIVER_BAL tUSD8 (nothing stranded in the contract)"
cap "  tx             : $EXPLORER/tx/$TX"
case "$RECEIPT" in *'"status":"success"'*) : ;; *) say "✗ receipt is not success: $RECEIPT"; exit 1 ;; esac
cap ""
cap "✔ 真网付款成功：进 MoneySwitch /v1/history 的是一笔 status=settled 的链上结算，tx 可在 explorer-test.qday.info 查"

fi  # ← end of the paying part (QDAY_SKIP_PAYMENT=1 skips it)

# ── 7. the same run's dashboard, so the UI evidence and the payment are one story ───────────────────────────────────
say ""
say "▶ screenshotting the dashboard (same run, same data dir, same tx)"
"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" about:blank >"$DATA/chrome.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break; sleep 0.25; done
node "$REPO/packages/x402/scripts/qday-dashboard-shots.mjs" --port "$CDP_PORT" --base "http://127.0.0.1:$PORT" \
  --token "$ADMIN" --suffix -live --out "$MEDIA" --pages /wallet,/keys,/bills --width 1440 --height 1240 \
  --click .bills-detail-button --scroll .bills-detail-row

say ""
say "done:"
say "  $CAP"
say "  $MEDIA/dashboard-{wallet,keys,bills}-live.png"
[ -n "${TX:-}" ] && say "  tx $EXPLORER/tx/$TX"
