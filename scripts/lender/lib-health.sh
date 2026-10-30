# shellcheck shell=bash
# Health probes, the host port check, the rendered-config gate and the backup count
# helpers (sourced by lib.sh).

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

# check_rendered_config — validate what compose will ACTUALLY run, not what the
# files appear to say: `compose config --format json` applies the same parsing the
# daemon will (quoted values, duplicate keys, interpolation, env_file merging). It
# refuses, before anything changes, unless
#   - the staff and portal AUTH_SECRET are both set, 32+ characters, different from
#     each other and from NEXTAUTH_SECRET;
#   - neither container's environment carries STAFF_AUTH_SECRET or PORTAL_AUTH_SECRET
#     (a leak through `.env`, which both containers read);
#   - neither container's environment carries the OWNER database login (POSTGRES_USER,
#     POSTGRES_PASSWORD, MIGRATE_DATABASE_URL, OWNER_DATABASE_URL): the compose file blanks
#     them, so a non-empty value means that was edited away and the app could switch the audit
#     triggers off (docs/DEPLOY.md, "Two database logins");
#   - the database publishes no port.
# It also sets APP_PORT, PORTAL_PORT and PROBE_HOST from the rendered ports, so the
# port check and the health probes look where compose really publishes. Values are
# never printed.
check_rendered_config() {
  local cfg staff portal shared_s shared_p host
  cfg="$(lcompose config --format json)" || die "compose cannot render this lender's configuration (see the error above; a missing STAFF_AUTH_SECRET or PORTAL_AUTH_SECRET in $AUTH_ENV is refused here)"
  staff="$(jq -r '.services.app.environment.AUTH_SECRET // ""' <<<"$cfg")"
  portal="$(jq -r '.services["app-portal"].environment.AUTH_SECRET // ""' <<<"$cfg")"
  shared_s="$(jq -r '.services.app.environment.NEXTAUTH_SECRET // ""' <<<"$cfg")"
  shared_p="$(jq -r '.services["app-portal"].environment.NEXTAUTH_SECRET // ""' <<<"$cfg")"
  [ -n "$staff" ] && [ -n "$portal" ] || die "refusing: the staff or portal AUTH_SECRET renders empty (STAFF_AUTH_SECRET / PORTAL_AUTH_SECRET in $AUTH_ENV)"
  [ "${#staff}" -ge 32 ] && [ "${#portal}" -ge 32 ] || die "refusing: STAFF_AUTH_SECRET and PORTAL_AUTH_SECRET must each render at least 32 characters"
  [ "$staff" != "$portal" ] || die "refusing to deploy: the staff and portal AUTH_SECRET render EQUAL (staff and client sessions would be replayable across hosts)"
  { [ "$staff" != "$shared_s" ] && [ "$portal" != "$shared_p" ] && [ "$staff" != "$shared_p" ] && [ "$portal" != "$shared_s" ]; } \
    || die "refusing to deploy: an auth secret renders equal to the shared NEXTAUTH_SECRET"
  jq -e '[.services.app, .services["app-portal"] | .environment | (has("STAFF_AUTH_SECRET") or has("PORTAL_AUTH_SECRET"))] | any | not' <<<"$cfg" >/dev/null \
    || die "refusing to deploy: STAFF_AUTH_SECRET or PORTAL_AUTH_SECRET reaches a container's environment (it is set in $ENV_FILE, which both containers read); keep the per-host secrets in $AUTH_ENV only"
  jq -e '[.services.app, .services["app-portal"] | .environment | ((.POSTGRES_USER // "") + (.POSTGRES_PASSWORD // "") + (.MIGRATE_DATABASE_URL // "") + (.OWNER_DATABASE_URL // ""))] | all(. == "")' <<<"$cfg" >/dev/null \
    || die "refusing to deploy: the owner database login (POSTGRES_USER/POSTGRES_PASSWORD/MIGRATE_DATABASE_URL) reaches an app container's environment; the app must connect as APP_DB_USER only (docs/DEPLOY.md, 'Two database logins')"
  jq -e '.services.db.ports == null' <<<"$cfg" >/dev/null || die "refusing to deploy: the database would publish a host port"
  APP_PORT="$(jq -r '.services.app.ports[0].published' <<<"$cfg")" PORTAL_PORT="$(jq -r '.services["app-portal"].ports[0].published' <<<"$cfg")"
  host="$(jq -r '.services.app.ports[0].host_ip // ""' <<<"$cfg")"
  [ "$host" = "$(jq -r '.services["app-portal"].ports[0].host_ip // ""' <<<"$cfg")" ] || die "refusing: the staff and portal ports are bound to different addresses"
  case "$host" in "" | 0.0.0.0 | "::" | "[::]") host=127.0.0.1 ;; esac
  PROBE_HOST="$host"
}

# page_ok URL — HTTP 200 from a page that resolves the tenant (the login pages):
# /api/health alone passes for an image whose baked tenant slug is wrong, while
# every page that needs the lender's identity returns 500.
page_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null)" = 200 ]; }

# wait_host PORT LOGIN_PATH EXPECT_COMMIT DEADLINE_SECONDS_VALUE — one host: /api/health
# (database, commit), then its tenant-resolving login page.
wait_host() {
  local origin="http://$PROBE_HOST:$1" left=$(( $4 - SECONDS ))
  [ "$left" -ge 1 ] || left=1
  wait_health "$origin/api/health" "$3" "$left" || return 1
  until page_ok "$origin$2"; do
    [ "$SECONDS" -lt "$4" ] || return 1
    sleep 2
  done
}

# wait_stack_health EXPECT_COMMIT TIMEOUT — both hosts healthy, probed at the bound address.
wait_stack_health() {
  local deadline=$((SECONDS + $2))
  wait_host "$APP_PORT" /login "$1" "$deadline" && wait_host "$PORTAL_PORT" /portal/login "$1" "$deadline"
}

# port_is_ours PORT — a RUNNING (or restarting) container of this lender is
# configured to publish PORT. A crash-looping container still holds its bindings
# between restarts, so `docker ps` Ports would call its own port foreign; but an
# exited or created one holds nothing, so a listener on that port is someone else's.
port_is_ours() {
  local id
  for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter status=running --filter status=restarting); do
    docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' "$id" | tr ' ' '\n' | grep -x "$1" >/dev/null && return 0
  done
  return 1
}

# check_ports_free — refuse when something other than this lender's own
# containers already listens on either published port (a `compose up` would fail
# half way and leave the image state split).
check_ports_free() {
  local p
  for p in "$APP_PORT" "$PORTAL_PORT"; do
    if (exec 3<>"/dev/tcp/$PROBE_HOST/$p") 2>/dev/null && ! port_is_ours "$p"; then
      die "host port $p ($PROBE_HOST) is already in use by something other than this lender's containers"
    fi
  done
}

# What "an unfinished migration" means, once, for backup and restore. Prisma leaves
# `finished_at` NULL on a migration that failed, and `migrate resolve --rolled-back`
# does NOT set it: it sets `rolled_back_at` and the row stays, finished_at NULL, for
# good. So a resolved failure must not count as unfinished, or every backup taken
# after the documented recovery would be refused by restore.sh forever.
MIG_UNFINISHED_WHERE="finished_at IS NULL AND rolled_back_at IS NULL"
MIG_STATE_SQL="SELECT count(*) FILTER (WHERE $MIG_UNFINISHED_WHERE) || ' ' || count(*) FROM _prisma_migrations"

# count_drift SIDECAR RESTORED — one line per table whose row count differs
# between the backup's sidecar and the restored text ("Table: backup=N restored=M");
# status 1 when any does.
count_drift() {
  local t b r drift=0
  while IFS='=' read -r t b; do
    [ -n "$t" ] || continue
    r="$(grep -m1 "^$t=" <<<"$2" | cut -d= -f2)"
    [ "$b" = "$r" ] || { echo "$t: backup=$b restored=${r:-missing}"; drift=1; }
  done < "$1"
  return "$drift"
}

# SNAPSHOT_DUMP_SH — runs INSIDE the db container (busybox sh; env U, DB,
# COUNTS_SQL, COUNTS_FILE). One session holds a REPEATABLE READ transaction and
# exports its snapshot; the row counts are taken in it and pg_dump --snapshot
# dumps that same snapshot, so the sidecar describes exactly what the dump holds
# even while the app writes. The dump goes to stdout; the counts to COUNTS_FILE.
SNAPSHOT_DUMP_SH="$(cat <<'SH'
set -eu
d="$(mktemp -d)"
trap 'rm -rf "$d"' EXIT
mkfifo "$d/in"
psql -v ON_ERROR_STOP=1 -qAt -U "$U" -d "$DB" <"$d/in" >"$d/out" 2>"$d/err" &
pid=$!
exec 3>"$d/in"
wait_for() {
  i=0
  until grep -q -- "$1" "$d/out" 2>/dev/null; do
    kill -0 "$pid" 2>/dev/null || { cat "$d/err" >&2; echo "snapshot session ended early" >&2; exit 1; }
    i=$((i + 1))
    [ "$i" -lt 3000 ] || { echo "timed out waiting for the snapshot session" >&2; exit 1; }
    sleep 0.2
  done
}
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" >&3
echo "SELECT 'snap='||pg_export_snapshot();" >&3
wait_for '^snap='
snap="$(sed -n 's/^snap=//p' "$d/out" | head -n 1)"
printf '%s;\n' "$COUNTS_SQL" >&3
# The migration table check runs in the dump's own snapshot too: a backup restore.sh
# would reject is refused here, at backup time, not discovered at restore time.
printf "SELECT 'mig_unfinished='||coalesce(string_agg(migration_name, ','), '') FROM _prisma_migrations WHERE %s;\n" "$MIG_UNFINISHED_WHERE" >&3
echo "SELECT '--end--';" >&3
wait_for '^--end--$'
grep -e '^mig_unfinished=' "$d/out" > "$COUNTS_FILE.mig"
grep -v -e '^snap=' -e '^--end--$' -e '^mig_unfinished=' "$d/out" > "$COUNTS_FILE"
pg_dump -Fc --no-owner --snapshot="$snap" -U "$U" -d "$DB"
echo "COMMIT;" >&3
exec 3>&-
wait "$pid" || true
SH
)"
