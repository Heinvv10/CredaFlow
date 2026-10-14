#!/usr/bin/env bash
# Stand up ONE lender: its own compose project (app + Postgres, named volumes),
# generated secrets, migrated database, tenant, first SUPER_ADMIN, running app.
# Idempotent: every step checks before it acts; a rerun never rotates a secret,
# never recreates the tenant and never mints a second admin.
#
#   provision-lender.sh <lender-dir> --config <lender.json> --port <host-port> --public-url <https://…> \
#       --portal-port <host-port> --portal-url <https://…> \
#       [--admin-email <email>] [--image name:tag] [--build] [--bind <addr>]
#
#   --config      tenant config (see scripts/lender/tenant-config.ts; docs/ONBOARDING.md)
#   --port        host port the app is published on (loopback unless --bind)
#   --public-url  the staff origin (NEXTAUTH_URL / AUTH_URL)
#   --portal-port, --portal-url  the client portal's own host port and origin: a
#                 second container with its own session secret (STAFF_AUTH_SECRET
#                 and PORTAL_AUTH_SECRET are generated distinct, in secrets/auth.env)
#   --admin-email the first SUPER_ADMIN; required until one exists
#   --image       name:tag to run (default credaflow-lender-<slug>:<git sha>)
#   --build       build the images from this (clean) checkout first
#
# The first admin's one-time password and TOTP secret are printed to this
# terminal once, by the container, and are never written to a file or a log.
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

USAGE="usage: provision-lender.sh <lender-dir> --config <lender.json> --port <N> --public-url <url> --portal-port <N> --portal-url <url> [--admin-email <email>] [--image name:tag] [--build] [--bind <addr>] [--update-settings]"
target="${1:-}"; shift || true
config="" port="" portal_port="" portal_url="" public_url="" admin_email="" image="" build=false bind="" update_settings=false
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config="${2:?$USAGE}"; shift 2 ;;
    --port) port="${2:?$USAGE}"; shift 2 ;;
    --public-url) public_url="${2:?$USAGE}"; shift 2 ;;
    --portal-port) portal_port="${2:?$USAGE}"; shift 2 ;;
    --portal-url) portal_url="${2:?$USAGE}"; shift 2 ;;
    --admin-email) admin_email="${2:?$USAGE}"; shift 2 ;;
    --image) image="${2:?$USAGE}"; shift 2 ;;
    --bind) bind="${2:?$USAGE}"; shift 2 ;;
    --build) build=true; shift ;;
    --update-settings) update_settings=true; shift ;;
    *) die "$USAGE" ;;
  esac
done
[ -n "$target" ] && [ -f "$config" ] && [[ "$port" =~ ^[0-9]+$ ]] && [ -n "$public_url" ] \
  && [[ "$portal_port" =~ ^[0-9]+$ ]] && [ -n "$portal_url" ] || die "$USAGE"
[ "$port" != "$portal_port" ] || die "--port and --portal-port must differ"
# Values are written into .env and compose: only these shapes (and no newline, quote or space) get that far.
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_origin() { [[ "$1" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]]; }
valid_ipv4() {
  local o IFS=.; [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}
valid_port "$port" && valid_port "$portal_port" || die "--port and --portal-port must be integers 1-65535"
valid_origin "$public_url" || die "--public-url must be http(s)://host[:port] (no path, query or spaces): '$public_url'"
valid_origin "$portal_url" || die "--portal-url must be http(s)://host[:port] (no path, query or spaces): '$portal_url'"
public_url="${public_url%/}" portal_url="${portal_url%/}"
[ -z "$bind" ] || valid_ipv4 "$bind" || die "--bind must be an IPv4 address: '$bind'"
[ -z "$admin_email" ] || [[ "$admin_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "--admin-email is not an email address"
[ -z "$image" ] || [[ "$image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "--image has unexpected characters"
need docker jq openssl gpg curl
SLUG="$(jq -er .slug "$config")" || die "$config is not JSON with a slug"
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || die "slug '$SLUG' in $config is malformed"
[ -n "$image" ] || image="credaflow-lender-$SLUG:$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"

case "$(readlink -m "$target")/" in "$REPO_ROOT"/*) die "lender dir $target is inside the git checkout $REPO_ROOT: secrets must live outside it" ;; esac
# Refuse before any side effect when another stack already owns this compose project.
abs_target="$(readlink -m "$target")"   # physical path: symlinks resolved, whether or not it exists yet
PROJECT="$(project_of "$SLUG")"
acquire_project_lock "$PROJECT"        # held to the end: nobody can claim this project between the check and the `up`
check_project_free "$(project_of "$SLUG")" "$abs_target" "$([ -f "$abs_target/.env" ] && echo false || echo true)"

# 1. Directory, lock, config, compose file (the compose file is not hand-edited: rerun to refresh it).
(umask 077; mkdir -p "$target" "$target/secrets" "$target/backups" "$target/state")
chmod 700 "$target"
acquire_lender_lock "$abs_target"
cp "$config" "$target/lender.json"
cp "$LENDER_SCRIPTS/docker-compose.lender.yml" "$target/docker-compose.yml"

# 2. .env: created once, then only missing keys are added (nothing is rotated).
env="$target/.env"
[ -e "$env" ] || (umask 077; : > "$env")
chmod 600 "$env"
add() { [ -n "$(env_get "$env" "$1")" ] || { env_set "$env" "$1" "$2"; note "generated/set $1"; }; }
# setting KEY VALUE — a non-secret setting: set when absent; a rerun that asks for
# a different value says so and keeps the existing one unless --update-settings.
setting() {
  local cur; cur="$(env_get "$env" "$1")"
  if [ -z "$cur" ]; then env_set "$env" "$1" "$2"; note "set $1=$2"
  elif [ "$cur" = "$2" ]; then :
  elif $update_settings; then env_set "$env" "$1" "$2"; note "updated $1: $cur -> $2"
  else note "kept existing $1=$cur (requested $2; pass --update-settings to change it)"
  fi
}
add NEXT_PUBLIC_TENANT_SLUG "$SLUG"
setting APP_PORT "$port"
[ -z "$bind" ] || setting APP_BIND "$bind"
setting NEXTAUTH_URL "$public_url"
setting AUTH_URL "$public_url"
setting PORTAL_PORT "$portal_port"
setting PORTAL_NEXTAUTH_URL "$portal_url"
setting NEXT_PUBLIC_PORTAL_LOGIN_URL "${portal_url%/}/portal/login"   # baked at build: rebuild to change it
# The supported production topology binds both apps to loopback behind one
# TLS-terminating proxy. A non-loopback bind cannot prove that forwarding
# headers came through that proxy, so persisted evidence must fail closed even
# when an older .env trusted a proxy.
effective_bind="${bind:-$(env_get "$env" APP_BIND)}"
[ -n "$effective_bind" ] || effective_bind=127.0.0.1
if [[ "$effective_bind" == 127.* ]]; then
  setting TRUSTED_PROXY 1
else
  [ "$(env_get "$env" TRUSTED_PROXY)" = 0 ] || { env_set "$env" TRUSTED_PROXY 0; note "set TRUSTED_PROXY=0 for non-loopback bind"; }
fi
add POSTGRES_USER credaflow
add POSTGRES_DB credaflow
add POSTGRES_PASSWORD "$(openssl rand -hex 24)"
for key in NEXTAUTH_SECRET CRON_SECRET INTERNAL_API_SECRET ADMIN_SECRET UNSUB_TOKEN_SECRET WEBSITE_CHAT_SECRET WHATSAPP_CLOUD_VERIFY_TOKEN; do
  add "$key" "$(openssl rand -hex 32)"
done
add WABA_ENC_KEY "$(openssl rand -base64 32)"   # 32 bytes, base64: lib/crypto/secret-box.ts
# Uploads encrypted at rest (lib/storage-crypto.ts). Losing it loses every encrypted
# document, backups included: copy it off the host with secrets/backup.passphrase.
add UPLOADS_ENC_KEY "$(openssl rand -base64 32)"
add WEBHOOK_SECRET_KEY "$(openssl rand -base64 32)"   # seals webhook signing secrets (lib/lender-api/webhooks)
add BACKUP_KEEP 14
if ! grep -q '^# --- Provider credentials' "$env"; then
  cat >> "$env" <<'ENVTODO'
# --- Provider credentials: TODO before go-live (docs/DEPLOY-ENV.md lists every variable) ---
# STITCH_CLIENT_ID= STITCH_CLIENT_SECRET= STITCH_WEBHOOK_SECRET= (+ STITCH_BANK_ID, STITCH_ACCOUNT_NUMBER, STITCH_BRANCH_CODE, STITCH_BENEFICIARY_NAME)
# SMILE_IDENTITY_PARTNER_ID= SMILE_IDENTITY_API_KEY= SMILE_IDENTITY_ENV=
# SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= SMTP_FROM_EMAIL= SMTP_FROM_NAME=
# WHATSAPP_CLOUD_APP_SECRET= NEXT_PUBLIC_META_APP_ID=
# DEBIT_MANDATE_CREDITOR_BANK_NAME= DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER= DEBIT_MANDATE_CREDITOR_BRANCH_CODE=
ENVTODO
fi
# Per-host session secrets, in their own file so no container reads the other's
# (compose interpolates it; it is not an env_file). Never rotated by a rerun.
auth="$target/secrets/auth.env"
[ -e "$auth" ] || (umask 077; : > "$auth")
chmod 600 "$auth"
for key in STAFF_AUTH_SECRET PORTAL_AUTH_SECRET; do
  [ -n "$(env_get "$auth" "$key")" ] || { env_set "$auth" "$key" "$(openssl rand -hex 32)"; note "generated $key"; }
done
pass="$target/secrets/backup.passphrase"
if [ ! -s "$pass" ]; then
  (umask 077; openssl rand -base64 33 > "$pass")
  note "created $pass: COPY IT OFF THIS HOST now; without it no backup can be restored"
fi

load_lender "$target"
[ "$(env_get "$ENV_FILE" NEXT_PUBLIC_TENANT_SLUG)" = "$SLUG" ] || die "$ENV_FILE belongs to another lender"
[ "$APP_PORT" != "$PORTAL_PORT" ] || die "APP_PORT and PORTAL_PORT in $ENV_FILE must differ"
check_rendered_config

# 3. Images, database, migrations.
ensure_images "$image" "$build"
tools="$(tools_image_of "$image")"
check_image_lender "$image"
check_image_lender "$tools"
lcompose up -d db >/dev/null
wait_db
note "migrate deploy"
tools_run "$tools" -e NODE_ENV=production -- npx prisma migrate deploy

# 4. Tenant: validated and dry-run first, then created (a rerun reports "unchanged").
tenant_cli=(npx tsx scripts/lender/bootstrap-tenant-cli.ts --config /config/lender.json)
mount=(-v "$LENDER_DIR/lender.json:/config/lender.json:ro" -e NODE_ENV=production)
tools_run "$tools" "${mount[@]}" -- "${tenant_cli[@]}" --dry-run
tools_run "$tools" "${mount[@]}" -- "${tenant_cli[@]}"
# Debit mandates refuse to render unless this equals the tenant id (lib/config/debit-mandate.ts).
add DEBIT_MANDATE_CREDITOR_TENANT_ID "$(psql_db "$PGDB" "SELECT id FROM \"Tenant\" WHERE slug = '$SLUG'")"

# 5. First SUPER_ADMIN, once.
admins="$(psql_db "$PGDB" "SELECT count(*) FROM \"User\" u JOIN \"Tenant\" t ON t.id = u.\"tenantId\" WHERE t.slug = '$SLUG' AND u.role = 'SUPER_ADMIN'")"
if [ "$admins" -gt 0 ]; then
  note "tenant already has a SUPER_ADMIN: skipping (locked out? see docs/DEPLOY.md, break-glass)"
else
  [ -n "$admin_email" ] || die "no SUPER_ADMIN yet: pass --admin-email"
  echo "=== first SUPER_ADMIN credentials: shown once, copy them now ===" >&2
  tools_run "$tools" -e NODE_ENV=production -- npx tsx scripts/lender/bootstrap-admin-cli.ts --tenant "$SLUG" --email "$admin_email"
  echo "=== end of credentials ===" >&2
fi

# 6. Start the app: the normal deploy path (backup, migrate no-op, switch, health).
"$LENDER_SCRIPTS/deploy.sh" "$LENDER_DIR" "$image"
note "lender '$SLUG' is up at $(env_get "$ENV_FILE" NEXTAUTH_URL) (staff host port $APP_PORT, portal $(env_get "$ENV_FILE" PORTAL_NEXTAUTH_URL) host port $PORTAL_PORT); project $PROJECT; dir $LENDER_DIR"
