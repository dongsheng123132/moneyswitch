#!/usr/bin/env bash
# Produce the demo capture used by render-demo-video.py: the whole x402 loop, through the receiver contract, on an anvil
# fork of QDay Aevum. No faucet, no real money — the token, its EIP-712 domain and the balances are the real chain's.
#
#   bash packages/x402/scripts/qday-capture-fork.sh [out-file]
#
# The output file is a plain log with `#> ` prefixes on the commands, which is exactly what the renderer expects.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-$REPO/docs/qday/media/l1-fork-capture.txt}"
PORT="${QDAY_FORK_PORT:-8546}"
ANVIL="$HOME/.foundry/bin/anvil"
FORGE="$HOME/.foundry/bin/forge"
TMP="$(mktemp -d)"
CAP="$TMP/capture.txt"
FORK_PID=""

say() { printf '%s\n' "$*" | tee -a "$CAP"; }
cmd() { printf '#> %s\n' "$*" | tee -a "$CAP"; }

cleanup() {
  [ -n "$FORK_PID" ] && kill "$FORK_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUT")"
: > "$CAP"

say "MoneySwitch × QDay Aevum testnet (chainId 44005) — tUSD8 x402 payment"
say "L1: the whole loop on an anvil fork of the real chain (no faucet needed)"
say ""

cmd "anvil --fork-url https://rpc-test.qday.info --chain-id 44005 --port $PORT"
"$ANVIL" --fork-url https://rpc-test.qday.info --chain-id 44005 --port "$PORT" --no-rate-limit --silent >/dev/null 2>&1 &
FORK_PID=$!
for _ in $(seq 1 60); do
  curl -sf -m 2 -X POST "http://127.0.0.1:$PORT" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null 2>&1 && break
  sleep 0.5
done
say "fork ready: chainId 44005, block $(curl -s -X POST "http://127.0.0.1:$PORT" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["result"],16))')"
say ""

cmd "forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:$PORT --broadcast"
( cd "$REPO/contracts" && PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  BENEFICIARY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 "$FORGE" script script/Deploy.s.sol \
  --rpc-url "http://127.0.0.1:$PORT" --broadcast --offline >"$TMP/deploy.log" 2>&1 ) || { cat "$TMP/deploy.log" | tee -a "$CAP"; exit 1; }
RECEIVER="$(python3 - "$REPO/contracts/broadcast/Deploy.s.sol/44005/run-latest.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(next(t["contractAddress"] for t in d["transactions"] if t.get("contractName")))
PY
)"
say "QDayPayReceiver deployed at $RECEIVER (beneficiary 0x7099…79C8)"
say ""

cmd "QDAY_RECEIVER=$RECEIVER node packages/x402/scripts/qday-x402-fork.mjs"
( cd "$REPO" && QDAY_FORK_PORT="$PORT" QDAY_RECEIVER="$RECEIVER" node packages/x402/scripts/qday-x402-fork.mjs ) \
  2>&1 | grep -v '^\[\(facilitator\|seller\)\]' | tee -a "$CAP"

cp "$CAP" "$OUT"
printf '\ncapture written to %s\n' "$OUT"
