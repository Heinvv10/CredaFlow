#!/usr/bin/env bash
# Restores a baked snapshot into the LIVE demo stack ($LIVE_DIR, containers
# credaflow-demo-*). Brief downtime; the tunnel container is never touched.
#
#   scripts/demo/restore.sh [snapshot] [--force-image]
#
#   snapshot       a dir name under $DEMO_DATA_DIR/snapshots or a path;
#                  default: latest
#   --force-image  restore even though the snapshot was baked on a different
#                  image than the live demo runs (schema/code may not match)
#
# Steps: stop app + portal → DROP/CREATE the demo database → pg_restore →
# replace the uploads volume's contents (owned by the image's nextjs:nodejs)
# → DEBIT_MANDATE_CREDITOR_TENANT_ID := the snapshot's tenant id in
# $LIVE_DIR/.env.production → `up -d` app + portal (recreated when that id
# changed) → wait for /api/health on both → print the elapsed time.
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"

snapshot="latest" force_image=false
while [ $# -gt 0 ]; do
  case "$1" in
    --force-image) force_image=true; shift ;;
    -*) die "usage: restore.sh [snapshot] [--force-image]" ;;
    *) snapshot="$1"; shift ;;
  esac
done
case "$snapshot" in
  */*) snap="$snapshot" ;;
  *) snap="$SNAP_DIR/$snapshot" ;;
esac
[ -d "$snap" ] || die "snapshot $snap not found"
snap="$(readlink -f "$snap")"
for f in meta.json db.dump uploads.tar.gz; do
  [ -s "$snap/$f" ] || die "$snap/$f missing; not a complete snapshot"
done

image="$(live_image)"
snap_image="$(jq -r .image "$snap/meta.json")"
tenant_id="$(jq -r .tenantId "$snap/meta.json")"
[ -n "$tenant_id" ] && [ "$tenant_id" != null ] || die "no tenantId in $snap/meta.json"
if [ "$snap_image" != "$image" ]; then
  $force_image || die "snapshot was baked on $snap_image but the live demo runs $image (--force-image to restore anyway)"
  note "WARNING: snapshot image $snap_image != live $image (--force-image)"
fi

exec 9>"$DEMO_DATA_DIR/restore.lock"
flock -w 600 9 || die "another restore holds the lock"

uploads_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' "$LIVE_APP")"
[ -n "$uploads_volume" ] || die "$LIVE_APP has no /app/uploads volume"

t0="$(date +%s.%N)"
note "restoring ${snap##*/} (image $snap_image, tenant $tenant_id)"

docker stop -t 10 "$LIVE_APP" "$LIVE_PORTAL" >/dev/null

# All DB work runs inside the db container with its own POSTGRES_* env; no
# credential crosses the host shell.
docker exec "$LIVE_DB" sh -c '
  set -eu
  [ "$POSTGRES_DB" != postgres ] || { echo "refusing: POSTGRES_DB is the maintenance db" >&2; exit 1; }
  psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$POSTGRES_DB\""'
docker cp "$snap/db.dump" "$LIVE_DB:/tmp/restore.dump" >/dev/null
docker exec "$LIVE_DB" sh -c '
  set -eu
  trap "rm -f /tmp/restore.dump" EXIT
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error -j 4 /tmp/restore.dump'
note "database restored"

docker run --rm -i -u root --entrypoint sh -v "$uploads_volume:/u" "$image" -c '
  set -eu
  find /u -mindepth 1 -delete
  tar -xzf - -C /u
  chown -R nextjs:nodejs /u' < "$snap/uploads.tar.gz"
note "uploads restored into $uploads_volume"

env_set "$LIVE_DIR/.env.production" DEBIT_MANDATE_CREDITOR_TENANT_ID "$tenant_id"
(cd "$LIVE_DIR" && docker-compose -f docker-compose.demo.yml up -d --no-deps app app-portal) >&2

wait_health() {
  local port="$1"
  for _ in $(seq 1 120); do
    curl -sf -o /dev/null "http://127.0.0.1:$port/api/health" && return 0
    sleep 0.5
  done
  die "/api/health on :$port did not answer 200 within 60 s"
}
wait_health 3310
wait_health 3312

awk -v t0="$t0" -v t1="$(date +%s.%N)" -v s="${snap##*/}" \
  'BEGIN { printf "restore: %s restored in %.1f s (staff :3310 + portal :3312 healthy)\n", s, t1 - t0 }'
