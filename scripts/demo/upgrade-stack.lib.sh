# shellcheck shell=bash disable=SC2154  # sourced by upgrade-stack.sh: it sets the variables used here
# Helpers of upgrade-stack.sh (sourced, not run). They read the script's globals
# ($LIVE_*, $live_dir, $db, $image, $dump, $step, …) when they are called.

# sha_from_tag TAG PREFIX — the commit in an image tag or GIT_SHA of the form
# [repo:]<PREFIX>-<sha>[-suffix]: the first run of 7+ hex digits after the prefix
# (so fairscore-0c362f0-banner gives 0c362f0). Prints nothing when there is none.
sha_from_tag() {
  local rest="${1#*:}"
  case "$rest" in "$2"-*) rest="${rest#"$2"-}" ;; *-*) rest="${rest#*-}" ;; esac
  [[ "$rest" =~ (^|-)([0-9a-f]{7,40})(-|$) ]] && printf %s "${BASH_REMATCH[2]}"
  return 0
}

# check_downgrade — the target must be the stack's current commit or a descendant
# of it. The current commit comes from the running image tag, else GIT_SHA.
check_downgrade() {
  local running cur cur_commit problem=""
  running="$(docker inspect -f '{{.Config.Image}}' "$LIVE_APP")" || die "cannot read the image of $LIVE_APP"
  cur="$(sha_from_tag "$running" "$suffix")"
  [ -n "$cur" ] || cur="$(sha_from_tag "$prev_sha" "$suffix")"
  if [ -z "$cur" ]; then
    problem="cannot read the stack's current commit from its image '$running' or GIT_SHA '$prev_sha'"
  elif ! cur_commit="$(git -C "$DEMO_ROOT" rev-parse --verify --quiet "$cur^{commit}")"; then
    problem="the stack's current commit $cur is not in this repo"
  elif ! git -C "$DEMO_ROOT" merge-base --is-ancestor "$cur_commit" "$sha"; then
    problem="$short is not a descendant of the stack's current commit $cur (a downgrade or a sideways move)"
  fi
  [ -z "$problem" ] && return 0
  $allow_downgrade || die "refusing: $problem; --allow-downgrade overrides (migrations are forward-only: the db keeps newer ones)"
  note "WARNING: --allow-downgrade: $problem. Proceeding; a target missing migrations the database already has is still refused by the migrate-status check."
}

# require_active SLUG WHAT — die unless SLUG is an ACTIVE tenant of $db ($active).
require_active() {
  printf '%s\n' "$active" | grep -xF -- "$1" >/dev/null \
    || die "$2 names slug '$1' but $db has no ACTIVE tenant with that slug; fix the config or the tenant before upgrading"
}

# check_secrets — every KEY in $SHARED_SECRETS must have the same value in the running
# app container, or recreating it would change a secret (WABA_ENC_KEY would orphan the
# sealed SMTP password). Both sides are compared as sha256 inside one node process fed
# by a pipe and a file path: no value or hash reaches argv or output, only key names.
check_secrets() {
  local bad
  [ -s "$SHARED_SECRETS" ] || die "refusing: secrets file $SHARED_SECRETS is missing or empty"
  # shellcheck disable=SC2016  # the script is JavaScript
  bad="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$LIVE_APP" | node -e '
const fs = require("node:fs"), { createHash } = require("node:crypto"), { parseEnv } = require("node:util")
const sha = (v) => createHash("sha256").update(v).digest("hex")
const want = parseEnv(fs.readFileSync(process.argv[1], "utf8"))
const have = {}
for (const line of fs.readFileSync(0, "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0) have[line.slice(0, i)] = line.slice(i + 1) }
process.stdout.write(Object.keys(want).filter((k) => !(k in have) || sha(have[k]) !== sha(want[k])).join(" "))' "$SHARED_SECRETS")" \
    || die "cannot compare $SHARED_SECRETS with the env of $LIVE_APP"
  [ -z "$bad" ] || die "refusing: $SHARED_SECRETS differs from the env of the running $LIVE_APP in: $bad (a recreated container would run with other secrets; recreate it on the old values or fix the file)"
}

# restore_hint — the commands that put $dump back. A plain `pg_restore --clean` into the
# migrated db would leave it half restored (new tables reference old ones), so: stop app +
# portal, drop and recreate the db, restore into the empty one. The db container mounts
# $live_dir/backups at /backups when its compose file says so (checked on the running
# container); otherwise the dump is fed through stdin from the host.
restore_hint() {
  local src recreate load
  src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Source}}{{end}}{{end}}' "$LIVE_DB" 2>/dev/null)" || src=""
  recreate="docker stop $LIVE_APP $LIVE_PORTAL && docker exec $LIVE_DB sh -c 'dropdb -U \"\$POSTGRES_USER\" --force \"\$POSTGRES_DB\" && createdb -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"' && "
  if [ -n "$src" ] && [ "$(readlink -f "$src")" = "$(readlink -f "$live_dir/backups")" ]; then
    load="docker exec $LIVE_DB pg_restore -U $db_user -d $db --exit-on-error /backups/${dump##*/}"
  else
    load="docker exec -i $LIVE_DB pg_restore -U $db_user -d $db --exit-on-error < $dump"
  fi
  printf '%s%s && docker start %s %s' "$recreate" "$load" "$LIVE_APP" "$LIVE_PORTAL"
}

# host_port CONTAINER — the published :3300 as host:port (host_addr in lib.sh).
# Kept in sync with restore.sh host_port.
host_port() {
  local ip port
  ip="$(docker inspect -f '{{with index .HostConfig.PortBindings "3300/tcp"}}{{(index . 0).HostIp}}{{end}}' "$1")"
  port="$(docker inspect -f '{{with index .HostConfig.PortBindings "3300/tcp"}}{{(index . 0).HostPort}}{{end}}' "$1")"
  [ -n "$port" ] || return 0
  host_addr "$ip" "$port"
}

# compose ARGS… — docker-compose on this stack's project and file, from its dir. Every
# variable the stack's .env defines (compose interpolates them) is unset first, as are
# the six the script pins: a stray shell export would override .env (compose prefers the
# environment) and start the wrong image, db or portal URL.
compose() {
  local -a unset_args=(-u APP_IMAGE -u GIT_SHA -u BUILD_TIME -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB)
  local key
  while IFS= read -r key; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && unset_args+=(-u "$key")
  done < <(node -e 'process.stdout.write(Object.keys(require("node:util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8"))).join("\n"))' "$live_dir/.env")
  (cd "$live_dir" && env "${unset_args[@]}" docker-compose -p "$LIVE_PROJECT" -f "$LIVE_COMPOSE_FILE" "$@") >&2
}
# Kept in sync with restore.sh compose_up.
compose_up() { compose up -d --no-deps app app-portal; }

# Kept in sync with restore.sh wait_health (plus --max-time on the request).
wait_health() {
  local addr="$1"
  for _ in $(seq 1 120); do
    curl -sf --max-time 5 -o /dev/null "http://$addr/api/health" && return 0
    sleep 0.5
  done
  echo "upgrade-stack.sh: /api/health on $addr did not answer 200 within 60 s" >&2
  return 1
}

# page_ok HOST ADDR PATH — GET PATH on ADDR as HOST: 200 means the app resolved a tenant for HOST.
page_ok() {
  local code
  code="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -H "Host: $1" "http://$2$3")" || true
  [ "$code" = 200 ] && return 0
  echo "upgrade-stack.sh: GET $3 on $2 with Host $1 returned ${code:-no answer}, expected 200" >&2
  return 1
}

# check_running_image IMAGE — app and portal both run IMAGE (docker inspect, not .env).
check_running_image() {
  local c got
  for c in "$LIVE_APP" "$LIVE_PORTAL"; do
    got="$(docker inspect -f '{{.Config.Image}}' "$c")" || return 1
    [ "$got" = "$1" ] || { echo "upgrade-stack.sh: $c runs $got, not $1" >&2; return 1; }
  done
}

# verify_swap — both containers healthy and on $image, and every mapped host resolves its tenant.
verify_swap() {
  local entry host
  step="health check"
  wait_health "$staff_addr" && wait_health "$portal_addr" || return 1
  step="running image check"
  check_running_image "$image" || return 1
  step="tenant resolution check"
  for entry in "${entries[@]}"; do
    host="${entry%%=*}"
    host="${host//[[:space:]]/}"
    page_ok "$host" "$staff_addr" /login && page_ok "$host" "$portal_addr" /portal/login || return 1
  done
}

# migrate_status — prisma migrate status from the worktree. Exit 1 with "have not yet
# been applied" alone is the normal pre-upgrade state; any other failure is fatal: no
# connection or credentials, a failed migration ("have failed"; a bare "failed" would
# also match a pending migration named ..._failed_...), or a diverged history (Prisma then says
# "are different" / "not found locally" next to "have not yet been applied").
migrate_status() {
  local rc=0 out
  out="$(cd "$wt" && DATABASE_URL="$db_url" NODE_ENV='' npx prisma migrate status 2>&1)" || rc=$?
  printf '%s\n' "$out" >&2
  [ "$rc" -ne 0 ] || return 0
  { grep -q 'have not yet been applied' <<<"$out" && ! grep -qiE 'have failed|are different|not found locally' <<<"$out"; } \
    || die "prisma migrate status failed (exit $rc) against $db_bind; see its output above"
  note "pending migrations will be applied (listed above)"
}
