# shellcheck shell=bash
# Shared wiring for the lender scripts (sourced, not run). Nothing here is
# specific to a host: every path is derived from the lender directory, every
# Docker name from the lender slug, and no secret is ever echoed (values are
# read from the 0600 .env by key and handed to containers by variable name).
#
# Lender directory layout (created by provision-lender.sh, outside git):
#   lender.json            the tenant config (no secrets)
#   .env                   generated secrets + settings, mode 0600
#   docker-compose.yml     copy of docker-compose.lender.yml
#   secrets/backup.passphrase   encrypts backups, mode 0600. COPY IT OFF THIS HOST.
#   secrets/auth.env       STAFF_AUTH_SECRET + PORTAL_AUTH_SECRET, mode 0600; compose interpolation only
#   backups/               encrypted pg_dump files + row-count sidecars
#   state/                 image.env, current-image, previous-image, deploys.log, lender.lock

LENDER_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LENDER_SCRIPTS/../.." && pwd)"
# NEXT_PUBLIC_* values the Dockerfile bakes into the image at build time.
BUILD_PUBLIC_VARS=(NEXT_PUBLIC_TURNSTILE_SITE_KEY NEXT_PUBLIC_PORTAL_LOGIN_URL NEXT_PUBLIC_MATOMO_URL NEXT_PUBLIC_MATOMO_SITE_ID NEXT_PUBLIC_GTM_ID NEXT_PUBLIC_POSTHOG_KEY NEXT_PUBLIC_POSTHOG_HOST)

die() { echo "${0##*/}: $*" >&2; exit 1; }
note() { echo "[${0##*/} $(date -u +%H:%M:%S)] $*" >&2; }
need() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"; done; }
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# env_get FILE KEY — one value from a dotenv file (empty when absent).
env_get() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true; }

# env_set FILE KEY VALUE — replace or append, keeping the file's mode.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  { grep -v "^$key=" "$file" || true; } > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp"
  mv "$tmp" "$file"
}

# load_lender DIR — sets LENDER_DIR, ENV_FILE, AUTH_ENV, STATE_DIR, SLUG, PROJECT, PGUSER, PGDB, APP_PORT, PORTAL_PORT.
load_lender() {
  [ -n "${1:-}" ] || die "usage: ${0##*/} <lender-dir> …"
  [ -d "$1" ] || die "lender dir $1 does not exist (run provision-lender.sh first)"
  LENDER_DIR="$(cd "$1" && pwd -P)"
  ENV_FILE="$LENDER_DIR/.env"
  STATE_DIR="$LENDER_DIR/state"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing (run provision-lender.sh first)"
  SLUG="$(env_get "$ENV_FILE" NEXT_PUBLIC_TENANT_SLUG)"
  [[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || die "NEXT_PUBLIC_TENANT_SLUG in $ENV_FILE is missing or malformed"
  PROJECT="$(project_of "$SLUG")"
  PGUSER="$(env_get "$ENV_FILE" POSTGRES_USER)" PGDB="$(env_get "$ENV_FILE" POSTGRES_DB)"
  APP_PORT="$(env_get "$ENV_FILE" APP_PORT)" PORTAL_PORT="$(env_get "$ENV_FILE" PORTAL_PORT)"
  [ -n "$PGUSER" ] && [ -n "$PGDB" ] && [ -n "$APP_PORT" ] && [ -n "$PORTAL_PORT" ] \
    || die "$ENV_FILE lacks POSTGRES_USER, POSTGRES_DB, APP_PORT or PORTAL_PORT"
  AUTH_ENV="$LENDER_DIR/secrets/auth.env"
  # Where the published ports answer: the bound address, with a wildcard bind probed through loopback.
  PROBE_HOST="$(env_get "$ENV_FILE" APP_BIND)"
  case "$PROBE_HOST" in "" | 0.0.0.0 | "::" | "[::]") PROBE_HOST=127.0.0.1 ;; esac
  mkdir -p "$STATE_DIR"
}

# project_of SLUG — the compose project of a lender. The `credaflow-lender-`
# prefix keeps it clear of the other stacks on a host (credaflow-demo,
# credaflow-fairscore, credaflow-staging, …), whose names are `credaflow-<word>`.
project_of() { echo "credaflow-lender-$1"; }

# check_project_free PROJECT DIR FRESH(true|false) — refuse when another stack
# already owns compose project PROJECT, since `up`, `down --volumes` and the volume
# names would otherwise touch it:
#   - a container carrying the project label must record DIR as its working_dir;
#   - volumes and networks do not record a working_dir, so they cannot prove who owns
#     them: for a FRESH lender directory (no .env yet) any of them is a collision;
#     for a rerun in an existing directory they are presumed this lender's own.
check_project_free() {
  local project="$1" dir="$2" fresh="$3" got wd kind
  got="$(docker ps -a --filter "label=com.docker.compose.project=$project" --format 'dir={{.Label "com.docker.compose.project.working_dir"}}' | sort -u)" || die "cannot list docker containers"
  if [ -n "$got" ]; then
    while IFS= read -r wd; do
      wd="${wd#dir=}"   # the prefix keeps a blank label from vanishing in $( )
      [ "$wd" = "$dir" ] || die "refusing: docker compose project '$project' already has a container with working_dir '${wd:-<none>}', not '$dir'. Pick another slug or lender dir; never reuse another stack's project."
    done <<<"$got"
  fi
  [ "$fresh" = true ] || return 0
  for kind in "volume ls" "network ls"; do
    # shellcheck disable=SC2086  # $kind is a fixed two-word subcommand
    got="$(docker $kind -q --filter "label=com.docker.compose.project=$project")" || die "cannot list docker $kind"
    [ -z "$got" ] || die "refusing: docker compose project '$project' already has ${kind%% *} resource(s) (${got//$'\n'/ }) and this lender directory is new. Pick another slug; never reuse another stack's project."
  done
}

# lock_fd FD FILE WAIT — take an exclusive flock on FILE through descriptor FD.
# If FD already refers to FILE (the same device and inode) it is REUSED, never
# reopened: a child of a script that holds the lock inherits that very open file
# description, and flock on it is an immediate no-op, so deploy's own backup child
# does not wait on its parent. Nothing in the environment is trusted for this: a
# caller that merely claims to hold the lock either shares the real descriptor
# (and so does hold it) or opens its own and waits like everyone else.
lock_fd() {
  local fd="$1" file="$2" want have
  [ -e "$file" ] || (umask 077; : > "$file")
  want="$(stat -Lc '%d:%i' "$file")"
  have="$(stat -Lc '%d:%i' "/proc/self/fd/$fd" 2>/dev/null || true)"
  [ "$want" = "$have" ] || eval "exec $fd>>\"\$file\""
  flock -w "${LENDER_LOCK_WAIT:-600}" "$fd" || return 1
}

# acquire_project_lock PROJECT — a HOST-WIDE lock per compose project, in the
# user's runtime dir (else a 0700 per-user dir in /tmp), keyed by the project name:
# two lender directories (or a symlink and its target) that would use the same
# project serialise here, so the "is the project free?" check and the `up` that
# claims it cannot interleave. Held to the end of the script.
acquire_project_lock() {
  local base="${XDG_RUNTIME_DIR:-/tmp}/credaflow-lender-locks-$(id -u)"
  mkdir -p -m 700 "$base"
  [ "$(stat -c %u "$base")" = "$(id -u)" ] && [ ! -L "$base" ] || die "lock directory $base is not ours"
  lock_fd 8 "$base/$1.lock" || die "another provision, deploy or restore of compose project '$1' holds $base/$1.lock"
}

# acquire_lender_lock DIR — ONE lock per lender, shared by provision, deploy,
# backup and restore (which call each other). Takes the project lock first, always
# in that order, then the lender's own state/lender.lock. Waits up to
# LENDER_LOCK_WAIT seconds (default 600) so a nightly backup rides out a deploy.
# DIR is canonicalised (pwd -P), so a symlinked path and its target are one lock.
acquire_lender_lock() {
  local dir
  dir="$(cd "$1" 2>/dev/null && pwd -P)" || { mkdir -p "$1" && dir="$(cd "$1" && pwd -P)"; }
  acquire_project_lock "${PROJECT:?}"
  mkdir -p "$dir/state"
  lock_fd 9 "$dir/state/lender.lock" || die "another provision, deploy, backup or restore of this lender holds $dir/state/lender.lock"
}

# lcompose ARGS… — compose on this lender's project only. -p/-f/--project-directory
# are explicit so a COMPOSE_PROJECT_NAME or COMPOSE_FILE in the caller's
# environment cannot point `down`/`up` at another stack, and the environment is
# SCRUBBED (`env -i` plus a short allowlist for talking to the docker daemon):
# compose gives shell variables priority over --env-file, so a stray
# `APP_BIND=0.0.0.0` or `STAFF_AUTH_SECRET=…` in the operator's shell would
# otherwise override what the lender's files say.
lcompose() {
  local envs=(--env-file "$ENV_FILE") pre=(env -i) v
  for v in PATH HOME USER LANG TMPDIR DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY XDG_RUNTIME_DIR; do
    [ -z "${!v:-}" ] || pre+=("$v=${!v}")
  done
  [ ! -f "$AUTH_ENV" ] || envs+=(--env-file "$AUTH_ENV")
  # Compose interpolates the whole file even for `up db`. Before the first deploy
  # there is no state/image.env, so name an image that cannot exist (a stray
  # `up app` then fails: pull_policy never) instead of failing every command.
  if [ -f "$STATE_DIR/image.env" ]; then envs+=(--env-file "$STATE_DIR/image.env"); else pre+=(APP_IMAGE=credaflow-undeployed:none); fi
  if docker compose version >/dev/null 2>&1; then
    "${pre[@]}" docker compose -p "$PROJECT" -f "$LENDER_DIR/docker-compose.yml" --project-directory "$LENDER_DIR" "${envs[@]}" "$@"
  else
    "${pre[@]}" docker-compose -p "$PROJECT" -f "$LENDER_DIR/docker-compose.yml" --project-directory "$LENDER_DIR" "${envs[@]}" "$@"
  fi
}

# The uploads volume compose creates for this project (the `uploads` volume of
# docker-compose.lender.yml), and the image that tars it: the database image,
# which every lender host already has and which carries tar.
uploads_volume() { echo "${PROJECT:?}_uploads"; }
UPLOADS_HELPER_IMAGE=postgres:16-alpine

# RESTORE_UPLOADS_SH — runs INSIDE a helper container (busybox sh) with the
# volume at /u, a tar on stdin, env TS and EXPECT (restore-uploads). Unpacks into
# /u/.restore-$TS and counts the files; only if the count is EXPECT does it move
# the live entries into /u/.pre-restore-$TS and the restored ones into place.
# Earlier .restore-*/.pre-restore-* directories are left where they are. Prints
# the count. tar runs as root, so files keep the owner recorded in the archive.
RESTORE_UPLOADS_SH="$(cat <<'SH'
set -eu
stage="/u/.restore-$TS"; old="/u/.pre-restore-$TS"
mkdir "$stage"
tar -xf - -C "$stage"
n="$(find "$stage" -type f | wc -l | tr -d ' ')"
if [ "$n" != "$EXPECT" ]; then rm -rf "$stage"; echo "restored $n file(s), expected $EXPECT" >&2; exit 1; fi
mkdir "$old"
for e in /u/* /u/.[!.]*; do
  [ -e "$e" ] || continue
  case "${e#/u/}" in .restore-*|.pre-restore-*) continue ;; esac
  mv "$e" "$old/"
done
for e in "$stage"/* "$stage"/.[!.]*; do
  [ -e "$e" ] || continue
  mv "$e" /u/
done
rmdir "$stage"
echo "$n"
SH
)"

# psql_db DB SQL — one query in database DB, inside the db container as its own
# superuser over the local socket (no password crosses the host shell).
psql_db() { lcompose exec -T db psql -v ON_ERROR_STOP=1 -qAt -U "$PGUSER" -d "$1" -c "$2"; }

wait_db() {
  local i
  for i in $(seq 1 60); do
    lcompose exec -T db pg_isready -q -U "$PGUSER" -d "$PGDB" && return 0
    sleep 2
  done
  die "database did not become ready"
}

# tools_run IMAGE [DOCKER_OPTS… --] CMD… — a one-shot container of the tools
# image on the project network, as root, with DATABASE_URL passed by name (the
# password is not in argv). Without a `--`, everything after IMAGE is the command.
tools_run() {
  local image="$1" opts=(); shift
  if printf '%s\n' "$@" | grep -qx -- '--'; then
    while [ "$1" != "--" ]; do opts+=("$1"); shift; done
    shift
  fi
  DATABASE_URL="postgresql://$PGUSER:$(env_get "$ENV_FILE" POSTGRES_PASSWORD)@db:5432/$PGDB?schema=public" \
    docker run --rm -e DATABASE_URL -e "LENDER_OPERATOR=$(id -un)@$(hostname)" --network "${PROJECT}_default" "${opts[@]}" "$image" "$@"
}

# The rest, split out to keep each file small: images and builds, then health and
# the rendered-config gate. Sourced here, so every script that sources lib.sh has them.
# shellcheck source=scripts/lender/lib-images.sh
. "$LENDER_SCRIPTS/lib-images.sh"
# shellcheck source=scripts/lender/lib-health.sh
. "$LENDER_SCRIPTS/lib-health.sh"
