#!/usr/bin/env bash
# Deploy one image to one lender's stack, with a rollback.
#
#   deploy.sh <lender-dir> <name:tag> [--build] [--skip-backup] [--health-timeout SECONDS]
#
#   --build   build <name:tag> and <name>-tools:<tag> from THIS checkout first
#             (refuses a dirty tree); without it both must exist locally or be
#             pullable from a registry.
#
# Order: images present -> database up -> pre-migration backup -> prisma migrate
# deploy (the old app is still serving) -> switch the app -> GET /api/health
# (HTTP 200, status ok = DB reachable, commit = the image's own GIT_SHA) -> done.
# Never a pull/build/restart inside a live directory: the image exists before
# the switch, and the switch is one `compose up -d app`.
#
# Failure before the switch (backup, migration): nothing changed, app untouched.
# Failure after it (unhealthy): the previous image is put back and re-checked.
# A migration is NOT reverted. The pre-migration backup path is printed; undoing
# the schema means restore.sh --over-live from that file (see docs/DEPLOY.md).
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}" image="${2:-}"; shift 2 || true
build=false skip_backup=false timeout=120
while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=true; shift ;;
    --skip-backup) skip_backup=true; shift ;;
    --health-timeout) timeout="${2:?--health-timeout needs seconds}"; shift 2 ;;
    *) die "usage: deploy.sh <lender-dir> <name:tag> [--build] [--skip-backup] [--health-timeout SECONDS]" ;;
  esac
done
[ -n "$image" ] || die "usage: deploy.sh <lender-dir> <name:tag> [--build] [--skip-backup] [--health-timeout SECONDS]"
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || die "--health-timeout must be a positive integer"
need docker curl jq flock
load_lender "$dir"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "another deploy of $SLUG is running"

log() { printf '%s %s image=%s commit=%s %s\n' "$(utc_stamp)" "$1" "$image" "${expected:-?}" "${2:-}" >> "$STATE_DIR/deploys.log"; }
set_image() { printf 'APP_IMAGE=%s\n' "$1" > "$STATE_DIR/image.env.tmp"; mv "$STATE_DIR/image.env.tmp" "$STATE_DIR/image.env"; }
health_url="http://127.0.0.1:$APP_PORT/api/health"

ensure_images "$image" "$build"
tools="$(tools_image_of "$image")"
expected="$(image_commit "$image")"
prev="$(cat "$STATE_DIR/current-image" 2>/dev/null || true)"

lcompose up -d db >/dev/null
wait_db

backup=""
if $skip_backup; then
  note "WARNING: --skip-backup: no pre-migration backup"
elif [ "$(psql_db "$PGDB" "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" = t ]; then
  tag="${image##*:}"
  backup="$("$LENDER_SCRIPTS/backup.sh" "$LENDER_DIR" --label "pre-$(tr -c 'A-Za-z0-9._\n-' _ <<<"${tag:0:34}")")" \
    || { log BACKUP_FAILED; die "pre-migration backup failed; nothing changed"; }
else
  note "database has no migrations yet (first deploy): no backup to take"
fi

note "applying migrations with $tools (app still on ${prev:-nothing})"
if ! tools_run "$tools" npx prisma migrate deploy; then
  log MIGRATE_FAILED "backup=${backup:-none}"
  die "migration failed; the app was NOT switched and still runs ${prev:-nothing}. A partly applied migration is not reverted: backup before it: ${backup:-none}"
fi

note "switching app to $image"
set_image "$image"
lcompose up -d --no-deps app >/dev/null
if wait_health "$health_url" "$expected" "$timeout"; then
  printf '%s\n' "$image" > "$STATE_DIR/current-image"
  [ -z "$prev" ] || [ "$prev" = "$image" ] || printf '%s\n' "$prev" > "$STATE_DIR/previous-image"
  log DEPLOYED "backup=${backup:-none} previous=${prev:-none}"
  note "DEPLOYED $image (commit ${expected:-unknown}); health ok"
  exit 0
fi

note "health check FAILED for $image (no 200/ok/commit=$expected within ${timeout}s)"
log HEALTH_FAILED "backup=${backup:-none}"
if [ -n "$prev" ] && [ "$prev" != "$image" ]; then
  note "rolling the app back to $prev"
  set_image "$prev"
  lcompose up -d --no-deps app >/dev/null
  if wait_health "$health_url" "$(image_commit "$prev" 2>/dev/null || true)" "$timeout"; then
    log ROLLED_BACK "to=$prev"
    die "ROLLED BACK to $prev: $image failed its health check. Migrations are NOT reverted (backup before them: ${backup:-none})"
  fi
  log ROLLBACK_FAILED "to=$prev"
  die "rollback to $prev is ALSO unhealthy; investigate: compose logs app. Backup before the migration: ${backup:-none}"
fi
lcompose stop app >/dev/null
log STOPPED "no previous image"
die "no previous image to roll back to; app stopped. Backup before the migration: ${backup:-none}"
