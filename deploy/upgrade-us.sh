#!/bin/sh
# Run inside /opt/moneyswitch/releases/<revision>. Mainnet requires explicit opt-in.
set -eu
enable_solana_mainnet=0
for arg in "$@"; do
  case "$arg" in
    --enable-solana-mainnet) enable_solana_mainnet=1 ;;
    *) printf 'Unknown argument: %s\nUsage: sh upgrade-us.sh [--enable-solana-mainnet]\n' "$arg" >&2; exit 2 ;;
  esac
done
release=$(pwd)
case "$release" in /opt/moneyswitch/releases/*) ;; *) exit 1;; esac
sha256sum -c SHA256SUMS >/dev/null
revision=$(cat REVISION)
image=moneyswitch:$(printf '%s' "$revision" | cut -c1-7)
old_image=$(docker inspect moneyswitch-server-1 --format '{{.Config.Image}}')
old_compose=$(docker inspect moneyswitch-server-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
# Preserve the running deployment's effective network list, including the original
# single-Monad legacy fallback when MONEYSWITCH_NETWORKS is absent. Never guess a
# wider default from the new Compose file. Only this non-secret setting is read.
old_networks=''
old_default_network=''
if test "$enable_solana_mainnet" = 1; then
  old_networks=$(docker exec moneyswitch-server-1 node -e '
    const e = process.env;
    const raw = e.MONEYSWITCH_NETWORKS;
    const ids = raw === undefined
      ? [e.MONEYSWITCH_MAINNET_ENABLED === "true"
        ? (e.MONEYSWITCH_MAINNET_CAIP2 ?? "eip155:143")
        : (e.MONEYSWITCH_TESTNET_CAIP2 ?? "eip155:10143")]
      : [...new Set(raw.split(",").map(id => id.trim()).filter(Boolean))];
    if (!ids.length || ids.some(id => !/^(eip155|solana):[A-Za-z0-9_-]+$/.test(id))) process.exit(1);
    console.log(ids.join(","));
  ')
  old_default_network=$(docker exec moneyswitch-server-1 node -e '
    const e = process.env;
    const raw = e.MONEYSWITCH_NETWORKS;
    const fallback = e.MONEYSWITCH_MAINNET_ENABLED === "true"
      ? (e.MONEYSWITCH_MAINNET_CAIP2 ?? "eip155:143")
      : (e.MONEYSWITCH_TESTNET_CAIP2 ?? "eip155:10143");
    const active = e.MONEYSWITCH_DEFAULT_NETWORK || (raw === undefined ? fallback : raw.split(",").map(id => id.trim()).find(Boolean));
    if (!active || !/^(eip155|solana):[A-Za-z0-9_-]+$/.test(active)) process.exit(1);
    console.log(active);
  ')
fi
test "$(docker exec moneyswitch-server-1 node -p 'JSON.stringify(require("/app/package.json").dependencies)')" = '{"better-sqlite3":"13.0.3"}'
docker build --build-arg "BASE_IMAGE=$old_image" --build-arg "REVISION=$revision" -t "$image" .
backup=/opt/moneyswitch/backups/$(date +%Y%m%d-%H%M%S)
umask 077
mkdir -p "$backup"
cp -p /opt/moneyswitch/config.env "$backup/config.env"
chmod 600 "$backup/config.env"
printf '%s\n' "$old_image" > "$backup/old-image"
printf '%s\n' "$old_compose" > "$backup/old-compose"
# Both upgrade and rollback start from the exact backed-up config. No secrets are
# printed; the temporary file is private, synced and atomically replaced.
write_config() {
  python3 - "$1" "$backup/config.env" "$image" "$enable_solana_mainnet" "$old_networks" "$old_default_network" <<'PY'
import os, pathlib, re, sys, tempfile

p = pathlib.Path('/opt/moneyswitch/config.env')
temporary = None
try:
    original = pathlib.Path(sys.argv[2]).read_bytes()
    result = original
    if sys.argv[1] == 'upgrade':
        text = original.decode('utf-8')
        def setting(text, key, value):
            pattern = r'^[ \t]*(?:export[ \t]+)?' + re.escape(key) + r'[ \t]*=.*(?:\r?\n|$)'
            text = re.sub(pattern, '', text, flags=re.M)
            return text.rstrip('\r\n') + '\n' + key + '=' + value + '\n'
        text = setting(text, 'MONEYSWITCH_IMAGE', sys.argv[3])
        if sys.argv[4] == '1':
            ids = sys.argv[5].split(',')
            if not ids or any(not re.fullmatch(r'(eip155|solana):[A-Za-z0-9_-]+', value) for value in ids):
                raise ValueError('Invalid effective network list')
            mainnet = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
            if mainnet not in ids:
                ids.append(mainnet)
            text = setting(text, 'MONEYSWITCH_NETWORKS', ','.join(ids))
            # Keep an existing setting byte-for-byte. If it was absent, preserve
            # the running service's default instead of adopting new Compose defaults.
            if not re.search(r'^[ \t]*(?:export[ \t]+)?MONEYSWITCH_DEFAULT_NETWORK[ \t]*=', text, flags=re.M):
                if sys.argv[6] not in ids:
                    raise ValueError('Default network is not in the effective network list')
                text = setting(text, 'MONEYSWITCH_DEFAULT_NETWORK', sys.argv[6])
        result = text.encode('utf-8')
    elif sys.argv[1] != 'restore':
        raise ValueError('Invalid configuration operation')
    fd, temporary = tempfile.mkstemp(prefix='.config.env-', dir=p.parent)
    with os.fdopen(fd, 'wb') as handle:
        os.chmod(temporary, 0o600)
        handle.write(result)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, p)
    temporary = None
except Exception:
    print('Atomic configuration update failed; configuration contents were not printed.', file=sys.stderr)
    sys.exit(1)
finally:
    if temporary is not None:
        os.unlink(temporary)
PY
}
replacement_started=0
rollback() {
  if ! write_config restore; then
    echo "Rollback could not restore config; backup: $backup" >&2
    if test "$replacement_started" = 0; then docker start moneyswitch-server-1 >/dev/null || true; fi
    return 1
  fi
  if test "$replacement_started" = 0; then
    docker start moneyswitch-server-1 >/dev/null || return 1
  else
    MONEYSWITCH_IMAGE="$old_image" docker compose -p moneyswitch --env-file /opt/moneyswitch/config.env -f "$old_compose" up -d --no-build server || return 1
  fi
  echo "Upgrade failed; previous image and config restored. Backup: $backup" >&2
}
on_exit() {
  status=$?
  trap - EXIT
  if test "$status" != 0; then rollback || echo "Rollback failed; operator recovery required: $backup" >&2; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Stop writes before backing up SQLite and the encrypted wallet. Keep unlock secrets in place.
docker stop moneyswitch-server-1 >/dev/null
tar -C /var/lib/docker/volumes/moneyswitch_moneyswitch-data/_data -czf "$backup/data.tgz" .
sh "$release/check-backup.sh" "$backup/data.tgz"
# Mainnet opt-in is only written after both configuration and data backups are verified.
write_config upgrade
# This release adds 0012_payment_purpose.sql: one nullable payments.purpose column. Old rows stay NULL and the previous image
# ignores the extra column. No wallet, administrator, existing key or payment identity is rewritten. The existing rollback remains
# compatible with the additive migration. Earlier 0007_wallet_lifecycle.sql was also ADDITIVE ONLY (two nullable columns on wallet_meta, a new
# wallet_retirements table and its index; nothing is dropped, renamed or rewritten). It runs when the new image first starts, and
# restoring the old image in rollback() below stays safe, because the old image:
#   - tracks applied migrations by file name in __migrations and ignores names it does not know, so it neither re-applies 0007
#     nor fails on it;
#   - never reads or writes the new columns or the new table, and the columns it does use are unchanged (SQLite ignores extra
#     columns, and the new ones are nullable, so its INSERTs keep working).
# packages/core/test/wallet.test.ts ("rolling back to the previous image is safe") runs exactly that against a migrated file.
# The upgrade does not touch the wallet files: an existing password wallet stays a password wallet and the old image keeps
# unlocking it from config.env. (Once an operator has switched a wallet to auto-unlock or replaced it with the NEW image, the old
# image cannot open it: restore $backup/data.tgz instead of just the image in that case.)
replacement_started=1
MONEYSWITCH_IMAGE="$image" docker compose -p moneyswitch --env-file /opt/moneyswitch/config.env -f "$release/docker-compose.yml" up -d --no-build server
ready=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4020/healthz >/dev/null; then ready=1; break; fi
  sleep 2
done
if test "$ready" != 1; then exit 1; fi
ln -sfn "$release" /opt/moneyswitch/current
trap - EXIT INT TERM
printf 'Active image: %s; backup: %s\n' "$image" "$backup"
