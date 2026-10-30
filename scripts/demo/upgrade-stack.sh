#!/usr/bin/env bash
# Upgrades a SECONDARY demo stack (today: Fairscore) in place to a commit,
# keeping its database. The Acme demo moves by bake + restore instead.
#
#   scripts/demo/upgrade-stack.sh [--allow-downgrade] [commit]
#
#   DEMO_LIVE_PROJECT=credaflow-fairscore LIVE_DIR=~/Workspace/CredaFlow-fairscore \
#     DEMO_DATA_DIR=~/credaflow-fairscore-data scripts/demo/upgrade-stack.sh
#
#   commit            reachable from a local branch or origin/*; default: the
#                     commit the Acme demo runs now (its app image tag
#                     credaflow:demo-<sha>).
#   --allow-downgrade go even if the commit is not the stack's current commit or
#                     a descendant of it, or the current commit cannot be read
#                     (logged as a WARNING). Migrations are forward-only.
#
# The target is the compose project $DEMO_LIVE_PROJECT in $LIVE_DIR (lib.sh).
# Refuses the Acme demo itself (project credaflow-demo or its default LIVE_DIR),
# and, before touching anything, unless app, portal and db carry that compose
# project label with working_dir $LIVE_DIR, app and portal run DEMO_MODE=true,
# and the db is published on 127.0.0.1. Takes bake, restore and cron-run locks
# (non-blocking, held to the end). Helpers are in upgrade-stack.lib.sh.
#
# Then, in this order:
#   1. the commit must be the stack's current one (image tag, else GIT_SHA:
#      <prefix>-<sha>) or a descendant; every slug in TENANT_HOST_MAP
#      ($LIVE_DIR/.env.production, host=slug,...) and NEXT_PUBLIC_TENANT_SLUG
#      ($LIVE_DIR/.env, baked into the image) must be an ACTIVE Tenant in the
#      stack's db; an existing image of the target name must carry that slug in
#      its credaflow.tenant_slug label (build-image.sh, DEMO_IMAGE_NAME); every
#      key of $DEMO_DATA_DIR/secrets.env must equal the running app's env value
#      (compared as hashes; only key names are ever printed);
#   2. pre-flights: `docker-compose config -q`; then, in a temporary detached
#      `git worktree` at the commit (removed on exit), npm ci --legacy-peer-deps
#      (tsx and the prisma CLI, which the image lacks) and `prisma migrate
#      status` (proves the connection, logs pending migrations; a failed or
#      diverged history dies);
#   3. build credaflow:<project suffix>-<short sha> with build-image.sh
#      (DEMO_BUILD_ROOT/DEMO_IMAGE_NAME; DEMO_LENDER defaults to
#      NEXT_PUBLIC_TENANT_SLUG);
#   4. back up: pg_dump -Fc (docker exec, the db container's own POSTGRES_*) into
#      $LIVE_DIR/backups/pre-<short sha>-<UTC>.dump, read in full by `pg_restore -f /dev/null`,
#      plus .env and .env.production beside it. Never pruned: delete by hand;
#      Then, on a DEMO_MODE=true stack only, .env.production gets AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 and an
#      AUDIT_CHAIN_KEY when it lacks them (ensure_demo_audit_env in lib.sh: backed up first, an existing key is never
#      replaced), so the new image boots and the tamper-evident audit can be shown;
#   5. `prisma migrate deploy` from the worktree against the db's published
#      127.0.0.1 port; DATABASE_URL (it has the password) is env-only, never argv;
#      then segregation of duties off for the demo tenant (TENANT_SOD_OFF_SQL)
#      and every tenant marked as a demo lender (TENANT_DEMO_LENDER_SQL);
#   6. pin APP_IMAGE, GIT_SHA, BUILD_TIME in $LIVE_DIR/.env, `up -d --no-deps
#      app app-portal`, and verify: /api/health on both, both containers run the
#      new image, and every TENANT_HOST_MAP host gets 200 (Host: header) from the
#      staff /login and portal /portal/login, which exercises tenant resolution.
#
# A failure from the pin on puts the previous pin back and starts app + portal
# again. Migrations are forward-only and are NOT undone, so that may be old code
# on the new schema; the message gives the pg_restore command for the dump. The
# stack's existing snapshots are on the previous image, so restore.sh refuses
# them until a new bake. The outcome goes to $LOG_DIR/last-upgrade (status.sh
# does not read it).
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=scripts/demo/upgrade-stack.lib.sh
. "$(dirname "$0")/upgrade-stack.lib.sh"

# The Acme demo's staff container, whatever DEMO_LIVE_PROJECT names.
ACME_PROJECT=credaflow-demo
ACME_APP="$ACME_PROJECT-app"

want="" allow_downgrade=false
for arg in "$@"; do
  case "$arg" in
    --allow-downgrade) allow_downgrade=true ;;
    -*) die "unknown option $arg (a commit must not start with \"-\"); usage: upgrade-stack.sh [--allow-downgrade] [commit]" ;;
    *) [ -z "$want" ] || die "usage: upgrade-stack.sh [--allow-downgrade] [commit]"; want="$arg" ;;
  esac
done

# --- target guard: nothing below runs against the Acme demo or a non-demo stack.
# lib.sh's own LIVE_DIR default is the Acme demo's dir (read in a subshell, where LIVE_DIR is unset).
acme_dir="$(unset LIVE_DIR; . "$(dirname "$0")/lib.sh"; printf %s "$LIVE_DIR")"
[ "$LIVE_PROJECT" != "$ACME_PROJECT" ] && [ "$(readlink -m "$LIVE_DIR")" != "$(readlink -m "$acme_dir")" ] \
  || die "refusing: $LIVE_PROJECT in $LIVE_DIR is the Acme demo; it is upgraded by bake + restore, not by this script"
suffix="${LIVE_PROJECT#credaflow-}"
[[ "$LIVE_PROJECT" == credaflow-* && "$suffix" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
  || die "refusing: DEMO_LIVE_PROJECT '$LIVE_PROJECT' is not credaflow-<name>"
# Kept in sync with restore.sh (its `label`, target guard and POSTGRES_DB checks).
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
for c in "$LIVE_APP" "$LIVE_PORTAL"; do
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -x 'DEMO_MODE=true' >/dev/null \
    || die "refusing: $c does not run with DEMO_MODE=true, so it is not a demo stack"
done
db="$(docker exec "$LIVE_DB" printenv POSTGRES_DB)" || die "cannot read POSTGRES_DB in $LIVE_DB"
db_user="$(docker exec "$LIVE_DB" printenv POSTGRES_USER)" || die "cannot read POSTGRES_USER in $LIVE_DB"
[ "$db" != postgres ] || die "refusing: POSTGRES_DB is the maintenance db"
[[ "$db" =~ ^[a-z_][a-z0-9_]{0,40}$ ]] || die "refusing: unexpected POSTGRES_DB name '$db'"
db_bind="$(docker port "$LIVE_DB" 5432 | grep '^127\.0\.0\.1:' | sed -n 1p)" \
  || die "refusing: $LIVE_DB port 5432 is not published on 127.0.0.1"
env_file="$live_dir/.env" prod_env_file="$live_dir/.env.production"
[ "$(env_get "$env_file" POSTGRES_DB)" = "$db" ] && [ "$(env_get "$env_file" POSTGRES_USER)" = "$db_user" ] \
  || die "refusing: POSTGRES_USER/POSTGRES_DB in $env_file are not the ones $LIVE_DB runs with"
db_password="$(env_get "$env_file" POSTGRES_PASSWORD)"
[ -n "$db_password" ] || die "POSTGRES_PASSWORD missing from $env_file"
prev_image="$(env_get "$env_file" APP_IMAGE)"
[ -n "$prev_image" ] || die "APP_IMAGE missing from $env_file"
prev_sha="$(env_get "$env_file" GIT_SHA)" prev_time="$(env_get "$env_file" BUILD_TIME)"

# The running containers must be the .env pin: the rollback and the downgrade check trust it.
for c in "$LIVE_APP" "$LIVE_PORTAL"; do
  got="$(docker inspect -f '{{.Config.Image}}' "$c")" || die "cannot read the image of $c"
  [ "$got" = "$prev_image" ] || die "refusing: .env pins $prev_image but $c runs $got; reconcile first"
done

mkdir -p "$DEMO_DATA_DIR"
exec 7>"$BAKE_LOCK" 8>"$RESTORE_LOCK" 9>"$CRON_RUN_LOCK"
flock -n 7 || die "a bake is running ($BAKE_LOCK)"
flock -n 8 || die "a restore is running ($RESTORE_LOCK)"
flock -n 9 || die "a cron job is running or queued ($CRON_RUN_LOCK)"

# --- the commit: explicit, or the one the Acme demo image names.
if [ -z "$want" ]; then
  demo_image="$(docker inspect -f '{{.Config.Image}}' "$ACME_APP" 2>/dev/null)" || die "cannot read the image of $ACME_APP; pass a commit"
  [[ "$demo_image" =~ ^credaflow:demo-([0-9a-f]{7,40})$ ]] \
    || die "$ACME_APP runs '$demo_image', not a clean credaflow:demo-<sha> image; pass a commit"
  want="${BASH_REMATCH[1]}"
fi
sha="$(git -C "$DEMO_ROOT" rev-parse --verify --quiet "$want^{commit}")" || die "no commit $want"
[ -n "$(git -C "$DEMO_ROOT" for-each-ref --contains "$sha" refs/heads refs/remotes/origin)" ] \
  || die "$sha is not reachable from any local branch or origin/*"
short="$(git -C "$DEMO_ROOT" rev-parse --short "$sha")"
image="credaflow:$suffix-$short"
check_downgrade

staff_addr="$(host_port "$LIVE_APP")" portal_addr="$(host_port "$LIVE_PORTAL")"
[ -n "$staff_addr" ] && [ -n "$portal_addr" ] || die "cannot read the published :3300 ports of $LIVE_APP / $LIVE_PORTAL"

# Rollback state: which steps have happened.
step=setup work="" wt="" dump="" migrating=false env_changed=false committed=false

cleanup_and_report() {
  local rc=$? outcome
  trap '' INT TERM HUP
  set +e
  if [ -n "$wt" ] && [ -d "$wt" ]; then git -C "$DEMO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1; fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
  { $committed || [ "$rc" -eq 0 ]; } && return 0
  note "FAILED during $step (exit $rc)"
  if $env_changed; then
    env_set "$env_file" APP_IMAGE "$prev_image"
    env_set "$env_file" GIT_SHA "$prev_sha"
    env_set "$env_file" BUILD_TIME "$prev_time"
    if compose_up && wait_health "$staff_addr" && wait_health "$portal_addr"; then
      if check_running_image "$prev_image"; then
        outcome="previous image $prev_image is live again"
      else
        outcome="put the previous pin back and app/portal are healthy, BUT they are NOT running $prev_image (see above); check docker ps"
      fi
    else
      outcome="put the previous pin back BUT app/portal did not come back healthy"
    fi
  else
    outcome="the running stack was not touched"
  fi
  if $migrating; then
    outcome="$outcome. WARNING: migrations are forward-only and were not undone, so the stack may be running old code on the new schema. To get the data back as it was before this run, stop app + portal, then run: $(restore_hint) (the matching .env files sit beside the dump)"
  fi
  note "$outcome"
  record_result upgrade "failed (exit $rc) $LIVE_PROJECT $short during $step: $outcome"
  # Whatever the failing tool's code was, a failed upgrade exits 1 (130 stays a signal).
  [ "$rc" -eq 130 ] && exit 130
  exit 1
}
trap cleanup_and_report EXIT
trap 'exit 130' INT TERM HUP

t0="$(date +%s)"
note "upgrading $LIVE_PROJECT ($prev_image) to $image"

# --- 1. prechecks, nothing built or changed yet.
step="tenant slug precheck"
active="$(live_sql "$db" "SELECT slug FROM \"Tenant\" WHERE status = 'ACTIVE'")"
host_map="$(env_get "$prod_env_file" TENANT_HOST_MAP)"
[ -n "$host_map" ] || die "no TENANT_HOST_MAP in $prod_env_file; the app would resolve no tenant"
IFS=, read -ra entries <<<"$host_map"
for entry in "${entries[@]}"; do
  slug="${entry#*=}"
  slug="${slug//[[:space:]]/}"
  [[ "$entry" == *=* && -n "$slug" ]] || die "TENANT_HOST_MAP entry '$entry' in $prod_env_file is not host=slug"
  require_active "$slug" "TENANT_HOST_MAP ($entry)"
done
tenant_slug="$(env_get "$env_file" NEXT_PUBLIC_TENANT_SLUG)"
[ -n "$tenant_slug" ] || die "NEXT_PUBLIC_TENANT_SLUG missing from $env_file"
require_active "$tenant_slug" "NEXT_PUBLIC_TENANT_SLUG in $env_file (baked into the image)"
note "tenant slugs resolve in $db"
# An existing image of this name is reused as is, so it must serve this tenant.
if docker image inspect "$image" >/dev/null 2>&1; then
  built_for="$(docker image inspect -f '{{index .Config.Labels "credaflow.tenant_slug"}}' "$image")"
  [ "$built_for" = "$tenant_slug" ] \
    || die "$image was built for tenant slug '$built_for' (empty: built before the label existed), but NEXT_PUBLIC_TENANT_SLUG is '$tenant_slug'; docker rmi $image to rebuild it"
fi
step="secrets check"
check_secrets

# --- 2. pre-flights, before the build and the backup.
step="docker-compose config"
compose config -q \
  || die "docker-compose config failed in $live_dir; fix the compose file or its env before upgrading"
work="$(mktemp -d)"
wt="$work/tree"
step="git worktree at $short"
git -C "$DEMO_ROOT" worktree add --quiet --detach "$wt" "$sha"
step="npm ci"
(cd "$wt" && NODE_ENV='' npm ci --legacy-peer-deps) >&2
# The URL carries the password: environment only, never argv.
# shellcheck disable=SC2016  # the template literal is JavaScript, not shell
db_url="$(DB_USER="$db_user" DB_PASS="$db_password" DB_NAME="$db" DB_ADDR="$db_bind" node -e 'const e = process.env; process.stdout.write(`postgresql://${encodeURIComponent(e.DB_USER)}:${encodeURIComponent(e.DB_PASS)}@${e.DB_ADDR}/${encodeURIComponent(e.DB_NAME)}?schema=public`)')"
step="prisma migrate status"
migrate_status

# --- 3. the image.
step="build $image"
built="$(DEMO_BUILD_ROOT="$wt" DEMO_IMAGE_NAME="$image" DEMO_LENDER="${DEMO_LENDER:-$tenant_slug}" "$(dirname "$0")/build-image.sh")"
[ "$built" = "$image" ] || die "build-image.sh built '$built', expected $image"

# --- 4. backup.
step="backup"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
backups="$live_dir/backups"
(umask 077; mkdir -p "$backups")
dump="$backups/pre-$short-$ts.dump"
(umask 077; docker exec "$LIVE_DB" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$dump") \
  || { rm -f "$dump"; die "pg_dump of $db failed"; }
[ -s "$dump" ] || { rm -f "$dump"; die "pg_dump wrote nothing for $db; not upgrading without a backup"; }
docker exec -i "$LIVE_DB" pg_restore -f /dev/null < "$dump" \
  || { rm -f "$dump"; die "pg_restore cannot read the dump of $db; not upgrading without a usable backup"; }
(umask 077; cp "$env_file" "$backups/.env.pre-$short-$ts"; cp "$prod_env_file" "$backups/.env.production.pre-$short-$ts")
note "backed up $db to $dump"
step="audit env"
ensure_demo_audit_env "$prod_env_file" "$backups"

# --- 5. migrate.
step="migrate"
migrating=true
(cd "$wt" && DATABASE_URL="$db_url" NODE_ENV='' npx prisma migrate deploy) >&2
# Demo stacks only (the DEMO_MODE=true target guard above), as restore.sh does:
# a migration that adds TenantConfig.requireSegregationOfDuties defaults it ON
# for the existing tenant, and the presenter approves and pays out as one admin.
step="segregation of duties off"
live_sql "$db" "$TENANT_SOD_OFF_SQL" >/dev/null \
  && note "demo segregation of duties switched off (TenantConfig.requireSegregationOfDuties)" \
  || note "WARNING: could not switch off segregation of duties; the approver cannot pay out in the demo"
# Same guard: a migration that adds TenantConfig.isDemoLender leaves it false on the
# existing tenants, and the demo's simulated Section 129 email needs it.
step="demo lender marker"
live_sql "$db" "$TENANT_DEMO_LENDER_SQL" >/dev/null \
  && note "tenants marked as demo lenders (TenantConfig.isDemoLender)" \
  || note "WARNING: could not mark the demo lenders; Section 129 notices in the demo fail instead of being simulated"

# --- 6. swap and verify.
step="pin $image"
env_changed=true
env_set "$env_file" APP_IMAGE "$image"
env_set "$env_file" GIT_SHA "${image#credaflow:}"
env_set "$env_file" BUILD_TIME "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
step="start app + portal"
compose_up
verify_swap
committed=true

summary="in $(( $(date +%s) - t0 )) s"
record_result upgrade "ok $LIVE_PROJECT $short $summary"
echo "upgrade-stack: $LIVE_PROJECT now runs $image $summary (staff $staff_addr + portal $portal_addr healthy, tenant pages 200; backup $dump)"
