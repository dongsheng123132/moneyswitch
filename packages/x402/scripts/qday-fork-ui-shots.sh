#!/usr/bin/env bash
# Screenshot the REAL MoneySwitch dashboard against an anvil fork of QDay Aevum — real token, real contract, real
# payment mechanics, zero faucet. This is how the submission shows the product UI (wallet, budgeted key, bill with tx)
# without spending the robot's faucet tUSD8.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
MEDIA="$REPO/docs/qday/media"
FORK_PORT=8547
MS_PORT=4032
SELLER_PORT=4023
FAC_PORT=4096
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$(mktemp -d)"
DATA="$REPO/.data/qday-demo/ms-fork"
ANVIL="$HOME/.foundry/bin/anvil"; FORGE="$HOME/.foundry/bin/forge"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$PROFILE"; }
trap cleanup EXIT
say() { printf '%s\n' "$*"; }
mkdir -p "$DATA" "$MEDIA" "$REPO/.data/qday-demo"

say "▶ anvil fork of QDay Aevum on :$FORK_PORT"
"$ANVIL" --fork-url https://rpc-test.qday.info --chain-id 44005 --port "$FORK_PORT" --no-rate-limit --silent >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf -m 2 -X POST "http://127.0.0.1:$FORK_PORT" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null 2>&1 && break; sleep 0.25; done
say "✔ fork up"

say "▶ deploying QDayPayReceiver on the fork"
( cd "$REPO/contracts" && PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  BENEFICIARY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 "$FORGE" script script/Deploy.s.sol \
  --rpc-url "http://127.0.0.1:$FORK_PORT" --broadcast --offline >/dev/null 2>&1 )
RECEIVER="$(python3 -c "import json;d=json.load(open('$REPO/contracts/broadcast/Deploy.s.sol/44005/run-latest.json'));print(next(t['contractAddress'] for t in d['transactions'] if t.get('contractName')))")"
say "✔ receiver $RECEIVER"

say "▶ MoneySwitch on :$MS_PORT against the fork"
MONEYSWITCH_DATA_DIR="$DATA" MONEYSWITCH_PORT="$MS_PORT" MONEYSWITCH_NETWORKS=eip155:44005 \
  MONEYSWITCH_DEFAULT_NETWORK=eip155:44005 MONEYSWITCH_PUBLIC_URL="http://127.0.0.1:$MS_PORT" \
  MONEYSWITCH_QDAY_TESTNET_RPC_URL="http://127.0.0.1:$FORK_PORT" \
  node "$REPO/apps/server/dist/index.js" >"$DATA/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$MS_PORT/v1/setup/status" >/dev/null 2>&1 && break; sleep 0.25; done
# The admin token is printed exactly once, ever, on a data dir's first boot. This dir is persistent (the wallet must
# survive), so on every later run rotate one with the documented recovery tool and hand it to the screenshot script.
ADMIN="$(grep -oE 'ms_admin_[A-Za-z0-9_-]+' "$DATA/server.log" | head -1 || true)"
if [ -z "$ADMIN" ]; then
  ADMIN="$(node "$REPO/scripts/admin-reset-token.mjs" --data-dir "$DATA" | grep -oE 'ms_admin_[A-Za-z0-9_-]+' | head -1 || true)"
fi
[ -n "$ADMIN" ] || { say "no admin token (log on first boot prints one, later boots need the reset tool)"; tail -5 "$DATA/server.log"; exit 1; }

WALLET_ADDR="$(curl -s "http://127.0.0.1:$MS_PORT/v1/admin/wallet" -H "authorization: Bearer $ADMIN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("address") or "")')"
if [ -z "$WALLET_ADDR" ]; then
  WALLET_ADDR="$(curl -s -X POST "http://127.0.0.1:$MS_PORT/v1/admin/wallet/create" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' | python3 -c 'import json,sys;print(json.load(sys.stdin)["address"])')"
fi
say "✔ MoneySwitch wallet $WALLET_ADDR"

say "▶ funding it with 50 tUSD8 out of the fork's real holder"
( cd "$REPO/packages/x402" && node --input-type=module - "$WALLET_ADDR" "http://127.0.0.1:$FORK_PORT" <<'JS'
import { createPublicClient, createWalletClient, erc20Abi, http, parseUnits } from "viem";
const [to, rpc] = process.argv.slice(2);
const chain = { id: 44005, name: "fork", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const WHALE = "0x94ef5db164e7bbf4149e298c5588c035ea8e9c05";
const pub = createPublicClient({ chain, transport: http(rpc) });
await pub.request({ method: "anvil_impersonateAccount", params: [WHALE] });
await pub.request({ method: "anvil_setBalance", params: [WHALE, "0xde0b6b3a7640000"] });
const w = createWalletClient({ account: WHALE, chain, transport: http(rpc) });
const hash = await w.writeContract({ address: "0x456569838f1d43009A91ebA4263147Afd7233483", abi: erc20Abi, functionName: "transfer", args: [to, parseUnits("50", 6)], chain });
await pub.waitForTransactionReceipt({ hash });
console.log("  funded", hash);
JS
)

KEY_JSON="$(curl -s -X POST "http://127.0.0.1:$MS_PORT/v1/keys" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"research-agent\",\"total_budget\":\"5\",\"daily_budget\":\"1\",\"per_request_limit\":\"0.05\",\"approval_threshold\":\"0.04\",\"allowed_hosts\":[\"127.0.0.1:$SELLER_PORT\"]}")"
MONEY_KEY="$(printf '%s' "$KEY_JSON" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("key") or "")')"
[ -n "$MONEY_KEY" ] || { say "key failed: $KEY_JSON"; exit 1; }
say "✔ key ${MONEY_KEY:0:12}…"

QDAY_FACILITATOR_PORT="$FAC_PORT" QDAY_RPC_URL="http://127.0.0.1:$FORK_PORT" \
  QDAY_RELAYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 QDAY_RECEIVER_ADDRESS="$RECEIVER" \
  node "$REPO/apps/qday-facilitator/dist/index.js" >"$DATA/fac.log" 2>&1 &
PIDS+=($!)
DEMO_SELLER_PORT="$SELLER_PORT" DEMO_SELLER_PAY_TO="$RECEIVER" DEMO_SELLER_NETWORK=eip155:44005 \
  DEMO_SELLER_FACILITATOR_URL="http://127.0.0.1:$FAC_PORT" node "$REPO/apps/demo-seller/dist/index.js" >"$DATA/seller.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$SELLER_PORT/free" >/dev/null 2>&1 && break; sleep 0.25; done

say "▶ paying 0.01 tUSD8 through /v1/fetch"
curl -s -X POST "http://127.0.0.1:$MS_PORT/v1/fetch" -H "authorization: Bearer $MONEY_KEY" -H 'content-type: application/json' \
  -d "{\"url\":\"http://127.0.0.1:$SELLER_PORT/premium-report\",\"method\":\"GET\",\"max_price\":\"0.01\"}" \
  | tee "$DATA/fetch.json" | python3 -c 'import json,sys;d=json.load(sys.stdin);p=d.get("payment") or {};print("  →",d.get("status"),d.get("charged"),p.get("tx_hash"))'

say "▶ screenshots through the DevTools Protocol"
"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars --remote-debugging-port=9224 \
  --user-data-dir="$PROFILE" about:blank >"$DATA/chrome.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf http://127.0.0.1:9224/json/version >/dev/null 2>&1 && break; sleep 0.25; done
node "$REPO/packages/x402/scripts/qday-dashboard-shots.mjs" --port 9224 --base "http://127.0.0.1:$MS_PORT" \
  --token "$ADMIN" --out "$MEDIA" --pages /wallet,/keys,/bills
say "done"
