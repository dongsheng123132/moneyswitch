#!/bin/sh
# Install only the MoneySwitch fragment; preserve other sites and a rollback copy.
set -eu
fragment=${1:-deploy/moneyswitch.caddy}
base=/etc/caddy/Caddyfile
target=/etc/caddy/conf.d/moneyswitch.caddy
stamp=$(date +%Y%m%d-%H%M%S)
backup=/opt/moneyswitch/caddy-backups/$stamp
mkdir -p "$backup" /etc/caddy/conf.d
cp -p "$base" "$backup/Caddyfile"
if test -e "$target"; then cp -p "$target" "$backup/moneyswitch.caddy"; fi
original=$(sha256sum "$base" | cut -d ' ' -f 1)
cp "$fragment" "$target.next"
mv "$target.next" "$target"
candidate="$base.moneyswitch-next"
cp -p "$base" "$candidate"
if ! grep -Fq 'import /etc/caddy/conf.d/moneyswitch.caddy' "$candidate"; then
  printf '\n# MoneySwitch; source: moneyswitch/deploy/moneyswitch.caddy\nimport /etc/caddy/conf.d/moneyswitch.caddy\n' >> "$candidate"
fi
if ! caddy validate --config "$candidate" --adapter caddyfile; then
  if test -e "$backup/moneyswitch.caddy"; then cp -p "$backup/moneyswitch.caddy" "$target"; else rm -f "$target"; fi
  exit 1
fi
test "$original" = "$(sha256sum "$base" | cut -d ' ' -f 1)"
mv "$candidate" "$base"
if ! caddy reload --config "$base" --adapter caddyfile; then
  cp -p "$backup/Caddyfile" "$base"
  if test -e "$backup/moneyswitch.caddy"; then cp -p "$backup/moneyswitch.caddy" "$target"; else rm -f "$target"; fi
  caddy reload --config "$base" --adapter caddyfile
  exit 1
fi
printf 'Caddy active; rollback backup: %s\n' "$backup"
