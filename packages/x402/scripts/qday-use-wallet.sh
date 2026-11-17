#!/usr/bin/env bash
# Point the QDay demo scripts at a wallet you already funded, WITHOUT the key ever appearing in a chat.
#
#   printf '%s' '0x<your testnet private key>' > /tmp/mykey.txt   # write it yourself, do not paste it in chat
#   bash packages/x402/scripts/qday-use-wallet.sh /tmp/mykey.txt    # prints the derived address for you to confirm
#   rm /tmp/mykey.txt                                              # then delete it
#
# This is a TESTNET-ONLY wallet with no value (5 tQDAY / 1 tUSD8 from the faucet). The key is copied into
# .data/qday-demo/ (gitignored, 0600) and used by the facilitator as the relayer and by the payer as the signer.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
KEYFILE="${1:?usage: qday-use-wallet.sh <file containing the 0x private key>}"
OUT="$REPO/.data/qday-demo/demo-key.json"

[ -f "$KEYFILE" ] || { echo "no such file: $KEYFILE"; exit 2; }
KEY="$(tr -d '[:space:]' <"$KEYFILE")"
case "$KEY" in
  0x*) ;;
  *) KEY="0x$KEY" ;;
esac
if ! printf '%s' "$KEY" | grep -Eq '^0x[0-9a-fA-F]{64}$'; then
  echo "that file does not contain a 32-byte hex private key"; exit 2
fi

mkdir -p "$REPO/.data/qday-demo"
[ -f "$OUT" ] && cp "$OUT" "$OUT.bak.$(date +%s)"

cd "$REPO/packages/x402"
node --input-type=module - "$KEY" "$OUT" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
const [key, out] = process.argv.slice(2);
const account = privateKeyToAccount(key);
const previous = JSON.parse(readFileSync(out, "utf8").replace(/[\s\S]*$/, m => m || "{}"));
const merchant = previous?.merchant ?? { address: account.address, privateKey: key };
const payload = {
  note: "QDay Aevum demo wallets (testnet only, no value). Payer/relayer is the wallet imported by qday-use-wallet.sh.",
  payerAndRelayer: { address: account.address, privateKey: key },
  merchant,
};
writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
console.log("payer/relayer:", account.address);
console.log("merchant     :", merchant.address);
JS

echo
echo "now run:  bash packages/x402/scripts/qday-run-all.sh"
