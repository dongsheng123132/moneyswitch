#!/bin/sh
# Run from the uploaded receiver release directory. PAY_TO is a public address.
set -eu
: "${PAY_TO:?Set PAY_TO to the verified receiving wallet address}"
image=moneyswitch-receiver:mainnet-010
container=moneyswitch-receiver-mainnet
if docker container inspect "$container" >/dev/null 2>&1; then
  echo 'Receiver already exists; inspect before replacing it.' >&2
  exit 1
fi
sha256sum -c SHA256SUMS
docker build -t "$image" .
docker run -d --name "$container" --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 256m --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:4021:4021 -e RECEIVER_PAY_TO="$PAY_TO" "$image"
tries=0
until curl --fail --silent --max-time 3 http://127.0.0.1:4021/healthz; do
  tries=$((tries+1)); test "$tries" -lt 15 || exit 1; sleep 1
done
# Validates Caddy and restores its previous fragment on failure.
sh ./activate-caddy.sh ./moneyswitch.caddy
