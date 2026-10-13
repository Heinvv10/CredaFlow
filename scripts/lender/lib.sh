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
#   backups/               encrypted pg_dump files + row-count sidecars
#   state/                 image.env, current-image, previous-image, deploys.log

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

# load_lender DIR — sets LENDER_DIR, ENV_FILE, STATE_DIR, SLUG, PROJECT, PGUSER, PGDB, APP_PORT.
load_lender() {
  [ -n "${1:-}" ] || die "usage: ${0##*/} <lender-dir> …"
  [ -d "$1" ] || die "lender dir $1 does not exist (run provision-lender.sh first)"
  LENDER_DIR="$(cd "$1" && pwd)"
  ENV_FILE="$LENDER_DIR/.env"
  STATE_DIR="$LENDER_DIR/state"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing (run provision-lender.sh first)"
  SLUG="$(env_get "$ENV_FILE" NEXT_PUBLIC_TENANT_SLUG)"
  [[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || die "NEXT_PUBLIC_TENANT_SLUG in $ENV_FILE is missing or malformed"
  PROJECT="credaflow-$SLUG"
  PGUSER="$(env_get "$ENV_FILE" POSTGRES_USER)" PGDB="$(env_get "$ENV_FILE" POSTGRES_DB)"
  APP_PORT="$(env_get "$ENV_FILE" APP_PORT)"
  [ -n "$PGUSER" ] && [ -n "$PGDB" ] && [ -n "$APP_PORT" ] || die "$ENV_FILE lacks POSTGRES_USER, POSTGRES_DB or APP_PORT"
  mkdir -p "$STATE_DIR"
}

# lcompose ARGS… — compose on this lender's project only. -p/-f/--project-directory
# are explicit so a COMPOSE_PROJECT_NAME or COMPOSE_FILE in the caller's
# environment cannot point `down`/`up` at another stack.
lcompose() {
  local envs=(--env-file "$ENV_FILE") pre=(env)
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

# tools_image_of REPO:TAG — the matching image that holds the CLIs (prisma, tsx, the scripts).
tools_image_of() { echo "${1%:*}-tools:${1##*:}"; }

image_commit() { docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^GIT_SHA=//p'; }

# build_images IMAGE TOOLS — build both targets of the Dockerfile from the
# checkout this script lives in. The image is `runner`; the tools image is the
# `builder` stage (prisma CLI, tsx, the scripts), which the runner image lacks.
# Refuses a dirty tree: the image would match no commit. BUILD_TIME is the
# commit's time, so a rebuild of the same commit is fully cached.
build_images() {
  local image="$1" tools="$2" args v
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "refusing to build: $REPO_ROOT is not a git checkout"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] \
    || die "refusing to build: working tree at $REPO_ROOT is dirty (commit or stash first; the image would match no commit)"
  args=(--build-arg "GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
        --build-arg "BUILD_TIME=$(git -C "$REPO_ROOT" show -s --format=%cI HEAD)"
        --build-arg "NEXT_PUBLIC_TENANT_SLUG=$SLUG")
  for v in "${BUILD_PUBLIC_VARS[@]}"; do
    [ -z "$(env_get "$ENV_FILE" "$v")" ] || args+=(--build-arg "$v=$(env_get "$ENV_FILE" "$v")")
  done
  note "building $image and $tools from $(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  docker build "${args[@]}" --target runner -t "$image" "$REPO_ROOT"
  docker build "${args[@]}" --target builder -t "$tools" "$REPO_ROOT"
}

# ensure_images IMAGE BUILD(true|false) — both images present locally.
ensure_images() {
  local image="$1" build="$2" tools i
  [[ "$image" == *:* ]] || die "image '$image' needs an explicit tag (name:tag)"
  tools="$(tools_image_of "$image")"
  if [ "$build" = true ]; then build_images "$image" "$tools"; return; fi
  for i in "$image" "$tools"; do
    docker image inspect "$i" >/dev/null 2>&1 && continue
    note "pulling $i"
    docker pull "$i" >/dev/null || die "cannot find or pull $i (use --build from a clean checkout, or publish both images)"
  done
}

# health_ok URL EXPECT_COMMIT — one probe: HTTP 200, status ok (the route runs
# SELECT 1, so this includes the database) and, unless the image carries no
# commit, the commit it reports equals the one this image was built from.
health_ok() {
  local body
  body="$(curl -fsS --max-time 5 "$1" 2>/dev/null)" || return 1
  [ "$(jq -r .status <<<"$body" 2>/dev/null)" = ok ] || return 1
  [ -z "$2" ] || [ "$2" = unknown ] || [ "$(jq -r .commit <<<"$body" 2>/dev/null)" = "$2" ]
}

# wait_health URL EXPECT_COMMIT TIMEOUT_SECONDS
wait_health() {
  local deadline=$((SECONDS + $3))
  while [ "$SECONDS" -lt "$deadline" ]; do
    health_ok "$1" "$2" && return 0
    sleep 2
  done
  return 1
}

# The row counts a backup records (backup.sh) and a restore verifies (restore.sh).
COUNTS_SQL="$(cat <<'SQL'
SELECT 'Tenant='||count(*) FROM "Tenant" UNION ALL SELECT 'User='||count(*) FROM "User"
UNION ALL SELECT 'Client='||count(*) FROM "Client" UNION ALL SELECT 'LoanApplication='||count(*) FROM "LoanApplication"
UNION ALL SELECT 'Loan='||count(*) FROM "Loan" UNION ALL SELECT 'Payment='||count(*) FROM "Payment"
UNION ALL SELECT 'AuditLog='||count(*) FROM "AuditLog" UNION ALL SELECT 'migrations='||count(*) FROM _prisma_migrations
SQL
)"
