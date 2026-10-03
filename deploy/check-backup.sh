#!/bin/sh
# Checks a backup of the MoneySwitch data directory (/data) before you rely on it.
#
#   sh deploy/check-backup.sh backups/data-20261003-120000.tgz
#
# It only LISTS the archive (nothing is extracted to disk, no secret is printed) and asserts that the wallet is really inside:
#   - wallet.json, and
#   - for an auto-unlock wallet (the default): wallet-unlock-0x<address of that wallet>.secret.
# A password-mode wallet has no unlock secret, so none is asked for; its password is what you must keep.
#
# Why this exists: /data is 0700 and the files in it 0600, owned by the server's `node` account. A tar run by any other account
# (root in a container with `cap_drop: ALL` is NOT allowed to override that) does not necessarily fail loudly: it prints
# "Permission denied" and writes an archive that simply lacks the files that matter most. You would only find out on restore.
#
# Exit status: 0 = the wallet is in the archive; 1 = it is not (or the archive cannot be read); 2 = wrong usage.
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  echo "usage: sh deploy/check-backup.sh <backup.tgz>" >&2
  exit 2
fi
archive=$1
[ -f "$archive" ] || fail "$archive does not exist"

listing=$(tar -tzf "$archive" 2>/dev/null) || fail "$archive is not a readable .tgz archive (empty, truncated, or tar failed while it was made)"

# The stored name of a top-level entry ("./name" or "name"); empty when the archive does not hold it.
entry() {
  printf '%s\n' "$listing" | grep -F -x -e "$1" -e "./$1" | head -n 1
}

HOW="Make the backup as the account that owns /data: docker compose run --rm --no-deps --user node --entrypoint tar server -C /data -czf - . > <file>  (or tar the volume from the host as root, like deploy/upgrade-us.sh). Do not rely on this archive."

wallet_entry=$(entry wallet.json)
[ -n "$wallet_entry" ] || fail "wallet.json is NOT in $archive, so it cannot restore the wallet. $HOW"

wallet_json=$(tar -xzOf "$archive" "$wallet_entry" 2>/dev/null) || fail "wallet.json is listed in $archive but cannot be read from it (damaged archive?)"
flat=$(printf '%s' "$wallet_json" | tr -d '\r\n')
address=$(printf '%s' "$flat" | sed -n 's/.*"address"[[:space:]]*:[[:space:]]*"\(0[xX]\)\{0,1\}\([0-9a-fA-F]\{40\}\)".*/\2/p' | tr 'A-F' 'a-f')
[ -n "$address" ] || fail "wallet.json in $archive has no wallet address (not a MoneySwitch keystore, or damaged)"
protection=$(printf '%s' "$flat" | sed -n 's/.*"x-moneyswitch"[[:space:]]*:[[:space:]]*{[^}]*"protection"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')

if [ "$protection" = "auto" ]; then
  secret="wallet-unlock-0x$address.secret"
  [ -n "$(entry "$secret")" ] || fail "wallet.json (0x$address) is an auto-unlock wallet but $secret is NOT in $archive: restoring this archive would leave the wallet locked for good (only the recovery phrase could open it). $HOW"
  echo "OK: $archive holds wallet.json (0x$address, auto-unlock) and $secret"
else
  echo "OK: $archive holds wallet.json (0x$address, password mode: no unlock secret is expected; keep the password safe)"
fi
