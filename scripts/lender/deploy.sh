#!/usr/bin/env bash
# Deploy one image to one lender's stack, with a rollback.
#
#   deploy.sh <lender-dir> <name:tag> [--build] [--skip-backup] [--health-timeout SECONDS]
#
#   --build   build <name:tag> and <name>-tools:<tag> from THIS checkout first
#             (refuses a dirty tree); without it both must exist locally or be
#             pullable from a registry.
#
# It first validates the RENDERED compose config (check_rendered_config: distinct
# staff/portal session secrets, ports) and that both images were built for this
# lender (io.credaflow.lender-slug label). Images are pinned by immutable id for
# the switch and the rollback, so a moved tag cannot change what gets restored. Order: images present -> database up ->
# pre-migration backup -> prisma migrate deploy (the old app is still serving) ->
# switch app and app-portal -> GET /api/health on BOTH hosts (HTTP 200, status ok
# = DB reachable, commit = the image's own GIT_SHA) -> done.
# Never a pull/build/restart inside a live directory: the image exists before
# the switch, and the switch is one `compose up -d app`.
#
# Failure before the switch (ports taken, backup, migration): nothing changed, app untouched.
# Failure after it (a failing `compose up`, or unhealthy): the previous image is
# put back and re-checked. A redeploy of the SAME tag has nothing to roll back to:
# it is logged and reported and the stack is left running, never stopped.
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
[ "$(env_get "$ENV_FILE" AUDIT_CHAIN_KEY | wc -c)" -ge 33 ] || die "refusing: AUDIT_CHAIN_KEY in $ENV_FILE must be 32+ characters (the audit hash chain is keyed outside the database; provision-lender.sh adds it)"
check_rendered_config
acquire_lender_lock "$LENDER_DIR"

log() { printf '%s %s image=%s commit=%s %s\n' "$(utc_stamp)" "$1" "$image" "${expected:-?}" "${2:-}" >> "$STATE_DIR/deploys.log"; }
set_image() { printf 'APP_IMAGE=%s\n' "$1" > "$STATE_DIR/image.env.tmp"; mv "$STATE_DIR/image.env.tmp" "$STATE_DIR/image.env"; }
# switch_to IMAGE_ID EXPECT_COMMIT — point both hosts at the image; 0 only when `compose up` AND both health probes succeed.
switch_to() {
  set_image "$1"
  lcompose up -d --no-deps app app-portal >/dev/null && wait_stack_health "$2" "$timeout"
}

ensure_images "$image" "$build"
tools="$(tools_image_of "$image")"
check_image_lender "$image"
check_image_lender "$tools"
image_id="$(image_id "$image")" tools_id="$(image_id "$tools")"
expected="$(image_commit "$image_id")"
# What is running now, by immutable id (an older state dir recorded tags only).
prev="$(cat "$STATE_DIR/current-image" 2>/dev/null || true)"
prev_id="$(cat "$STATE_DIR/current-image-id" 2>/dev/null || true)"
[ -n "$prev_id" ] || [ -z "$prev" ] || prev_id="$(image_id "$prev" 2>/dev/null || true)"
check_ports_free
serving="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=app" --filter status=running)"

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
if ! tools_run "$tools_id" npx prisma migrate deploy; then
  log MIGRATE_FAILED "backup=${backup:-none}"
  die "migration failed; the app was NOT switched and still runs ${prev:-nothing}. A partly applied migration is not reverted: see docs/DEPLOY.md, 'A failed migration'. Backup before it: ${backup:-none}"
fi

ensure_app_role || { log APP_ROLE_FAILED "backup=${backup:-none}"; die "could not set up the application's database login; the app was NOT switched and still runs ${prev:-nothing}"; }

note "switching app to $image ($image_id)"
if switch_to "$image_id" "$expected"; then
  printf '%s\n' "$image" > "$STATE_DIR/current-image"
  printf '%s\n' "$image_id" > "$STATE_DIR/current-image-id"
  printf '%s\n' "$tools_id" > "$STATE_DIR/current-tools-id"
  if [ -n "$prev_id" ] && [ "$prev_id" != "$image_id" ]; then
    printf '%s\n' "${prev:-?}" > "$STATE_DIR/previous-image"; printf '%s\n' "$prev_id" > "$STATE_DIR/previous-image-id"
  fi
  log DEPLOYED "backup=${backup:-none} previous=${prev:-none}"
  note "DEPLOYED $image (commit ${expected:-unknown}); health ok"
  exit 0
fi

note "switch to $image FAILED (compose up error, or no 200/ok/commit=$expected and a 200 login page on both hosts within ${timeout}s)"
log SWITCH_FAILED "backup=${backup:-none}"
if [ -n "$prev_id" ] && [ "$prev_id" != "$image_id" ] && docker image inspect "$prev_id" >/dev/null 2>&1; then
  note "rolling the app back to ${prev:-$prev_id} ($prev_id)"
  if switch_to "$prev_id" "$(image_commit "$prev_id" 2>/dev/null || true)"; then
    log ROLLED_BACK "to=${prev:-$prev_id} id=$prev_id"
    die "ROLLED BACK to ${prev:-$prev_id}: $image failed to start or pass its health check. Migrations are NOT reverted (backup before them: ${backup:-none})"
  fi
  log ROLLBACK_FAILED "to=${prev:-$prev_id} id=$prev_id"
  die "rollback to ${prev:-$prev_id} is ALSO unhealthy or failed to start; investigate: compose logs. Backup before the migration: ${backup:-none}"
fi
if [ -n "$prev_id" ] && [ "$prev_id" = "$image_id" ]; then
  log SAME_TAG_UNHEALTHY "left running, not stopped"
  die "redeploy of the same image $image is unhealthy and there is no other image to roll back to. Left running, NOT stopped: inspect (compose logs), fix .env or the data, and redeploy. Backup before the migration: ${backup:-none}"
fi
if [ -n "$serving" ]; then
  log UNHEALTHY_NO_PREVIOUS "left running, not stopped"
  die "$image is unhealthy; no previous image is available but the stack was already serving, so it is left running, NOT stopped. Backup before the migration: ${backup:-none}"
fi
lcompose stop app app-portal >/dev/null
log STOPPED "first deploy, nothing was serving"
die "first deploy failed; app stopped (nothing was serving). Backup before the migration: ${backup:-none}"
