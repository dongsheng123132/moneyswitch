#!/bin/sh
# Run from the uploaded receiver release directory. PAY_TO is a public address.
# This starts the TESTNET receiver only (0.01 Monad testnet USDC, no real value): it is how people check
# their MoneySwitch setup. There is no mainnet receiver.
set -eu
: "${PAY_TO:?Set PAY_TO to the receiving wallet address (a public address; it only ever receives test USDC)}"
image=moneyswitch-receiver:testnet
container=moneyswitch-receiver-testnet
# The container listens on 4021; Caddy forwards /x402-testnet/* to this loopback port.
host_port=4031
if docker container inspect "$container" >/dev/null 2>&1; then
  echo 'Receiver already exists; inspect before replacing it.' >&2
  exit 1
fi
sha256sum -c SHA256SUMS
docker build -t "$image" .
docker run -d --name "$container" --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 256m --log-opt max-size=10m --log-opt max-file=3 \
  -p "127.0.0.1:${host_port}:4021" -e RECEIVER_MODE=testnet -e RECEIVER_PAY_TO="$PAY_TO" "$image"
tries=0
until curl --fail --silent --max-time 3 "http://127.0.0.1:${host_port}/healthz"; do
  tries=$((tries+1)); test "$tries" -lt 15 || exit 1; sleep 1
done
# Validates Caddy and restores its previous fragment on failure.
sh ./activate-caddy.sh ./moneyswitch.caddy
