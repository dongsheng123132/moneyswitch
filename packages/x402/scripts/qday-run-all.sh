#!/usr/bin/env bash
# One command, from a funded demo wallet to the submission assets:
#   deploy QDayPayReceiver on the real testnet → pay a tUSD8 API through it → screenshot the transaction →
#   render the demo video.
#
#   bash packages/x402/scripts/qday-run-all.sh
#
# Prerequisite (human, once): the demo wallet holds tQDAY (gas) and ≥0.02 tUSD8.
# See docs/qday/README.md §4. Everything else here is automatic.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MEDIA="$REPO/docs/qday/media"
WALLET="$REPO/.data/qday-demo/demo-key.json"
RECEIVER_FILE="$REPO/.data/qday-demo/receiver.json"
RPC="${QDAY_RPC_URL:-https://rpc-test.qday.info}"
CAP="$MEDIA/live-capture.txt"
say() { printf '%s\n' "$*"; }

mkdir -p "$MEDIA"
[ -f "$WALLET" ] || { say "missing $WALLET — see docs/qday/live-runbook.md"; exit 2; }

# 0. where the money ends up: the generated merchant by default, or QDAY_BENEFICIARY=0x… if set
if [ -n "${QDAY_BENEFICIARY:-}" ]; then say "merchant (beneficiary): ${QDAY_BENEFICIARY}"; fi

# 1. deploy (idempotent: reuse the address we already deployed)
if [ -f "$RECEIVER_FILE" ]; then
  RECEIVER="$(python3 -c "import json,sys;print(json.load(open('$RECEIVER_FILE'))['address'])")"
  say "reusing receiver $RECEIVER"
else
  bash "$REPO/packages/x402/scripts/qday-deploy-receiver.sh" || exit 2
  RECEIVER="$(python3 -c "import json;print(json.load(open('$RECEIVER_FILE'))['address'])")"
fi

# 2. the payment, captured for the video
: > "$CAP"
{
  echo "MoneySwitch × QDay Aevum testnet (chainId 44005) — a real tUSD8 payment"
  echo "payTo = QDayPayReceiver $RECEIVER (atomic: receive → pay merchant → record order)"
  echo ""
  echo "#> QDAY_RECEIVER=$RECEIVER node packages/x402/scripts/qday-live-payment.mjs"
} >> "$CAP"
( cd "$REPO" && QDAY_RECEIVER="$RECEIVER" node packages/x402/scripts/qday-live-payment.mjs ) \
  2>&1 | tee "$MEDIA/live-console.log" | grep -v '^\[\(facilitator\|seller\|server\)\]' >> "$CAP"
TX="$(grep -oE 'https://explorer-test\.qday\.info/tx/0x[0-9a-f]{64}' "$CAP" | tail -1 || true)"
say "capture: $CAP"
[ -n "$TX" ] || { say "no transaction in the capture — see $MEDIA/live-console.log"; exit 1; }

# 3. a screenshot of the real transaction page (headless; no desktop recording needed)
STILL="$MEDIA/live-tx.png"
if [ -x "$CHROME" ]; then
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars --virtual-time-budget=15000 \
    --screenshot="$STILL" --window-size=1280,1000 "$TX" >/dev/null 2>&1 || true
  [ -s "$STILL" ] && say "screenshot: $STILL" || say "screenshot failed (the video will skip the still)"
fi

# 4. video
STILL_ARG=()
[ -s "$STILL" ] && STILL_ARG=(--still "$STILL" --still-caption "$TX")
python3 "$REPO/packages/x402/scripts/render-demo-video.py" \
  --input "$CAP" \
  --title "MoneySwitch × QDay Aevum — paying an API in tUSD8" \
  --subtitle "real testnet payment · EIP-3009 · settled through QDayPayReceiver" \
  --endcard "tx ${TX##*/} · merchant +0.01 tUSD8 · receiver balance 0" \
  --line-hold 0.5 "${STILL_ARG[@]}" \
  --out "$MEDIA/demo-qday-live.mp4"
say ""
say "done: $MEDIA/demo-qday-live.mp4"
