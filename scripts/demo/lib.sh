# shellcheck shell=bash disable=SC2034  # sourced: the variables are used by its callers
# Shared wiring for the demo bake/restore scripts (sourced, not run).
#
#   DEMO_DATA_DIR  untracked demo state outside git; default ~/credaflow-demo-data
#                  secrets.env  the shared secrets (ensure_shared_secrets, 0600)
#                  snapshots/   bake output, one dir per UTC timestamp + `latest`
#                  logs/        cron logs (cron-run.sh)
#                  logs/LAST_FAILURE-<job>, last-bake, last-restore  results (status.sh)
#                  bake.lock, restore.lock, cron-run.lock  the jobs' flock files
#                  runner.json  the runner's last update (update-runner.sh)
#   LIVE_DIR       the live demo's compose project dir; default ~/Workspace/CredaFlow-demo
#   DEMO_RUNNER_DIR  the clean checkout cron runs from; default ~/Workspace/CredaFlow-demo-runner
#
# Every Docker name the demo scripts touch is defined once, below. The live
# project name can be overridden (DEMO_LIVE_PROJECT) only to point restore.sh
# at a throwaway copy of the live stack for testing; restore.sh still refuses
# any target that is not a DEMO_MODE=true stack of that project in $LIVE_DIR.
#
# Nothing here prints a secret value: env files are read key by key into shell
# variables (env_get) and handed to containers by name, never echoed.

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DATA_DIR="${DEMO_DATA_DIR:-$HOME/credaflow-demo-data}"
LIVE_DIR="${LIVE_DIR:-$HOME/Workspace/CredaFlow-demo}"
SHARED_SECRETS="$DEMO_DATA_DIR/secrets.env"
SNAP_DIR="$DEMO_DATA_DIR/snapshots"
LOG_DIR="$DEMO_DATA_DIR/logs"
BAKE_LOCK="$DEMO_DATA_DIR/bake.lock"
RESTORE_LOCK="$DEMO_DATA_DIR/restore.lock"
CRON_RUN_LOCK="$DEMO_DATA_DIR/cron-run.lock"
DEMO_RUNNER_DIR="${DEMO_RUNNER_DIR:-$HOME/Workspace/CredaFlow-demo-runner}"
RUNNER_STATE="$DEMO_DATA_DIR/runner.json"
export DEMO_DATA_DIR

# The live demo stack (docker-compose.demo.yml in $LIVE_DIR).
LIVE_PROJECT="${DEMO_LIVE_PROJECT:-credaflow-demo}"
LIVE_COMPOSE_FILE=docker-compose.demo.yml
LIVE_APP="$LIVE_PROJECT-app"
LIVE_PORTAL="$LIVE_PROJECT-portal"
LIVE_DB="$LIVE_PROJECT-db"

# The simulator stack (docker-compose.demo-sim.yml in this worktree).
SIM_PROJECT=credaflow-demo-sim
SIM_APP="$SIM_PROJECT-app"
SIM_DB="$SIM_PROJECT-db"
SIM_SMTP="$SIM_PROJECT-smtp"
SIM_NETWORK="${SIM_PROJECT}_default"
SIM_IMAGE=credaflow:demo-sim
# Where SIM_HOST_DATABASE_URL must point (the sim db's published port).
SIM_DB_HOST_PORT=127.0.0.1:5456
# The comment fresh-stack.sh puts on the sim database, which
# sim/provision-operator.ts requires before it writes (SIM_DATABASE_MARKER in
# sim/operator.ts).
SIM_DB_MARKER=credaflow-demo-sim

# The row counts a snapshot records (bake.sh) and a restore verifies (restore.sh).
SNAPSHOT_COUNTS_SQL="$(cat <<'SQL'
SELECT json_build_object(
  'loans', (SELECT count(*) FROM "Loan"),
  'applications', (SELECT count(*) FROM "LoanApplication"),
  'clients', (SELECT count(*) FROM "Client"),
  'users', (SELECT count(*) FROM "User"),
  'payments', (SELECT count(*) FROM "Payment"),
  'clientDocuments', (SELECT count(*) FROM "ClientDocument"),
  'insurancePolicies', (SELECT count(*) FROM "InsurancePolicy"))
SQL
)"

# Turns TOTP off for every staff user but SUPER_ADMIN and prints how many rows
# changed. restore.sh runs it on the staged demo db when the live app runs with
# DEMO_CLEAR_STAFF_TOTP=true (the CLAUDE.md TOTP exception for demo stacks).
# Tested by staff-totp-off.integration.test.ts.
STAFF_TOTP_OFF_SQL="$(cat <<'SQL'
WITH c AS (
  UPDATE "User" SET "totpEnabled" = false, "totpSecret" = NULL, "lastTotpCounter" = NULL
  WHERE role <> 'SUPER_ADMIN'
  RETURNING 1)
SELECT count(*) FROM c
SQL
)"

die() { echo "${0##*/}: $*" >&2; exit 1; }
note() { echo "[${0##*/} $(date -u +%H:%M:%S)] $*" >&2; }

# env_get FILE KEY — one value from a dotenv file (empty when absent).
env_get() {
  node -e 'const v = require("node:util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; process.stdout.write(v ?? "")' "$1" "$2"
}

# env_set FILE KEY VALUE — replace or append KEY=VALUE without echoing it.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  grep -v "^$key=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp"
  mv "$tmp" "$file"
}

# The image the live staff container runs (the snapshot must match it).
live_image() {
  docker inspect -f '{{.Config.Image}}' "$LIVE_APP" 2>/dev/null || die "$LIVE_APP not found"
}

# sim_compose ARGS… — docker-compose on the sim project, pinned by -p so a
# COMPOSE_PROJECT_NAME in the environment cannot redirect it (`down -v`!).
sim_compose() {
  docker-compose -p "$SIM_PROJECT" -f "$DEMO_ROOT/docker-compose.demo-sim.yml" --env-file "$DEMO_ROOT/.env.demo-sim" "$@"
}

# sim_sql SQL — one query in the sim db, run inside its container with the
# container's own POSTGRES_* env (no credential in this host's argv).
sim_sql() {
  docker exec -e SQL="$1" "$SIM_DB" \
    sh -c 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$SQL"'
}

# live_sql DB SQL — SQL in database DB of the live db container, with the
# container's own POSTGRES_* env (several statements in one SQL string run as
# one transaction).
live_sql() {
  docker exec -e DB="$1" -e SQL="$2" "$LIVE_DB" \
    sh -c 'psql -v ON_ERROR_STOP=1 -q -At -U "$POSTGRES_USER" -d "$DB" -c "$SQL"'
}

# host_addr IP PORT — a published port as an address to reach it at: a
# wildcard or empty bind address through loopback, an IPv6 address bracketed.
host_addr() {
  local ip="$1"
  case "$ip" in "" | 0.0.0.0 | "::" | "[::]") ip=127.0.0.1 ;; esac
  case "$ip" in \[*) ;; *:*) ip="[$ip]" ;; esac
  echo "$ip:$2"
}

# record_result NAME LINE — the one-line outcome of the last bake/restore,
# read by status.sh ($LOG_DIR/last-<NAME>).
record_result() {
  mkdir -p "$LOG_DIR"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$LOG_DIR/last-$1"
}

# worktree_tag — <short sha>, or <short sha>-dirty-<hash8> when the tree has
# uncommitted changes. hash8 covers `git diff HEAD` plus every untracked,
# non-ignored file (path + content), so the same tree always gets the same tag.
worktree_tag() {
  local sha dirty
  sha="$(git -C "$DEMO_ROOT" rev-parse --short HEAD)"
  dirty="$(cd "$DEMO_ROOT" && {
    git diff HEAD --binary
    git ls-files --others --exclude-standard -z | sort -z | xargs -0 -r sha256sum
  } | sha256sum | cut -c1-8)"
  if [ -z "$(git -C "$DEMO_ROOT" status --porcelain)" ]; then
    echo "$sha"
  else
    echo "$sha-dirty-$dirty"
  fi
}

# ensure_shared_secrets — create secrets.env (0600) and add any missing random
# key. Never rotates an existing value: rotating WABA_ENC_KEY would orphan the
# SMTP password sealed inside every existing snapshot.
#
# Persisted and verified, so bake and live MUST agree:
#   WABA_ENC_KEY  seals the SMTP password the bake stores (Settings → Email);
#   DEBIT_MANDATE_CREDITOR_BANK_NAME/_ACCOUNT_NUMBER/_BRANCH_CODE  printed in
#     every stored mandate and re-rendered by lib/documents/catalogue.ts.
# Needed by both, shared so there is one value (nothing persisted outlives it):
#   NEXTAUTH_SECRET  FAIS disclosure tokens (1 h TTL; only their hash is stored)
#   CRON_SECRET, INTERNAL_API_SECRET, ADMIN_SECRET
#   TURNSTILE_SECRET_KEY  Cloudflare's documented always-pass TEST secret.
# Not here: AUTH_SECRET. Sessions are JWT cookies (lib/auth-config.ts) and no
# stored row is derived from it, so live keeps per-container STAFF_/PORTAL_
# secrets and the sim its own; every restore simply logs everyone out.
# The DEBIT_MANDATE_* bank details are fictional config, not generated.
ensure_shared_secrets() {
  local key
  (umask 077; mkdir -p "$DEMO_DATA_DIR"; [ -e "$SHARED_SECRETS" ] || : > "$SHARED_SECRETS")
  chmod 600 "$SHARED_SECRETS"
  if [ -z "$(env_get "$SHARED_SECRETS" WABA_ENC_KEY)" ]; then
    env_set "$SHARED_SECRETS" WABA_ENC_KEY "$(openssl rand -base64 32)"
  fi
  for key in NEXTAUTH_SECRET CRON_SECRET INTERNAL_API_SECRET ADMIN_SECRET; do
    [ -n "$(env_get "$SHARED_SECRETS" "$key")" ] || env_set "$SHARED_SECRETS" "$key" "$(openssl rand -hex 32)"
  done
  [ -n "$(env_get "$SHARED_SECRETS" TURNSTILE_SECRET_KEY)" ] \
    || env_set "$SHARED_SECRETS" TURNSTILE_SECRET_KEY 1x0000000000000000000000000000000AA
  for key in DEBIT_MANDATE_CREDITOR_BANK_NAME DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER DEBIT_MANDATE_CREDITOR_BRANCH_CODE; do
    [ -n "$(env_get "$SHARED_SECRETS" "$key")" ] || die "$key missing from $SHARED_SECRETS (fictional demo collection account; add it by hand)"
  done
}
