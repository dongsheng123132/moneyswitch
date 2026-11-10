#!/usr/bin/env bash
# Screenshot the REAL MoneySwitch dashboard while it pays a QDay/tUSD8 API, so the submission shows the product UI
# (wallet balance, a key with limits, the bill with its on-chain transaction) instead of only terminal output.
#
#   bash packages/x402/scripts/qday-ui-shots.sh
#
# Requires the demo wallet to hold tQDAY + a little tUSD8 (see docs/qday/live-runbook.md). Writes PNGs to
# docs/qday/media/ and leaves nothing running.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
MEDIA="$REPO/docs/qday/media"
RPC="${QDAY_RPC_URL:-https://rpc-test.qday.info}"
PORT=4030
SELLER_PORT=4022
FAC_PORT=4099
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$(mktemp -d)"
# Persistent on purpose: a throw-away data dir throws the wallet key away with it, and any tUSD8 sent to that wallet is
# gone for good. Keeping the dir means the same MoneySwitch wallet is reused and can be topped up once, not per run.
DATA="${QDAY_MS_DATA_DIR:-$REPO/.data/qday-demo/moneyswitch}"
mkdir -p "$DATA"
RECEIVER_FILE="$REPO/.data/qday-demo/receiver.json"
RECEIVER="$(python3 -c "import json;print(json.load(open('$RECEIVER_FILE'))['address'])")"
WALLET="$REPO/.data/qday-demo/demo-key.json"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$PROFILE"; }
trap cleanup EXIT
say() { printf '%s\n' "$*"; }

read -r FUNDER FUNDER_KEY MERCHANT < <(python3 - "$WALLET" <<'PY'
import json,sys
w=json.load(open(sys.argv[1]))
print(w["payerAndRelayer"]["address"], w["payerAndRelayer"]["privateKey"], w["merchant"]["address"])
PY
)

say "▶ starting MoneySwitch on :$PORT (QDay network only)"
MONEYSWITCH_DATA_DIR="$DATA" MONEYSWITCH_PORT="$PORT" MONEYSWITCH_NETWORKS=eip155:44005 \
  MONEYSWITCH_DEFAULT_NETWORK=eip155:44005 MONEYSWITCH_PUBLIC_URL="http://127.0.0.1:$PORT" \
  node "$REPO/apps/server/dist/index.js" >"$DATA/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$PORT/v1/setup/status" >/dev/null 2>&1 && break
  sleep 0.25
done
ADMIN="$(grep -oE 'ms_admin_[A-Za-z0-9_-]+' "$DATA/server.log" | head -1)"
LOGIN="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/login#ms_setup_[A-Za-z0-9_-]+' "$DATA/server.log" | head -1)"
[ -n "$ADMIN" ] && [ -n "$LOGIN" ] || { say "server never printed admin token / login link"; tail -5 "$DATA/server.log"; exit 1; }
say "✔ server up"

EXISTING="$(curl -s "http://127.0.0.1:$PORT/v1/admin/wallet" -H "authorization: Bearer $ADMIN" | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d.get("address") or "")')"
if [ -n "$EXISTING" ]; then
  WALLET_ADDR="$EXISTING"
  say "✔ reusing MoneySwitch wallet: $WALLET_ADDR"
else
  WALLET_ADDR="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/admin/wallet/create" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' | python3 -c 'import json,sys;print(json.load(sys.stdin)["address"])')"
  say "✔ created MoneySwitch wallet: $WALLET_ADDR (data dir $DATA)"
fi
BALANCE="$(curl -s "http://127.0.0.1:$PORT/v1/admin/wallet" -H "authorization: Bearer $ADMIN" | python3 -c 'import json,sys
d=json.load(sys.stdin)
b=(d.get("balances") or {})
v=[x for x in b.values() if isinstance(x,str)]
print(v[0] if v else "0")')"
say "  tUSD8 on the wallet: ${BALANCE:-0}"
if python3 -c "import sys;sys.exit(0 if float('${BALANCE:-0}'.replace('$','').replace('<','')) < 0.011 else 1)" 2>/dev/null; then
  say "▶ topping it up with 0.02 tUSD8"
cd "$REPO/packages/x402"
node --input-type=module - "$FUNDER_KEY" "$WALLET_ADDR" "$RPC" <<'JS'
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const [key, to, rpc] = process.argv.slice(2);
const chain = { id: 44005, name: "QDay Aevum testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const hash = await wallet.writeContract({ address: "0x456569838f1d43009A91ebA4263147Afd7233483", abi: erc20Abi, functionName: "transfer", args: [to, parseUnits("0.02", 6)], chain });
await pub.waitForTransactionReceipt({ hash });
console.log(`  top-up tx ${hash}`);
JS
else
  say "▶ wallet already funded, no top-up needed"
fi
cd "$REPO"

KEY_JSON="$(curl -s -X POST "http://127.0.0.1:$PORT/v1/keys" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"qday-demo-agent\",\"total_budget\":\"0.05\",\"daily_budget\":\"0.05\",\"per_request_limit\":\"0.02\",\"approval_threshold\":\"0.015\",\"allowed_hosts\":[\"127.0.0.1:$SELLER_PORT\"]}")"
MONEY_KEY="$(printf '%s' "$KEY_JSON" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
print(d.get("key") or "")')"
if [ -z "$MONEY_KEY" ]; then
  say "✗ key creation failed: $KEY_JSON"
  exit 1
fi
say "✔ key issued: ${MONEY_KEY:0:12}…"

say "▶ facilitator :$FAC_PORT, seller :$SELLER_PORT"
QDAY_FACILITATOR_PORT="$FAC_PORT" QDAY_RPC_URL="$RPC" QDAY_RELAYER_KEY="$FUNDER_KEY" QDAY_RECEIVER_ADDRESS="$RECEIVER" \
  node "$REPO/apps/qday-facilitator/dist/index.js" >"$DATA/fac.log" 2>&1 &
PIDS+=($!)
DEMO_SELLER_PORT="$SELLER_PORT" DEMO_SELLER_PAY_TO="$RECEIVER" DEMO_SELLER_NETWORK=eip155:44005 \
  DEMO_SELLER_FACILITATOR_URL="http://127.0.0.1:$FAC_PORT" \
  node "$REPO/apps/demo-seller/dist/index.js" >"$DATA/seller.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "http://127.0.0.1:$SELLER_PORT/free" >/dev/null 2>&1 && break; sleep 0.25; done
say "✔ seller up"

say "▶ paying 0.01 tUSD8 through /v1/fetch"
curl -s -X POST "http://127.0.0.1:$PORT/v1/fetch" -H "authorization: Bearer $MONEY_KEY" -H 'content-type: application/json' \
  -d "{\"url\":\"http://127.0.0.1:$SELLER_PORT/premium-report\",\"method\":\"GET\",\"max_price\":\"0.01\"}" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);p=d.get("payment") or {};print("  →", d.get("status"), d.get("charged"), p.get("tx_hash"))'

say "▶ screenshotting the dashboard"
"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --remote-debugging-port=9223 \
  --user-data-dir="$PROFILE" about:blank >"$DATA/chrome.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1 && break; sleep 0.25; done
node "$REPO/packages/x402/scripts/qday-dashboard-shots.mjs" --port 9223 --base "http://127.0.0.1:$PORT" \
  --login "$LOGIN" --out "$MEDIA" --pages /wallet,/keys,/bills
say "done"

