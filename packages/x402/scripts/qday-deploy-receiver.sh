#!/usr/bin/env bash
# Deploy QDayPayReceiver to the REAL QDay Aevum testnet and remember the address for the demo scripts.
#
#   bash packages/x402/scripts/qday-deploy-receiver.sh
#
# Needs: the demo wallet to hold a little tQDAY (faucet: https://faucet.qday.info → tQDAY tab).
# Writes: .data/qday-demo/receiver.json  ({"address": "0x…", "txHash": "0x…", "beneficiary": "0x…"})
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RPC="${QDAY_RPC_URL:-https://rpc-test.qday.info}"
WALLET="$REPO/.data/qday-demo/demo-key.json"
OUT="$REPO/.data/qday-demo/receiver.json"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"

[ -f "$WALLET" ] || { echo "missing $WALLET (see docs/qday/live-runbook.md)"; exit 2; }

read -r RELAYER PRIVATE_KEY DEF_BENEFICIARY < <(python3 - "$WALLET" <<'PY'
import json,sys
w=json.load(open(sys.argv[1]))
print(w["payerAndRelayer"]["address"], w["payerAndRelayer"]["privateKey"], w["merchant"]["address"])
PY
)

GAS="$(curl -s -X POST "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$RELAYER\",\"latest\"]}" \
  | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["result"],16))')"
echo "deployer $RELAYER  tQDAY balance: $GAS wei"
if [ "$GAS" -eq 0 ]; then
  echo "no tQDAY: claim it at https://faucet.qday.info (tQDAY tab) for $RELAYER — gas cannot be paid by the facilitator here"
  exit 2
fi

BENEFICIARY="${QDAY_BENEFICIARY:-$DEF_BENEFICIARY}"

cd "$REPO/contracts"
PRIVATE_KEY="$PRIVATE_KEY" OWNER="$RELAYER" BENEFICIARY="$BENEFICIARY" \
  "$FORGE" script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --offline

python3 - "$REPO/contracts/broadcast/Deploy.s.sol/44005/run-latest.json" "$OUT" "$BENEFICIARY" "$RPC" <<'PY'
import json, sys
src, out, beneficiary, rpc = sys.argv[1:5]
d = json.load(open(src))
tx = next(t for t in d["transactions"] if t.get("contractName"))
payload = {"address": tx["contractAddress"], "txHash": tx.get("hash"), "beneficiary": beneficiary,
           "rpc": rpc, "explorer": f"https://explorer-test.qday.info/address/{tx['contractAddress']}"}
json.dump(payload, open(out, "w"), indent=2)
open(out, "a").write("\n")
print(json.dumps(payload, indent=2))
PY
