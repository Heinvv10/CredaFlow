#!/usr/bin/env bash
# Stand up ONE lender: its own compose project (app + Postgres, named volumes),
# generated secrets, migrated database, tenant, first SUPER_ADMIN, running app.
# Idempotent: every step checks before it acts; a rerun never rotates a secret,
# never recreates the tenant and never mints a second admin.
#
#   provision-lender.sh <lender-dir> --config <lender.json> --port <host-port> \
#       --public-url <https://…> [--admin-email <email>] [--image name:tag] [--build] [--bind <addr>]
#
#   --config      tenant config (see scripts/lender/tenant-config.ts; docs/ONBOARDING.md)
#   --port        host port the app is published on (loopback unless --bind)
#   --public-url  the origin users reach (NEXTAUTH_URL / AUTH_URL)
#   --admin-email the first SUPER_ADMIN; required until one exists
#   --image       name:tag to run (default credaflow-<slug>:<git sha>)
#   --build       build the images from this (clean) checkout first
#
# The first admin's one-time password and TOTP secret are printed to this
# terminal once, by the container, and are never written to a file or a log.
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

USAGE="usage: provision-lender.sh <lender-dir> --config <lender.json> --port <N> --public-url <url> [--admin-email <email>] [--image name:tag] [--build] [--bind <addr>]"
target="${1:-}"; shift || true
config="" port="" public_url="" admin_email="" image="" build=false bind=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config="${2:?$USAGE}"; shift 2 ;;
    --port) port="${2:?$USAGE}"; shift 2 ;;
    --public-url) public_url="${2:?$USAGE}"; shift 2 ;;
    --admin-email) admin_email="${2:?$USAGE}"; shift 2 ;;
    --image) image="${2:?$USAGE}"; shift 2 ;;
    --bind) bind="${2:?$USAGE}"; shift 2 ;;
    --build) build=true; shift ;;
    *) die "$USAGE" ;;
  esac
done
[ -n "$target" ] && [ -f "$config" ] && [[ "$port" =~ ^[0-9]+$ ]] && [ -n "$public_url" ] || die "$USAGE"
need docker jq openssl gpg curl
SLUG="$(jq -er .slug "$config")" || die "$config is not JSON with a slug"
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || die "slug '$SLUG' in $config is malformed"
[ -n "$image" ] || image="credaflow-$SLUG:$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"

case "$(readlink -m "$target")/" in "$REPO_ROOT"/*) die "lender dir $target is inside the git checkout $REPO_ROOT: secrets must live outside it" ;; esac

# 1. Directory, config, compose file (the compose file is not hand-edited: rerun to refresh it).
(umask 077; mkdir -p "$target" "$target/secrets" "$target/backups" "$target/state")
chmod 700 "$target"
cp "$config" "$target/lender.json"
cp "$LENDER_SCRIPTS/docker-compose.lender.yml" "$target/docker-compose.yml"

# 2. .env: created once, then only missing keys are added (nothing is rotated).
env="$target/.env"
[ -e "$env" ] || (umask 077; : > "$env")
chmod 600 "$env"
add() { [ -n "$(env_get "$env" "$1")" ] || { env_set "$env" "$1" "$2"; note "generated/set $1"; }; }
add NEXT_PUBLIC_TENANT_SLUG "$SLUG"
add APP_PORT "$port"
[ -z "$bind" ] || add APP_BIND "$bind"
add NEXTAUTH_URL "$public_url"
add AUTH_URL "$public_url"
add POSTGRES_USER credaflow
add POSTGRES_DB credaflow
add POSTGRES_PASSWORD "$(openssl rand -hex 24)"
for key in NEXTAUTH_SECRET CRON_SECRET INTERNAL_API_SECRET ADMIN_SECRET UNSUB_TOKEN_SECRET WEBSITE_CHAT_SECRET WHATSAPP_CLOUD_VERIFY_TOKEN; do
  add "$key" "$(openssl rand -hex 32)"
done
add WABA_ENC_KEY "$(openssl rand -base64 32)"   # 32 bytes, base64: lib/crypto/secret-box.ts
add BACKUP_KEEP 14
if ! grep -q '^# --- Provider credentials' "$env"; then
  cat >> "$env" <<'ENVTODO'
# --- Provider credentials: TODO before go-live (docs/DEPLOY.md lists every variable) ---
# STITCH_CLIENT_ID= STITCH_CLIENT_SECRET= STITCH_WEBHOOK_SECRET= (+ STITCH_BANK_ID, STITCH_ACCOUNT_NUMBER, STITCH_BRANCH_CODE, STITCH_BENEFICIARY_NAME)
# SMILE_IDENTITY_PARTNER_ID= SMILE_IDENTITY_API_KEY= SMILE_IDENTITY_ENV=
# SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= SMTP_FROM_EMAIL= SMTP_FROM_NAME=
# WHATSAPP_CLOUD_APP_SECRET= NEXT_PUBLIC_META_APP_ID=
# DEBIT_MANDATE_CREDITOR_BANK_NAME= DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER= DEBIT_MANDATE_CREDITOR_BRANCH_CODE=
ENVTODO
fi
pass="$target/secrets/backup.passphrase"
if [ ! -s "$pass" ]; then
  (umask 077; openssl rand -base64 33 > "$pass")
  note "created $pass: COPY IT OFF THIS HOST now; without it no backup can be restored"
fi

load_lender "$target"
[ "$(env_get "$ENV_FILE" NEXT_PUBLIC_TENANT_SLUG)" = "$SLUG" ] || die "$ENV_FILE belongs to another lender"

# 3. Images, database, migrations.
ensure_images "$image" "$build"
tools="$(tools_image_of "$image")"
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
note "lender '$SLUG' is up at $(env_get "$ENV_FILE" NEXTAUTH_URL) (host port $APP_PORT); project $PROJECT; dir $LENDER_DIR"
