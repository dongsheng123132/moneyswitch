#!/bin/sh
# Run inside /opt/moneyswitch/releases/<revision>. Existing testnet deployment only.
set -eu
release=$(pwd)
case "$release" in /opt/moneyswitch/releases/*) ;; *) exit 1;; esac
sha256sum -c SHA256SUMS >/dev/null
revision=$(cat REVISION)
image=moneyswitch:$(printf '%s' "$revision" | cut -c1-7)
old_image=$(docker inspect moneyswitch-server-1 --format '{{.Config.Image}}')
old_compose=$(docker inspect moneyswitch-server-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
test "$(docker exec moneyswitch-server-1 node -p 'JSON.stringify(require("/app/package.json").dependencies)')" = '{"better-sqlite3":"13.0.3"}'
docker build --build-arg "BASE_IMAGE=$old_image" --build-arg "REVISION=$revision" -t "$image" .
backup=/opt/moneyswitch/backups/$(date +%Y%m%d-%H%M%S)
umask 077
mkdir -p "$backup"
cp -p /opt/moneyswitch/config.env "$backup/config.env"
printf '%s\n' "$old_image" > "$backup/old-image"
printf '%s\n' "$old_compose" > "$backup/old-compose"
# Stop writes before backing up SQLite and the encrypted wallet. Keep unlock secrets in place.
docker stop moneyswitch-server-1 >/dev/null
restart_on_failure() { docker start moneyswitch-server-1 >/dev/null || true; }
trap restart_on_failure EXIT
tar -C /var/lib/docker/volumes/moneyswitch_moneyswitch-data/_data -czf "$backup/data.tgz" .
trap - EXIT
rollback() {
  cp -p "$backup/config.env" /opt/moneyswitch/config.env.next
  mv /opt/moneyswitch/config.env.next /opt/moneyswitch/config.env
  MONEYSWITCH_IMAGE="$old_image" docker compose -p moneyswitch --env-file /opt/moneyswitch/config.env -f "$old_compose" up -d --no-build server
  echo "Upgrade failed; previous image restored. Backup: $backup" >&2
}
# Current upgrade has no schema changes; old image can use the unchanged database.
if ! MONEYSWITCH_IMAGE="$image" docker compose -p moneyswitch --env-file /opt/moneyswitch/config.env -f "$release/docker-compose.yml" up -d --no-build server; then rollback; exit 1; fi
ready=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4020/healthz >/dev/null; then ready=1; break; fi
  sleep 2
done
if test "$ready" != 1; then rollback; exit 1; fi
# Update the image setting atomically without displaying any existing settings.
python3 - "$image" <<'PY'
import os, pathlib, re, sys
p=pathlib.Path('/opt/moneyswitch/config.env'); text=p.read_text()
text=re.sub(r'^MONEYSWITCH_IMAGE=.*\n?', '', text, flags=re.M)
n=p.with_name('config.env.next'); n.write_text(text.rstrip()+'\nMONEYSWITCH_IMAGE='+sys.argv[1]+'\n'); os.chmod(n,0o600); os.replace(n,p)
PY
ln -sfn "$release" /opt/moneyswitch/current
printf 'Active image: %s; backup: %s\n' "$image" "$backup"
