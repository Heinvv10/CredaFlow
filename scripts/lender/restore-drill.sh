#!/usr/bin/env bash
# Restore drill: prove a backup brings a lender back, and time it. Restores the
# database dump AND the uploads archive into a THROWAWAY compose project (its
# own Postgres, its own volumes, the deployed app image on a random loopback
# port), then checks:
#   - pg_restore --exit-on-error succeeds;
#   - the restored row counts equal the backup's .counts sidecar;
#   - the restored file count equals the backup's .files sidecar;
#   - every encrypted upload opens with this lender's UPLOADS_ENC_KEY (tools image);
#   - the app answers /api/health with status ok (database + storage) on the restore.
# Prints the time of each step and the total, then removes the project and its
# volumes (down -v), whatever happened. The live stack is never touched.
#
#   restore-drill.sh <lender-dir> [<backup.dump.gpg>] [--keep-stack]
#
# Default backup: the newest one not marked -unresolved. The drill app gets a
# minimal environment: no CRON_SECRET (so no scheduler: a restored copy must
# never send a borrower a message), no provider credentials, fresh session
# secrets. Exit 0 only when every check passed.
#
# Weekly cron (not installed by these scripts):
#   45 2 * * 0 /path/to/CredaFlow/scripts/lender/restore-drill.sh /srv/lenders/acme >> /srv/lenders/acme/backups/cron.log 2>&1
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}"; shift || true
file="" keep=false
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-stack) keep=true; shift ;;
    -*) die "usage: restore-drill.sh <lender-dir> [<backup.dump.gpg>] [--keep-stack]" ;;
    *) file="$1"; shift ;;
  esac
done
need docker gpg curl jq tar openssl
load_lender "$dir"
acquire_lender_lock "$LENDER_DIR"
pass="$LENDER_DIR/secrets/backup.passphrase"
[ -s "$pass" ] || die "$pass missing or empty"
if [ -z "$file" ]; then
  file="$(find "$LENDER_DIR/backups" -maxdepth 1 -type f -name "$SLUG-*.dump.gpg" ! -name '*-unresolved*' -printf '%f\n' | sort -r | head -n1)"
  [ -n "$file" ] || die "no backup in $LENDER_DIR/backups to drill"
  file="$LENDER_DIR/backups/$file"
fi
[ -f "$file" ] || die "backup $file not found"
[ -f "$file.counts" ] || die "$(basename "$file") has no .counts sidecar: nothing to verify the restore against"
image="$(cat "$STATE_DIR/current-image" 2>/dev/null)" || die "nothing deployed yet ($STATE_DIR/current-image missing): the drill runs the deployed image"
tools="$(cat "$STATE_DIR/current-tools-id" 2>/dev/null || tools_image_of "$image")"

ms() { date +%s%3N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", (b - a) / 1000 }'; }
t_start="$(ms)"
ts="$(date -u +%Y%m%d%H%M%S)"
DRILL="credaflow-drill-$SLUG-$ts"
work="$STATE_DIR/drill-$ts"
(umask 077; mkdir -p "$work")
failures=()

# The drill project's own compose file and env file (0600, in the lender's 0700 dir).
{
  printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$PGUSER" "$(openssl rand -hex 16)" "$PGDB"
  printf 'AUTH_SECRET=%s\nNEXTAUTH_SECRET=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
  printf 'UPLOADS_ENC_KEY=%s\nNEXT_PUBLIC_TENANT_SLUG=%s\n' "$(env_get "$ENV_FILE" UPLOADS_ENC_KEY)" "$SLUG"
} > "$work/drill.env"
cat > "$work/docker-compose.yml" <<YAML
services:
  db:
    image: $UPLOADS_HELPER_IMAGE
    env_file: [drill.env]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \$\$POSTGRES_USER -d \$\$POSTGRES_DB"]
      interval: 2s
      timeout: 5s
      retries: 60
    volumes: [pgdata:/var/lib/postgresql/data]
  app:
    image: "$image"
    pull_policy: never
    depends_on: { db: { condition: service_healthy } }
    env_file: [drill.env]
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@db:5432/\${POSTGRES_DB}?schema=public
      NODE_ENV: production
      # The drill's database login is its throwaway Postgres superuser, which a production process would otherwise
      # refuse to run as (lib/audit/deployment-check.ts). Explicit, logged at every boot, and this stack is deleted
      # when the drill ends; a real lender never sets it.
      AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "1"
      PORT: "3300"
      HOSTNAME: 0.0.0.0
      APP_MODE: staff
      NEXTAUTH_URL: http://127.0.0.1
      # A real backup restores whatsappEnabled=true and sealed WABA credentials;
      # unset WA_ENABLED would defer to that, so pin WhatsApp off here
      # (lib/whatsapp/env-switch.ts).
      WA_ENABLED: "false"
    ports: ["127.0.0.1::3300"]
    volumes: [uploads:/app/uploads]
volumes:
  pgdata:
  uploads:
YAML
# Compose on the drill project only, with a scrubbed environment (as lcompose), v2 plugin or standalone.
dcompose() {
  local pre=(env -i) v
  for v in PATH HOME USER LANG TMPDIR DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY XDG_RUNTIME_DIR; do
    [ -z "${!v:-}" ] || pre+=("$v=${!v}")
  done
  local cmd=(docker compose); docker compose version >/dev/null 2>&1 || cmd=(docker-compose)
  "${pre[@]}" "${cmd[@]}" -p "$DRILL" -f "$work/docker-compose.yml" --project-directory "$work" --env-file "$work/drill.env" "$@"
}
teardown() {
  if $keep; then note "--keep-stack: project $DRILL left running (remove: docker compose -p $DRILL -f $work/docker-compose.yml down -v)"; return; fi
  dcompose down -v --remove-orphans >/dev/null 2>&1 || note "WARNING: teardown of $DRILL failed; remove it by hand (docker compose -p $DRILL down -v)"
  rm -rf "$work"
}
trap teardown EXIT

note "drill: $(basename "$file") into throwaway project $DRILL"
dcompose up -d --wait db >/dev/null
t_db_up="$(ms)"

gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$file" \
  | dcompose exec -T db pg_restore --no-owner --no-acl --exit-on-error -U "$PGUSER" -d "$PGDB" || die "pg_restore failed"
dcompose exec -T db psql -v ON_ERROR_STOP=1 -qAt -U "$PGUSER" -d "$PGDB" -c "$AUDIT_REASSERT_SQL" >/dev/null || failures+=("the audit protections could not be re-asserted after the restore")
t_restored="$(ms)"
restored="$(dcompose exec -T db psql -v ON_ERROR_STOP=1 -qAt -U "$PGUSER" -d "$PGDB" -c "$COUNTS_SQL")"
if drift="$(count_drift "$file.counts" "$restored")"; then note "row counts match the backup: $(tr '\n' ' ' <<<"$restored")"
else failures+=("row counts differ: $(tr '\n' ';' <<<"$drift")"); fi

want="$(sed -n 's/^files=//p' "$file.files" 2>/dev/null | head -n1)"
if [ -z "$want" ]; then failures+=("no .files sidecar: this backup has no uploads")
elif [ "$want" = none ]; then note "the backup records no uploads volume (files=none)"
else
  [ -f "$file.uploads.tar.gpg" ] || die "uploads archive missing"
  # Mounting the fresh volume in the app image first gives it the image's
  # /app/uploads owner (the app user), as on a real stack; then unpack as root.
  dcompose run --rm --no-deps -T --entrypoint true app >/dev/null
  gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$file.uploads.tar.gpg" \
    | docker run --rm -i -v "${DRILL}_uploads:/u" "$UPLOADS_HELPER_IMAGE" tar -xf - -C /u || die "uploads did not unpack"
  got="$(docker run --rm -v "${DRILL}_uploads:/u:ro" "$UPLOADS_HELPER_IMAGE" sh -c 'find /u -type f | wc -l' | tr -d ' ')"
  if [ "$got" = "$want" ]; then note "file count matches the backup: $got"; else failures+=("files: backup=$want restored=$got"); fi
  if [ -n "$(env_get "$ENV_FILE" UPLOADS_ENC_KEY)" ]; then
    docker run --rm --env-file "$work/drill.env" -v "${DRILL}_uploads:/app/uploads:ro" "$tools" \
      npx tsx scripts/encrypt-uploads-cli.ts --dir /app/uploads --verify >&2 || failures+=("encrypted uploads do not all open with UPLOADS_ENC_KEY")
  fi
fi
t_files="$(ms)"

dcompose up -d app >/dev/null
port="$(dcompose port app 3300 | sed 's/.*://')"
[[ "$port" =~ ^[0-9]+$ ]] || die "could not find the drill app's port"
if wait_health "http://127.0.0.1:$port/api/health" "" 180; then note "app healthy on the restore (port $port)"
else failures+=("app did not report status ok within 180s: $(curl -s --max-time 5 "http://127.0.0.1:$port/api/health" || echo no answer)"); fi
t_app="$(ms)"

echo "restore drill $(basename "$file"): db up $(secs "$t_start" "$t_db_up")s, database restore $(secs "$t_db_up" "$t_restored")s, uploads $(secs "$t_restored" "$t_files")s, app healthy $(secs "$t_files" "$t_app")s, total $(secs "$t_start" "$t_app")s"
if [ "${#failures[@]}" -gt 0 ]; then
  printf 'DRILL FAILED: %s\n' "${failures[@]}" >&2
  exit 1
fi
echo "DRILL PASSED"
