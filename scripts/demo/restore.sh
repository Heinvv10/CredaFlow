#!/usr/bin/env bash
# Restores a baked snapshot into the LIVE demo stack (compose project
# $LIVE_PROJECT in $LIVE_DIR; names in lib.sh). The tunnel is never touched.
#
#   scripts/demo/restore.sh [snapshot] [--force-image]
#
#   snapshot       a dir name under $DEMO_DATA_DIR/snapshots or a path;
#                  default: latest
#   --force-image  restore even though the snapshot was baked on a different
#                  image than the live demo runs (schema/code may not match)
#
# Refuses, before touching anything, unless app, portal and db all carry the
# compose project label $LIVE_PROJECT with working_dir $LIVE_DIR, and app and
# portal run with DEMO_MODE=true.
#
# Staged while the demo keeps serving:
#   - pg_restore into <db>_restore_<ts>, row counts checked against meta.json;
#   - when the live app container runs with DEMO_CLEAR_STAFF_TOTP=true (exact
#     string, read from the same container env as the DEMO_MODE guard), TOTP
#     is turned off for every staff user except SUPER_ADMIN in the staged db
#     (STAFF_TOTP_OFF_SQL in lib.sh), so presenters sign in with a password
#     only, and TenantConfig.requireStaffTotp is switched off (TENANT_TOTP_
#     POLICY_OFF_SQL) so they are not held at enrolment, and segregation of
#     duties is switched off (TENANT_SOD_OFF_SQL). The bake enrols TOTP,
#     so without this every restore turns it back on. This is the CLAUDE.md TOTP
#     exception for demo stacks;
#   - every tenant marked as a demo lender (TENANT_DEMO_LENDER_SQL), which the
#     demo's simulated Section 129 email needs;
#   - uploads unpacked into <volume>/.restore-<ts>, file count checked.
# Then the swap (the only downtime): stop app + portal → rename <db> to
# <db>_old_<ts> and the staged db to <db> (one transaction) → move the old
# uploads to .old-<ts> and the staged ones into place →
# DEBIT_MANDATE_CREDITOR_TENANT_ID := the snapshot's tenant in
# $LIVE_DIR/.env.production → `up -d` app + portal → /api/health on both.
# Only once both answer are <db>_old_<ts> and .old-<ts> dropped.
#
# Any failure after the stop rolls back: the old db and uploads are renamed
# back, the tenant id restored and app + portal started again. Every outcome
# is recorded in $LOG_DIR/last-restore (status.sh).
# shellcheck disable=SC2016  # uploads_sh scripts expand $STAGE/$OLD inside the container
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

# --- target guard: nothing below runs against a stack that is not the demo.
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }
live_dir="$(readlink -f "$LIVE_DIR")" || die "LIVE_DIR $LIVE_DIR does not exist"
[ -f "$live_dir/$LIVE_COMPOSE_FILE" ] || die "refusing: no $LIVE_COMPOSE_FILE in $live_dir"
for c in "$LIVE_APP" "$LIVE_PORTAL" "$LIVE_DB"; do
  docker inspect "$c" >/dev/null 2>&1 || die "refusing: container $c not found"
  got="$(label "$c" com.docker.compose.project)"
  [ "$got" = "$LIVE_PROJECT" ] || die "refusing: $c is in compose project '$got', not '$LIVE_PROJECT'"
  got="$(label "$c" com.docker.compose.project.working_dir)"
  [ "$got" = "$live_dir" ] || die "refusing: $c was started from '$got', not LIVE_DIR $live_dir"
done
# grep without -q on purpose: a grep that reads its input to EOF never leaves the
# producer writing into a closed pipe. With -q it exits at the first match and,
# under pipefail, the producer's SIGPIPE (141) fails the pipeline: a false
# "not a demo stack", or a skipped TOTP clear.
for c in "$LIVE_APP" "$LIVE_PORTAL"; do
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -x 'DEMO_MODE=true' >/dev/null \
    || die "refusing: $c does not run with DEMO_MODE=true, so it is not a demo stack"
done
db="$(docker exec "$LIVE_DB" printenv POSTGRES_DB)" || die "cannot read POSTGRES_DB in $LIVE_DB"
[ "$db" != postgres ] || die "refusing: POSTGRES_DB is the maintenance db"
[[ "$db" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "refusing: unexpected POSTGRES_DB name '$db'"

image="$(live_image)"
snap_image="$(jq -r .image "$snap/meta.json")"
tenant_id="$(jq -r .tenantId "$snap/meta.json")"
[ -n "$tenant_id" ] && [ "$tenant_id" != null ] || die "no tenantId in $snap/meta.json"
# It is written into .env.production: only the id shape (cuid) may get there.
[[ "$tenant_id" =~ ^[a-z0-9]{20,40}$ ]] || die "refusing: tenantId in $snap/meta.json is not a valid id"
# One lender's snapshot never goes into another lender's stack: the live
# image and host map resolve only the slug in $LIVE_DIR/.env (DEMO_LENDER).
live_slug="$(env_get "$live_dir/.env" NEXT_PUBLIC_TENANT_SLUG 2>/dev/null)" || live_slug=""
snap_slug="$(jq -r '.tenantSlug // empty' "$snap/meta.json")"
[ -n "$live_slug" ] || die "refusing: no NEXT_PUBLIC_TENANT_SLUG in $live_dir/.env"
[ "$snap_slug" = "$live_slug" ] || die "refusing: snapshot is tenant '${snap_slug:-unknown}', the live stack serves '$live_slug'"
if [ "$snap_image" != "$image" ]; then
  $force_image || die "snapshot was baked on $snap_image but the live demo runs $image (--force-image to restore anyway)"
  note "WARNING: snapshot image $snap_image != live $image (--force-image)"
fi

mkdir -p "$DEMO_DATA_DIR"
exec 9>"$RESTORE_LOCK"
flock -w 600 9 || die "another restore holds the lock"

uploads_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' "$LIVE_APP")"
[ -n "$uploads_volume" ] || die "$LIVE_APP has no /app/uploads volume"
# host_port CONTAINER — the published :3300 as host:port (host_addr in lib.sh).
host_port() {
  local ip port
  ip="$(docker inspect -f '{{with index .HostConfig.PortBindings "3300/tcp"}}{{(index . 0).HostIp}}{{end}}' "$1")"
  port="$(docker inspect -f '{{with index .HostConfig.PortBindings "3300/tcp"}}{{(index . 0).HostPort}}{{end}}' "$1")"
  [ -n "$port" ] || return 0
  host_addr "$ip" "$port"
}
staff_addr="$(host_port "$LIVE_APP")" portal_addr="$(host_port "$LIVE_PORTAL")"
[ -n "$staff_addr" ] && [ -n "$portal_addr" ] || die "cannot read the published :3300 ports of $LIVE_APP / $LIVE_PORTAL"

ts="$(date -u +%Y%m%d%H%M%S)"
tmp_db="${db}_restore_$ts" old_db="${db}_old_$ts"
stage=".restore-$ts" old_uploads=".old-$ts"

# All DB work runs inside the db container with its own POSTGRES_* env
# (live_sql in lib.sh); no credential crosses the host shell.
db_exists() { [ "$(live_sql postgres "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
kick() { live_sql postgres "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid()" >/dev/null; }
# uploads_sh SCRIPT — a shell script against the uploads volume, mounted at /u
# (sees STAGE, OLD and NEW_MOVING).
uploads_sh() {
  docker run --rm -i -u root --entrypoint sh -v "$uploads_volume:/u" -e STAGE="$stage" -e OLD="$old_uploads" -e NEW_MOVING="$new_moving" "$image" -c "set -eu; $1"
}
compose_up() {
  (cd "$live_dir" && docker-compose -p "$LIVE_PROJECT" -f "$LIVE_COMPOSE_FILE" up -d --no-deps app app-portal) >&2
}
wait_health() {
  local addr="$1"
  for _ in $(seq 1 120); do
    curl -sf -o /dev/null "http://$addr/api/health" && return 0
    sleep 0.5
  done
  echo "restore.sh: /api/health on $addr did not answer 200 within 60 s" >&2
  return 1
}

# Rollback state: which steps have happened.
step=staging tmp_created=false had_live_db=false db_swapped=false uploads_staged=false
old_moving=false new_moving=false stopped=false env_changed=false committed=false prev_tenant=""

rollback() {
  local rc=$? outcome
  # A second signal must not cut the rollback short.
  trap '' INT TERM HUP
  $committed && return 0
  set +e
  note "FAILED during $step (exit $rc); rolling back"
  if $stopped; then docker stop -t 10 "$LIVE_APP" "$LIVE_PORTAL" >/dev/null 2>&1; fi
  if $db_swapped; then
    kick "$db"
    if ! $had_live_db; then
      note "database: there was no previous $db to go back to"
    elif live_sql postgres "ALTER DATABASE \"$db\" RENAME TO \"${db}_failed_$ts\"; ALTER DATABASE \"$old_db\" RENAME TO \"$db\""; then
      note "database: previous $db renamed back"
      live_sql postgres "DROP DATABASE \"${db}_failed_$ts\" WITH (FORCE)"
    else
      note "ROLLBACK: could not rename $old_db back to $db; do it by hand"
    fi
  elif $tmp_created; then
    live_sql postgres "DROP DATABASE IF EXISTS \"$tmp_db\" WITH (FORCE)" && note "database: staged $tmp_db dropped"
  fi
  if $old_moving; then
    # Once the staged files started moving in, every root entry other than
    # $OLD/$STAGE is new (all old ones were already in $OLD) and is removed;
    # earlier .old-* dirs (not this run's) are kept.
    # Before that, the root holds only old entries not yet moved: keep them.
    # Either way, whatever reached $OLD then goes back.
    if uploads_sh '
      if [ "$NEW_MOVING" = true ]; then
        find /u -mindepth 1 -maxdepth 1 ! -name ".old-*" ! -name "$STAGE" -exec rm -rf {} +
      fi
      if [ -d "/u/$OLD" ]; then
        find "/u/$OLD" -mindepth 1 -maxdepth 1 -exec mv -t /u {} +
        rmdir "/u/$OLD"
      fi
      rm -rf "/u/$STAGE"'; then
      note "uploads: previous contents moved back"
    else
      note "ROLLBACK: previous uploads are in $uploads_volume:/$old_uploads; move them back by hand"
    fi
  elif $uploads_staged; then
    uploads_sh 'rm -rf "/u/$STAGE"'
  fi
  if $env_changed; then env_set "$live_dir/.env.production" DEBIT_MANDATE_CREDITOR_TENANT_ID "$prev_tenant"; fi
  if $stopped; then
    if compose_up && wait_health "$staff_addr" && wait_health "$portal_addr"; then
      outcome="rolled back; previous demo live again"
    else
      outcome="rolled back BUT the demo did not come back healthy"
    fi
  else
    outcome="demo never stopped; previous data untouched"
  fi
  note "$outcome"
  record_result restore "failed (exit $rc) ${snap##*/} during $step: $outcome"
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT TERM HUP

t0="$(date +%s.%N)"
note "restoring ${snap##*/} (image $snap_image, tenant $tenant_id) into $LIVE_PROJECT"

# --- stage, while the demo keeps serving.
# Exact prefix match: "_" in a LIKE pattern is a wildcard.
for stale in $(live_sql postgres "SELECT datname FROM pg_database WHERE left(datname, length('${db}_restore_')) = '${db}_restore_'"); do
  live_sql postgres "DROP DATABASE \"$stale\" WITH (FORCE)" && note "dropped stale $stale"
done
step="pg_restore into $tmp_db"
live_sql postgres "CREATE DATABASE \"$tmp_db\""
tmp_created=true
docker cp "$snap/db.dump" "$LIVE_DB:/tmp/restore.dump" >/dev/null
docker exec -e DB="$tmp_db" "$LIVE_DB" sh -c '
  set -eu
  trap "rm -f /tmp/restore.dump" EXIT
  pg_restore -U "$POSTGRES_USER" -d "$DB" --no-owner --no-acl --exit-on-error -j 4 /tmp/restore.dump'
step="audit protections"
# --no-owner --no-acl loses audit_log_redact()'s owner and the REVOKE FROM PUBLIC on the audit functions: re-assert them
# (migration 20261029100000; a snapshot older than that has no such function and needs nothing).
live_sql "$tmp_db" "$AUDIT_REASSERT_SQL" >/dev/null
step="row-count check"
want="$(jq -cS '.counts | del(.uploadFiles)' "$snap/meta.json")"
got="$(live_sql "$tmp_db" "$SNAPSHOT_COUNTS_SQL" | jq -cS .)"
[ "$got" = "$want" ] || die "restored row counts $got differ from the snapshot's $want"
note "database staged in $tmp_db ($got)"
step="demo lender marker"
live_sql "$tmp_db" "$TENANT_DEMO_LENDER_SQL" >/dev/null
note "tenants marked as demo lenders in the staged db (TenantConfig.isDemoLender)"

step="staff TOTP off"
if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$LIVE_APP" | grep -x 'DEMO_CLEAR_STAFF_TOTP=true' >/dev/null; then
  cleared="$(live_sql "$tmp_db" "$STAFF_TOTP_OFF_SQL")"
  note "staff TOTP off for $cleared users (DEMO_CLEAR_STAFF_TOTP=true)"
  live_sql "$tmp_db" "$TENANT_TOTP_POLICY_OFF_SQL" >/dev/null
  note "staff 2FA policy off in the staged db (DEMO_CLEAR_STAFF_TOTP=true)"
  live_sql "$tmp_db" "$TENANT_SOD_OFF_SQL" >/dev/null
  note "segregation of duties off in the staged db (DEMO_CLEAR_STAFF_TOTP=true)"
fi

step="uploads staging"
uploads_staged=true
want_files="$(jq -r .counts.uploadFiles "$snap/meta.json")"
got_files="$(uploads_sh 'rm -rf /u/.restore-*
  mkdir "/u/$STAGE"
  tar -xzf - -C "/u/$STAGE"
  chown -R nextjs:nodejs "/u/$STAGE"
  find "/u/$STAGE" -mindepth 1 ! -type d | wc -l' < "$snap/uploads.tar.gz")"
[ "$got_files" = "$want_files" ] || die "staged $got_files upload files, the snapshot lists $want_files"
note "uploads staged in $uploads_volume:/$stage ($got_files files)"

# --- swap: the demo is down from here until both health checks answer.
step="stop app + portal"
t_down="$(date +%s.%N)"
stopped=true
docker stop -t 10 "$LIVE_APP" "$LIVE_PORTAL" >/dev/null

step="database swap"
db_exists "$db" && had_live_db=true
kick "$db"
kick "$tmp_db"
if $had_live_db; then
  live_sql postgres "ALTER DATABASE \"$db\" RENAME TO \"$old_db\"; ALTER DATABASE \"$tmp_db\" RENAME TO \"$db\""
else
  live_sql postgres "ALTER DATABASE \"$tmp_db\" RENAME TO \"$db\""
fi
db_swapped=true tmp_created=false

step="uploads swap"
old_moving=true
uploads_sh 'mkdir "/u/$OLD"
  find /u -mindepth 1 -maxdepth 1 ! -name "$STAGE" ! -name ".old-*" -exec mv -t "/u/$OLD" {} +'
new_moving=true
uploads_sh 'find "/u/$STAGE" -mindepth 1 -maxdepth 1 -exec mv -t /u {} +
  rmdir "/u/$STAGE"'

step="audit env"
# A demo stack's app env carries what the tamper-evident audit needs (backed up first; an existing key is kept).
ensure_demo_audit_env "$live_dir/.env.production" "$live_dir/backups"
step="tenant id"
prev_tenant="$(env_get "$live_dir/.env.production" DEBIT_MANDATE_CREDITOR_TENANT_ID)"
env_changed=true
env_set "$live_dir/.env.production" DEBIT_MANDATE_CREDITOR_TENANT_ID "$tenant_id"

step="start app + portal"
compose_up
step="health check"
wait_health "$staff_addr"
wait_health "$portal_addr"
t_up="$(date +%s.%N)"
committed=true

# --- healthy on the new data: only now drop what the rollback would need. The
# restore has succeeded, so a cleanup failure is a warning, never a failure.
set +e
warnings=""
warn() { note "WARNING: $1"; warnings="$warnings; $1"; }
# DEMO ONLY: presenters sign in live in front of prospects and the data is
# synthetic, so the demo's staff have no TOTP (product owner, 2026-10-13). The
# bake's seed enrols it; clear it again here. Only the platform operator
# (SUPER_ADMIN) keeps it. This sits behind the DEMO_MODE=true target guard above
# and must never be carried into a real lender deployment: staff 2FA is on by
# default there (CLAUDE.md).
cleared="$(live_sql "$db" 'WITH c AS (UPDATE "User" SET "totpEnabled" = false, "totpSecret" = NULL, "lastTotpCounter" = NULL WHERE role <> '"'SUPER_ADMIN'"' RETURNING 1) SELECT count(*) FROM c')" \
  && note "demo staff TOTP cleared for $cleared non-SUPER_ADMIN users" \
  || warn "could not clear demo staff TOTP; staff still need an authenticator code"
live_sql "$db" "$TENANT_TOTP_POLICY_OFF_SQL" >/dev/null \
  && note "demo staff 2FA policy switched off (TenantConfig.requireStaffTotp)" \
  || warn "could not switch off the demo staff 2FA policy; staff without TOTP are held at enrolment"
# Same reason, same guard: one presenter approves and pays out (prisma/demo-lender.ts).
live_sql "$db" "$TENANT_SOD_OFF_SQL" >/dev/null \
  && note "demo segregation of duties switched off (TenantConfig.requireSegregationOfDuties)" \
  || warn "could not switch off segregation of duties; the approver cannot pay out in the demo"
# dpd-update is scheduled in-process (lib/registry/cron-jobs/091-dunning.ts), but
# the restored baked database lags it: arrears days would stay as baked while
# the calendar moves on ("27 days in arrears" on an instalment 30 days overdue)
# until the next 02:00 run. Run it now; it is idempotent.
cron_secret="$(env_get "$SHARED_SECRETS" CRON_SECRET 2>/dev/null)"
if [ -n "$cron_secret" ] \
  && curl -sf --max-time 120 -o /dev/null -H @<(printf 'x-cron-secret: %s\n' "$cron_secret") "http://$staff_addr/api/cron/dpd-update"; then
  note "arrears days refreshed for today (dpd-update)"
else
  warn "could not refresh arrears days (dpd-update); they stay as baked"
fi
if $had_live_db; then
  live_sql postgres "DROP DATABASE \"$old_db\" WITH (FORCE)" || warn "could not drop $old_db"
fi
# Only this run's old db, like the uploads below: earlier failed runs' leftovers are kept for manual recovery.
# Only this run's .old dir: earlier ones are not ours to delete.
uploads_sh 'rm -rf "/u/$OLD"' || warn "could not remove $uploads_volume:/$old_uploads"

summary="$(awk -v t0="$t0" -v td="$t_down" -v tu="$t_up" -v t1="$(date +%s.%N)" \
  'BEGIN { printf "in %.1f s, %.1f s down", t1 - t0, tu - td }')"
record_result restore "ok ${snap##*/} $summary${warnings:+ (warnings$warnings)}"
echo "restore: ${snap##*/} restored $summary (staff $staff_addr + portal $portal_addr healthy)${warnings:+; warnings$warnings}"
