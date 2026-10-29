#!/usr/bin/env bash
#
# Throwaway PostgreSQL 16 cluster for the integration gate on a self-hosted
# runner, which has no docker. Replaces the `services: postgres` container.
#
#   bash scripts/ci/pg-cluster.sh start   # in a workflow: appends DATABASE_URL and CI_PG_DIR to $GITHUB_ENV
#   bash scripts/ci/pg-cluster.sh stop <dir>
#
# Each start makes its own directory (mktemp), picks a port the kernel just
# handed out and listens on 127.0.0.1 only (no unix socket), so shards running
# at once on one machine never share a cluster. Login is scram with ituser /
# itpass (a superuser, as POSTGRES_USER was in the container) on database
# credaflow_it. Durability is off: the data is thrown away when the run ends.
# Outside Actions (no $GITHUB_ENV) `start` prints the two export lines instead.
#
# Locale C.UTF-8 and timezone UTC: the postgres:16-alpine image the container
# used is musl, which collates by code point.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_USER=ituser
PG_PASSWORD=itpass
PG_DATABASE=credaflow_it

# A port the kernel says is free right now. Another process can take it before
# postgres binds it, so `start` retries on a fresh one.
free_port() {
  node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

# Stop the postmaster in <dir>/data, only while that pid is still a process
# working in this data directory: pg_ctl signals whatever pid postmaster.pid
# names, and a stale file could name an unrelated process after pid reuse.
stop_cluster() {
  local dir=$1 pid
  [ -f "$dir/data/postmaster.pid" ] || return 0
  pid=$(head -n 1 "$dir/data/postmaster.pid")
  [ -n "$pid" ] && [ "$(readlink "/proc/$pid/cwd" 2> /dev/null)" = "$(cd "$dir/data" && pwd -P)" ] || return 0
  "$PG_BIN/pg_ctl" -D "$dir/data" -m immediate stop > /dev/null 2>&1 || true
}

# The directory of a start that has not finished: removed on any failure.
PENDING_DIR=""
cleanup_pending() {
  [ -z "$PENDING_DIR" ] && return 0
  stop_cluster "$PENDING_DIR"
  rm -rf "$PENDING_DIR"
}

start() {
  local dir port try
  dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cf-it-pg.XXXXXX")
  PENDING_DIR=$dir
  trap cleanup_pending EXIT

  printf '%s\n' "$PG_PASSWORD" > "$dir/pwfile"
  "$PG_BIN/initdb" -D "$dir/data" -U "$PG_USER" --auth=scram-sha-256 --pwfile="$dir/pwfile" \
    -E UTF8 --locale=C.UTF-8 > "$dir/initdb.log" 2>&1 || { cat "$dir/initdb.log" >&2; return 1; }
  rm -f "$dir/pwfile"

  for try in 1 2 3 4 5; do
    port=$(free_port)
    if "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w -t 120 -o "-p $port \
        -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200 \
        -c timezone=UTC -c log_timezone=UTC \
        -c fsync=off -c full_page_writes=off -c synchronous_commit=off" start > /dev/null; then
      break
    fi
    echo "!! postgres could not start on port $port (attempt $try); retrying" >&2
    # A start that timed out can leave its postmaster coming up on the data dir.
    stop_cluster "$dir"
    port=""
  done
  if [ -z "$port" ]; then
    tail -20 "$dir/server.log" >&2
    return 1
  fi

  PGPASSWORD="$PG_PASSWORD" "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U "$PG_USER" "$PG_DATABASE"

  PENDING_DIR=""
  local url="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DATABASE}"
  echo ">> postgres ready on 127.0.0.1:${port} (${dir})" >&2
  if [ -n "${GITHUB_ENV:-}" ]; then
    { echo "DATABASE_URL=${url}"; echo "CI_PG_DIR=${dir}"; } >> "$GITHUB_ENV"
  else
    echo "export DATABASE_URL=${url}"
    echo "export CI_PG_DIR=${dir}"
  fi
}

stop() {
  local dir=${1:-}
  # Nothing was started (the start step never ran or failed before it set the
  # variable): nothing to stop. Only ever delete a directory start made.
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  case "$(basename "$dir")" in cf-it-pg.*) ;; *) echo "!! refusing to remove $dir" >&2; return 1 ;; esac
  stop_cluster "$dir"
  rm -rf "$dir"
  echo ">> removed $dir" >&2
}

case "${1:-}" in
  start) start ;;
  stop) stop "${2:-}" ;;
  *) echo "usage: bash scripts/ci/pg-cluster.sh start | stop <dir>" >&2; exit 2 ;;
esac
