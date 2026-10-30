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
#   DEMO_LENDER    the lender a bake is branded as (prisma/demo-lender.ts); default acme
#   DEMO_SIM_LOCK  the sim stack lock bake.sh holds; default ~/.credaflow-demo-sim.lock (per user:
#                  every demo job on this host runs as one user, so it covers the host).
#                  One file for every DEMO_DATA_DIR: the sim stack is one per host.
#                  DEMO_SIM_LOCK_WAIT whole seconds to wait for it (default 0; cron-run.sh: 3 h).
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
# Optional SEED_*_PASSWORD=… lines (chmod 600): the seed sets these passwords on
# every bake, so presenters' logins survive a rebake. Absent, they are random.
SEED_PASSWORDS="$DEMO_DATA_DIR/seed-passwords.env"
SNAP_DIR="$DEMO_DATA_DIR/snapshots"
LOG_DIR="$DEMO_DATA_DIR/logs"
BAKE_LOCK="$DEMO_DATA_DIR/bake.lock"
RESTORE_LOCK="$DEMO_DATA_DIR/restore.lock"
CRON_RUN_LOCK="$DEMO_DATA_DIR/cron-run.lock"
SIM_LOCK="${DEMO_SIM_LOCK:-$HOME/.credaflow-demo-sim.lock}"
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

# The lender's staff-2FA policy (TenantConfig.requireStaffTotp, default on)
# switched off for every tenant of the demo db. Wherever restore.sh clears
# staff TOTP it also runs this: with the policy on, staff without TOTP would be
# held at the enrolment page and the demo could not be presented.
# Tested by staff-totp-off.integration.test.ts.
TENANT_TOTP_POLICY_OFF_SQL='UPDATE "TenantConfig" SET "requireStaffTotp" = false'

# Segregation of duties (TenantConfig.requireSegregationOfDuties) switched off
# for every tenant of the demo db, alongside the 2FA policy: a presenter
# approves and pays out as one admin (scripts/demo/kits/stories.ts), and the
# column defaults ON, also for rows that existed before it did, which no
# restore or in-place upgrade re-seeds. A snapshot from before the column
# exists is left alone. Tested by staff-totp-off.integration.test.ts.
TENANT_SOD_OFF_SQL='DO $sod$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '"'TenantConfig'"' AND column_name = '"'requireSegregationOfDuties'"') THEN UPDATE "TenantConfig" SET "requireSegregationOfDuties" = false; END IF; END $sod$'

# Marks the seeded demo lenders' tenants of the demo db (the slugs in
# prisma/demo-lender.ts, kept in step by lib-sh.test.ts) as synthetic demo
# lenders (TenantConfig.isDemoLender), the marker that lets a DEMO_MODE stack
# simulate a Section 129 email to an undeliverable mailbox
# (lib/collections/section129-email.ts). Any other tenant stays unmarked. The
# seed sets it, but the column arrives false on rows that existed before it,
# which no restore or in-place upgrade re-seeds. A snapshot from before the
# column exists is left alone. Tested by staff-totp-off.integration.test.ts.
# Re-establishes the audit protections a --no-owner --no-acl restore loses (audit_reassert_protections, migration 20261029100000).
AUDIT_REASSERT_SQL="DO \$\$ BEGIN IF to_regprocedure('public.audit_reassert_protections()') IS NOT NULL THEN PERFORM public.audit_reassert_protections(); END IF; END \$\$"
TENANT_DEMO_LENDER_SQL='DO $demo$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '"'TenantConfig'"' AND column_name = '"'isDemoLender'"') THEN UPDATE "TenantConfig" SET "isDemoLender" = true WHERE "tenantId" IN (SELECT id FROM "Tenant" WHERE slug IN ('"'acme', 'fairscore', 'tsela', 'basotho'"')); END IF; END $demo$'

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

# ensure_demo_audit_env ENV_FILE BACKUP_DIR — a demo stack's app env gets what the tamper-evident audit needs
# (docs/DEPLOY.md): AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 (the demo stacks run as the database owner; a production process
# refuses that unless told, on purpose, and DEMO_MODE does not stand in for it) and an AUDIT_CHAIN_KEY (without it the
# audit crons answer 503 and tamper-evidence cannot be shown). ONLY when the file says DEMO_MODE=true: any other file is
# left alone. An existing key is NEVER replaced (rotating it makes the history unverifiable); one that is too short is
# reported and left. Idempotent: with nothing to add it writes and backs up nothing. When it changes the file, the
# file as it was is copied to BACKUP_DIR/<name>.pre-audit-<UTC> (0600) first, and each key added is named in the log
# (never a value).
ensure_demo_audit_env() {
  local file="$1" backups="$2" added="" key ts
  [ -f "$file" ] || die "ensure_demo_audit_env: $file not found"
  if [ "$(env_get "$file" DEMO_MODE)" != true ]; then
    note "audit env: $file does not say DEMO_MODE=true; left alone"
    return 0
  fi
  key="$(env_get "$file" AUDIT_CHAIN_KEY)"
  if [ -n "$key" ] && [ "${#key}" -lt 32 ]; then
    note "WARNING: AUDIT_CHAIN_KEY in $file is shorter than 32 characters; the audit chain cannot use it. It is not replaced (replacing it would orphan history): fix it by hand."
  fi
  [ "$(env_get "$file" AUDIT_ALLOW_PRIVILEGED_DB_ROLE)" = 1 ] || added+=" AUDIT_ALLOW_PRIVILEGED_DB_ROLE"
  [ -n "$key" ] || added+=" AUDIT_CHAIN_KEY"
  if [ -z "$added" ]; then
    note "audit env: $file already has AUDIT_ALLOW_PRIVILEGED_DB_ROLE and AUDIT_CHAIN_KEY"
    return 0
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  (umask 077; mkdir -p "$backups"; cp "$file" "$backups/${file##*/}.pre-audit-$ts")
  case "$added" in *AUDIT_ALLOW_PRIVILEGED_DB_ROLE*) env_set "$file" AUDIT_ALLOW_PRIVILEGED_DB_ROLE 1 ;; esac
  case "$added" in *AUDIT_CHAIN_KEY*) env_set "$file" AUDIT_CHAIN_KEY "$(openssl rand -base64 48 | tr -d '\n')" ;; esac
  note "audit env: added${added} to $file (the file as it was: $backups/${file##*/}.pre-audit-$ts)"
}

# demo_slug — DEMO_LENDER's tenant slug.
demo_slug() {
  (cd "$DEMO_ROOT" && npx tsx prisma/demo-lender.ts slug) || die "DEMO_LENDER=${DEMO_LENDER:-} is not a known demo lender"
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

# seed_passwords_ok FILE — true when FILE holds only SEED_*_PASSWORD=… lines
# (blank lines allowed; no comments, no `export`), so it can never override
# DATABASE_URL, LD_PRELOAD or the sim clock in the seed container.
seed_passwords_ok() {
  ! grep -vqE '^(SEED_[A-Z_]+_PASSWORD=.+)?$' "$1"
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

# sim_env_preflight — die within seconds, naming each missing key, when the sim
# stack cannot finish a bake: secrets.env without UNSUB_TOKEN_SECRET, or a sim
# app container started without DEMO_MODE=true, AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 or UNSUB_TOKEN_SECRET (the signing
# OTP then 502s for every persona, which simulate.ts found 70 minutes in).
# Prints key names only; the container env is held in a variable and only tested.
# The container's UNSUB_TOKEN_SECRET is checked non-empty, not equal to
# secrets.env's: the compose env_file makes them the same file.
sim_env_preflight() {
  local missing="" env
  [ -n "$(env_get "$SHARED_SECRETS" UNSUB_TOKEN_SECRET)" ] || missing+=" secrets.env: UNSUB_TOKEN_SECRET;"
  env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SIM_APP" 2>/dev/null)" \
    || die "$SIM_APP not found; the sim stack is not up"
  grep -x 'DEMO_MODE=true' <<< "$env" >/dev/null || missing+=" $SIM_APP: DEMO_MODE=true;"
  # The demo stacks run as the database owner/superuser; a production process refuses that unless told, on purpose,
  # that this stack accepts it (lib/audit/deployment-check.ts). DEMO_MODE does not stand in for it.
  grep -x 'AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1' <<< "$env" >/dev/null || missing+=" $SIM_APP: AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1;"
  grep -E '^UNSUB_TOKEN_SECRET=.' <<< "$env" >/dev/null || missing+=" $SIM_APP: UNSUB_TOKEN_SECRET;"
  [ -z "$missing" ] || die "sim env incomplete, missing:$missing nothing was simulated (fix secrets.env / docker-compose.demo-sim.yml and re-run)"
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
#   UNSUB_TOKEN_SECRET  signs List-Unsubscribe links; sendMessage refuses a
#     redacted-body email without it (the signing-OTP email), in every
#     environment, not only a production build (assertRedactedSendIsRecoverable,
#     lib/messaging/send.ts, called unconditionally from sendMessage).
#     upgrade-stack adds it to a live app that predates it (ADDABLE_SECRETS,
#     upgrade-stack.lib.sh); sim_env_preflight checks it before a bake simulates.
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
  for key in NEXTAUTH_SECRET CRON_SECRET INTERNAL_API_SECRET ADMIN_SECRET UNSUB_TOKEN_SECRET; do
    [ -n "$(env_get "$SHARED_SECRETS" "$key")" ] || env_set "$SHARED_SECRETS" "$key" "$(openssl rand -hex 32)"
  done
  [ -n "$(env_get "$SHARED_SECRETS" TURNSTILE_SECRET_KEY)" ] \
    || env_set "$SHARED_SECRETS" TURNSTILE_SECRET_KEY 1x0000000000000000000000000000000AA
  for key in DEBIT_MANDATE_CREDITOR_BANK_NAME DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER DEBIT_MANDATE_CREDITOR_BRANCH_CODE; do
    [ -n "$(env_get "$SHARED_SECRETS" "$key")" ] || die "$key missing from $SHARED_SECRETS (fictional demo collection account; add it by hand)"
  done
}
