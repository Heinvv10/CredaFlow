# shellcheck shell=bash disable=SC2034  # sourced: the variables are used by its callers
# Shared wiring for the demo bake/restore scripts (sourced, not run).
#
#   DEMO_DATA_DIR  untracked demo state outside git; default ~/credaflow-demo-data
#                  secrets.env  the shared secrets (ensure_shared_secrets, 0600)
#                  snapshots/   bake output, one dir per UTC timestamp + `latest`
#                  logs/        cron logs (cron-run.sh)
#   LIVE_DIR       the live demo's compose project; default ~/Workspace/CredaFlow-demo
#
# Nothing here prints a secret value: env files are read key by key into shell
# variables (env_get) and handed to containers by name, never echoed.

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DATA_DIR="${DEMO_DATA_DIR:-$HOME/credaflow-demo-data}"
LIVE_DIR="${LIVE_DIR:-$HOME/Workspace/CredaFlow-demo}"
SHARED_SECRETS="$DEMO_DATA_DIR/secrets.env"
SNAP_DIR="$DEMO_DATA_DIR/snapshots"
LOG_DIR="$DEMO_DATA_DIR/logs"
LIVE_APP=credaflow-demo-app
LIVE_PORTAL=credaflow-demo-portal
LIVE_DB=credaflow-demo-db
export DEMO_DATA_DIR

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
