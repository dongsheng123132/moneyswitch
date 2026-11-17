#!/usr/bin/env bash
#
# e2e-fork.sh — QDayPayReceiver end-to-end settlement on an Anvil fork of QDay Aevum testnet.
#
# What it proves, on a fork of the real chain with the real tUSD8 token contract:
#   1. the receiver deploys (via script/Deploy.s.sol, the same script used for the real testnet),
#   2. a real tUSD8 holder is impersonated to fund a fresh payer with 0.01 tUSD8,
#   3. the payer signs an EIP-3009 TransferWithAuthorization off-chain (domain name="tUSD8",
#      version="2", chainId 44005, verifyingContract=tUSD8, to=receiver),
#   4. a *different* account (the seller) submits it to receiver.pay(orderId, ...),
#   5. in one atomic transaction the merchant receives the funds, the contract keeps nothing,
#      the on-chain receipt event carries the orderId, and the order cannot be paid twice.
#
# Requirements: ~/.foundry/bin/{anvil,cast,forge}, network access to https://rpc-test.qday.info
# Usage:       bash contracts/script/e2e-fork.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
ANVIL="${ANVIL:-$HOME/.foundry/bin/anvil}"

UPSTREAM_RPC="${UPSTREAM_RPC:-https://rpc-test.qday.info}"
PORT="${PORT:-8547}"
FORK_RPC="http://127.0.0.1:${PORT}"
CHAIN_ID=44005

# tUSD8 on QDay Aevum testnet: 6 decimals, EIP-3009 (FiatTokenV2-style) + EIP-2612.
TUSD8="0x456569838f1d43009A91ebA4263147Afd7233483"
# Real tUSD8 holder used as the funding source (holds >1,098,812 tUSD8; impersonated on the fork).
WHALE="0x94ef5dB164e7BBf4149e298c5588C035Ea8E9C05"

AMOUNT=10000                    # 0.01 tUSD8 (6 decimals)
AMOUNT_HUMAN="0.01 tUSD8"
GAS_FUND="0x21e19e0c9bab2400000" # 10,000 ETH for the impersonated whale / local accounts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ANVIL_LOG="$(mktemp -t anvil-8547-XXXXXX.log)"

ANVIL_PID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

cleanup() {
    if [ -n "${ANVIL_PID}" ] && kill -0 "${ANVIL_PID}" 2>/dev/null; then
        kill "${ANVIL_PID}" 2>/dev/null || true
        wait "${ANVIL_PID}" 2>/dev/null || true
    fi
    rm -f "${ANVIL_LOG}"
}
trap cleanup EXIT

# cast call helpers
balance_of() { "${CAST}" call "${TUSD8}" "balanceOf(address)(uint256)" "$1" --rpc-url "${FORK_RPC}" | awk '{print $1}'; }
merchant_note() { printf '  %-22s %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
step "0. Preconditions"
[ -x "${FORGE}" ] || die "forge not found at ${FORGE}"
[ -x "${CAST}" ]  || die "cast not found at ${CAST}"
[ -x "${ANVIL}" ] || die "anvil not found at ${ANVIL}"
cd "${PROJECT_DIR}"

if "${CAST}" chain-id --rpc-url "${FORK_RPC}" >/dev/null 2>&1; then
    die "port ${PORT} already has an RPC endpoint listening. Stop it first (lead uses 8546)."
fi

say "project    : ${PROJECT_DIR}"
say "fork port  : ${PORT} (upstream ${UPSTREAM_RPC})"
say "token      : ${TUSD8} (tUSD8, 6 decimals, EIP-3009)"
say "amount     : ${AMOUNT_HUMAN} (${AMOUNT} base units)"

# ---------------------------------------------------------------------------
# 1. Fresh accounts (generated per run; nothing is written to disk)
# ---------------------------------------------------------------------------
step "1. Accounts"
new_key() { "${CAST}" wallet new 2>&1; }

DEPLOYER_OUT="$(new_key)"; DEPLOYER_ADDR="$(echo "${DEPLOYER_OUT}" | awk '/Address:/{print $2}')"
DEPLOYER_PK="$(echo "${DEPLOYER_OUT}" | awk '/Private key:/{print $3}')"

SELLER_OUT="$(new_key)"; SELLER_ADDR="$(echo "${SELLER_OUT}" | awk '/Address:/{print $2}')"
SELLER_PK="$(echo "${SELLER_OUT}" | awk '/Private key:/{print $3}')"

PAYER_OUT="$(new_key)"; PAYER_ADDR="$(echo "${PAYER_OUT}" | awk '/Address:/{print $2}')"
PAYER_PK="$(echo "${PAYER_OUT}" | awk '/Private key:/{print $3}')"

MERCHANT_OUT="$(new_key)"; MERCHANT_ADDR="$(echo "${MERCHANT_OUT}" | awk '/Address:/{print $2}')"

OWNER_ADDR="${DEPLOYER_ADDR}"
merchant_note "deployer/owner" "${DEPLOYER_ADDR}"
merchant_note "seller (submits pay)" "${SELLER_ADDR}"
merchant_note "payer (signs EIP-3009)" "${PAYER_ADDR}"
merchant_note "merchant (beneficiary)" "${MERCHANT_ADDR}"

# ---------------------------------------------------------------------------
# 2. Anvil fork
# ---------------------------------------------------------------------------
step "2. Starting Anvil fork of QDay Aevum (chainId ${CHAIN_ID}) on port ${PORT}"
"${ANVIL}" --fork-url "${UPSTREAM_RPC}" --port "${PORT}" --chain-id "${CHAIN_ID}" \
    --auto-impersonate >"${ANVIL_LOG}" 2>&1 &
ANVIL_PID=$!

FORK_READY=0
for _ in $(seq 1 60); do
    if "${CAST}" chain-id --rpc-url "${FORK_RPC}" >/dev/null 2>&1; then FORK_READY=1; break; fi
    sleep 1
done
[ "${FORK_READY}" -eq 1 ] || { tail -20 "${ANVIL_LOG}" >&2; die "anvil fork did not come up on ${FORK_RPC}"; }

FORK_CHAIN_ID="$("${CAST}" chain-id --rpc-url "${FORK_RPC}")"
[ "${FORK_CHAIN_ID}" = "${CHAIN_ID}" ] || die "fork chainId ${FORK_CHAIN_ID} != expected ${CHAIN_ID}"

FORK_TS="$("${CAST}" block latest --json --rpc-url "${FORK_RPC}" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["timestamp"],16))')"
FORK_BLOCK="$("${CAST}" block-number --rpc-url "${FORK_RPC}")"
merchant_note "fork head" "block ${FORK_BLOCK}, timestamp ${FORK_TS}"

# Fund gas for the accounts that send transactions (payer never sends a tx itself).
"${CAST}" rpc anvil_setBalance "${DEPLOYER_ADDR}" "${GAS_FUND}" --rpc-url "${FORK_RPC}" >/dev/null
"${CAST}" rpc anvil_setBalance "${SELLER_ADDR}" "${GAS_FUND}" --rpc-url "${FORK_RPC}" >/dev/null

# ---------------------------------------------------------------------------
# 3. Deploy the receiver with the production deploy script
# ---------------------------------------------------------------------------
step "3. Deploying QDayPayReceiver (forge script script/Deploy.s.sol --broadcast)"
DEPLOY_OUT="$(
    PRIVATE_KEY="${DEPLOYER_PK}" \
    TUSD8="${TUSD8}" \
    OWNER="${OWNER_ADDR}" \
    BENEFICIARY="${MERCHANT_ADDR}" \
    "${FORGE}" script script/Deploy.s.sol --rpc-url "${FORK_RPC}" --broadcast --offline -vv 2>&1
)" || { printf '%s\n' "${DEPLOY_OUT}" >&2; die "deployment failed"; }

BROADCAST_JSON="broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json"
[ -f "${BROADCAST_JSON}" ] || die "broadcast artifact missing: ${BROADCAST_JSON}"

RECEIVER="$(python3 - "${BROADCAST_JSON}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
addrs = [t.get("contractAddress") for t in d.get("transactions", []) if t.get("contractAddress")]
print(addrs[-1] if addrs else "")
PY
)"
[ -n "${RECEIVER}" ] || die "could not parse deployed receiver address"

merchant_note "receiver deployed at" "${RECEIVER}"

# Sanity: the constructor arguments really are wired up on chain.
ONCHAIN_TOKEN="$("${CAST}" call "${RECEIVER}" "token()(address)" --rpc-url "${FORK_RPC}")"
ONCHAIN_OWNER="$("${CAST}" call "${RECEIVER}" "owner()(address)" --rpc-url "${FORK_RPC}")"
ONCHAIN_BENEF="$("${CAST}" call "${RECEIVER}" "beneficiary()(address)" --rpc-url "${FORK_RPC}")"
[ "$(echo "${ONCHAIN_TOKEN}" | tr 'A-Z' 'a-z')" = "$(echo "${TUSD8}" | tr 'A-Z' 'a-z')" ] || die "token() mismatch: ${ONCHAIN_TOKEN}"
[ "$(echo "${ONCHAIN_OWNER}" | tr 'A-Z' 'a-z')" = "$(echo "${OWNER_ADDR}" | tr 'A-Z' 'a-z')" ] || die "owner() mismatch: ${ONCHAIN_OWNER}"
[ "$(echo "${ONCHAIN_BENEF}" | tr 'A-Z' 'a-z')" = "$(echo "${MERCHANT_ADDR}" | tr 'A-Z' 'a-z')" ] || die "beneficiary() mismatch: ${ONCHAIN_BENEF}"
merchant_note "token()" "${ONCHAIN_TOKEN}"
merchant_note "owner()" "${ONCHAIN_OWNER}"
merchant_note "beneficiary()" "${ONCHAIN_BENEF}"

# ---------------------------------------------------------------------------
# 4. Fund the payer from a real tUSD8 whale (impersonated on the fork)
# ---------------------------------------------------------------------------
step "4. Funding payer from real tUSD8 holder ${WHALE}"

"${CAST}" rpc anvil_impersonateAccount "${WHALE}" --rpc-url "${FORK_RPC}" >/dev/null
"${CAST}" rpc anvil_setBalance "${WHALE}" "${GAS_FUND}" --rpc-url "${FORK_RPC}" >/dev/null

WHALE_BEFORE="$(balance_of "${WHALE}")"
PAYER_BEFORE="$(balance_of "${PAYER_ADDR}")"
MERCHANT_BEFORE="$(balance_of "${MERCHANT_ADDR}")"
RECEIVER_BEFORE="$(balance_of "${RECEIVER}")"

merchant_note "whale balance before" "${WHALE_BEFORE}"
merchant_note "payer  balance before" "${PAYER_BEFORE}"

FUND_TX="$("${CAST}" send "${TUSD8}" "transfer(address,uint256)" "${PAYER_ADDR}" "${AMOUNT}" \
    --from "${WHALE}" --unlocked --rpc-url "${FORK_RPC}" --json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')" \
    || die "whale transfer failed"
merchant_note "fund tx hash" "${FUND_TX}"

PAYER_FUNDED="$(balance_of "${PAYER_ADDR}")"
[ "${PAYER_FUNDED}" = "${AMOUNT}" ] || die "payer funding mismatch: ${PAYER_FUNDED} != ${AMOUNT} (token really moved)"
merchant_note "payer  balance after" "${PAYER_FUNDED}"

# ---------------------------------------------------------------------------
# 5. Payer signs the EIP-3009 authorization off-chain
# ---------------------------------------------------------------------------
step "5. Signing EIP-3009 TransferWithAuthorization (off-chain, to = receiver)"

VALID_AFTER=0
VALID_BEFORE=$((FORK_TS + 3600))
NONCE="$("${CAST}" keccak "qday-e2e-nonce-$$-$(date +%s%N 2>/dev/null || date +%s)")"
ORDER_ID="$("${CAST}" keccak "qday-e2e-order-$$-$(date +%s%N 2>/dev/null || date +%s)")"

# EIP-712 domain of tUSD8 as measured on chain: name="tUSD8", version="2".
TYPEHASH_TRANSFER_WITH_AUTH="$("${CAST}" keccak 'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')"
TYPEHASH_DOMAIN="$("${CAST}" keccak 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')"
NAME_HASH="$("${CAST}" keccak 'tUSD8')"
VERSION_HASH="$("${CAST}" keccak '2')"

DOMAIN_SEPARATOR="$("${CAST}" keccak "$("${CAST}" abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' \
    "${TYPEHASH_DOMAIN}" "${NAME_HASH}" "${VERSION_HASH}" "${CHAIN_ID}" "${TUSD8}")")"
STRUCT_HASH="$("${CAST}" keccak "$("${CAST}" abi-encode 'f(bytes32,address,address,uint256,uint256,uint256,bytes32)' \
    "${TYPEHASH_TRANSFER_WITH_AUTH}" "${PAYER_ADDR}" "${RECEIVER}" "${AMOUNT}" "${VALID_AFTER}" "${VALID_BEFORE}" "${NONCE}")")"
DIGEST="$("${CAST}" keccak "0x1901${DOMAIN_SEPARATOR#0x}${STRUCT_HASH#0x}")"

SIG="$("${CAST}" wallet sign --no-hash --private-key "${PAYER_PK}" "${DIGEST}")"
SIG_R="0x${SIG:2:64}"
SIG_S="0x${SIG:66:64}"
SIG_V=$((16#${SIG:130:2}))

merchant_note "orderId" "${ORDER_ID}"
merchant_note "nonce" "${NONCE}"
merchant_note "validAfter/Before" "${VALID_AFTER} / ${VALID_BEFORE}"
merchant_note "digest" "${DIGEST}"
merchant_note "signature v" "${SIG_V}"

# Pre-flight: ask the real token to validate the signature without committing state. If this
# reverts, the EIP-712 domain or the signing scheme is wrong and pay() would fail too.
if ! "${CAST}" call "${TUSD8}" \
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
    "${PAYER_ADDR}" "${RECEIVER}" "${AMOUNT}" "${VALID_AFTER}" "${VALID_BEFORE}" "${NONCE}" \
    "${SIG_V}" "${SIG_R}" "${SIG_S}" --from "${PAYER_ADDR}" --rpc-url "${FORK_RPC}" >/dev/null 2>&1; then
    die "token rejected the EIP-3009 signature (wrong domain or signer)"
fi
say "  signature pre-check: token accepts it (would succeed)"

# ---------------------------------------------------------------------------
# 6. Seller settles via receiver.pay(...)
# ---------------------------------------------------------------------------
step "6. Seller submits receiver.pay(...) — one transaction, money + receipt together"

PAY_TX="$("${CAST}" send "${RECEIVER}" \
    "pay(bytes32,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
    "${ORDER_ID}" "${PAYER_ADDR}" "${AMOUNT}" "${VALID_AFTER}" "${VALID_BEFORE}" "${NONCE}" \
    "${SIG_V}" "${SIG_R}" "${SIG_S}" \
    --private-key "${SELLER_PK}" --rpc-url "${FORK_RPC}" --json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')" \
    || die "pay() failed"

merchant_note "pay tx hash" "${PAY_TX}"

# ---------------------------------------------------------------------------
# 7. Assertions + balance report
# ---------------------------------------------------------------------------
step "7. Balances (before -> after)"

PAYER_AFTER="$(balance_of "${PAYER_ADDR}")"
MERCHANT_AFTER="$(balance_of "${MERCHANT_ADDR}")"
RECEIVER_AFTER="$(balance_of "${RECEIVER}")"

printf '  %-24s %14s -> %-14s %s\n' "merchant (beneficiary)" "${MERCHANT_BEFORE}" "${MERCHANT_AFTER}" "(want +${AMOUNT})"
printf '  %-24s %14s -> %-14s %s\n' "payer" "${PAYER_FUNDED}" "${PAYER_AFTER}" "(want 0)"
printf '  %-24s %14s -> %-14s %s\n' "receiver contract" "${RECEIVER_BEFORE}" "${RECEIVER_AFTER}" "(want 0: nothing stranded)"

[ "${PAYER_AFTER}" = "0" ] || die "payer balance after pay is ${PAYER_AFTER}, expected 0"
[ "${RECEIVER_AFTER}" = "0" ] || die "receiver holds ${RECEIVER_AFTER} after pay, expected 0"
MERCHANT_DELTA=$((MERCHANT_AFTER - MERCHANT_BEFORE))
[ "${MERCHANT_DELTA}" = "${AMOUNT}" ] || die "merchant delta ${MERCHANT_DELTA} != ${AMOUNT}"

step "8. On-chain receipt: PaymentReceived event + order state"

ORDER_PAID="$("${CAST}" call "${RECEIVER}" "orders(bytes32)(bool)" "${ORDER_ID}" --rpc-url "${FORK_RPC}")"
[ "${ORDER_PAID}" = "true" ] || die "orders[orderId] is ${ORDER_PAID}, expected true"
merchant_note "orders(orderId)" "${ORDER_PAID}"

EVENT_TOPIC0="$("${CAST}" keccak 'PaymentReceived(bytes32,address,uint256,bytes32,address)')"
python3 - "${PAY_TX}" "${RECEIVER}" "${ORDER_ID}" "${EVENT_TOPIC0}" "${FORK_RPC}" "${CAST}" <<'PY'
import json, subprocess, sys

tx, receiver, order_id, topic0, rpc, cast = sys.argv[1:7]
receipt = json.loads(subprocess.check_output([cast, "receipt", tx, "--json", "--rpc-url", rpc]))
nc = lambda x: "0x" + x.lower().removeprefix("0x").rjust(64, "0")
want_order = nc(order_id)
found = []
for log in receipt["logs"]:
    topics = [t.lower() for t in log["topics"]]
    if log["address"].lower() != receiver.lower():
        continue
    if not topics or topics[0] != topic0.lower():
        continue
    if len(topics) < 4 or topics[1] != want_order:
        continue
    found.append((topics, log["data"]))
if len(found) != 1:
    sys.exit(f"expected exactly 1 PaymentReceived log for orderId, found {len(found)}")
topics, data = found[0]
payer = "0x" + topics[2][-40:]
beneficiary = "0x" + topics[3][-40:]
payload = data.removeprefix("0x")
value = int(payload[0:64], 16)
nonce = "0x" + payload[64:128]
print(f"  event             PaymentReceived")
print(f"  event orderId     {order_id}  (topic1 match)")
print(f"  event from        {payer}")
print(f"  event value       {value}")
print(f"  event nonce       {nonce}")
print(f"  event beneficiary {beneficiary}")
PY

# ---------------------------------------------------------------------------
# 9. Business idempotency: same orderId cannot be settled twice
# ---------------------------------------------------------------------------
step "9. Replay protection: same orderId with a brand-new nonce + signature"

NONCE2="$("${CAST}" keccak "qday-e2e-nonce2-$$-$(date +%s%N 2>/dev/null || date +%s)")"
STRUCT_HASH2="$("${CAST}" keccak "$("${CAST}" abi-encode 'f(bytes32,address,address,uint256,uint256,uint256,bytes32)' \
    "${TYPEHASH_TRANSFER_WITH_AUTH}" "${PAYER_ADDR}" "${RECEIVER}" "${AMOUNT}" "${VALID_AFTER}" "${VALID_BEFORE}" "${NONCE2}")")"
DIGEST2="$("${CAST}" keccak "0x1901${DOMAIN_SEPARATOR#0x}${STRUCT_HASH2#0x}")"
SIG2="$("${CAST}" wallet sign --no-hash --private-key "${PAYER_PK}" "${DIGEST2}")"
SIG2_R="0x${SIG2:2:64}"; SIG2_S="0x${SIG2:66:64}"; SIG2_V=$((16#${SIG2:130:2}))

ORDER_ALREADY_PAID_SELECTOR="$("${CAST}" sig 'OrderAlreadyPaid(bytes32)')"
SECOND_OUT="$("${CAST}" call "${RECEIVER}" \
    "pay(bytes32,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
    "${ORDER_ID}" "${PAYER_ADDR}" "${AMOUNT}" "${VALID_AFTER}" "${VALID_BEFORE}" "${NONCE2}" \
    "${SIG2_V}" "${SIG2_R}" "${SIG2_S}" --from "${SELLER_ADDR}" --rpc-url "${FORK_RPC}" 2>&1)" && {
    die "second settle with the same orderId SUCCEEDED - idempotency guard is broken"
}
echo "${SECOND_OUT}" | grep -qi "${ORDER_ALREADY_PAID_SELECTOR#0x}" \
    || { printf '%s\n' "${SECOND_OUT}" >&2; die "second settle failed, but not with OrderAlreadyPaid"; }
merchant_note "second attempt" "reverted with OrderAlreadyPaid(${ORDER_ID}) as expected"
merchant_note "merchant unchanged" "$(balance_of "${MERCHANT_ADDR}") (still ${MERCHANT_AFTER})"
[ "$(balance_of "${MERCHANT_ADDR}")" = "${MERCHANT_AFTER}" ] || die "merchant balance moved on the replayed order"

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
step "10. E2E SUMMARY"
say "chain                      QDay Aevum testnet fork (chainId ${CHAIN_ID}), fork block ${FORK_BLOCK}"
say "settlement token           ${TUSD8} (tUSD8)"
say "receiver (payTo)           ${RECEIVER}"
say "owner / merchant           ${OWNER_ADDR} / ${MERCHANT_ADDR}"
say "payer (signer)             ${PAYER_ADDR}"
say "orderId                    ${ORDER_ID}"
say "whale funding tx           ${FUND_TX}"
say "pay tx hash                ${PAY_TX}"
say "amount settled             ${AMOUNT} (${AMOUNT_HUMAN})"
say "merchant  tUSD8            ${MERCHANT_BEFORE} -> ${MERCHANT_AFTER}"
say "payer     tUSD8            ${PAYER_FUNDED} -> ${PAYER_AFTER}"
say "receiver  tUSD8            ${RECEIVER_BEFORE} -> ${RECEIVER_AFTER}"
say ""
say "ALL ASSERTIONS PASSED"
