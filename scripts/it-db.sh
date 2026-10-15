#!/usr/bin/env bash
#
# Disposable Postgres 16 for the integration suites, with a collision-proof port.
#
#   eval "$(bash scripts/it-db.sh up cf-it-<unique>)"   # exports DATABASE_URL + IT_CONTAINER
#   bash scripts/it-db.sh check    # before `prisma migrate deploy`: IT_CONTAINER must own DATABASE_URL's port
#   bash scripts/it-db.sh down cf-it-<unique>
#
# WHY: many sessions on one machine start containers with the same password. A
# fixed `-p 55432:5432` fails when another session holds the port, and a script
# that carries on then migrates and tests the OTHER session's database. `up`
# picks a free port, aborts if docker run fails, and proves the port maps to
# THIS container before printing anything. scripts/run-integration-tests.sh
# re-checks that mapping when IT_CONTAINER is set.
# Only stdout of `up` is the two export lines; progress goes to stderr.
set -euo pipefail

PORT_MIN=40000
PORT_MAX=59999
LABEL_KEY="credaflow.it.owner"

usage() {
  echo "usage: bash scripts/it-db.sh up <name> | down <name> | check" >&2
  exit 2
}

CMD="${1:-}"
NAME="${2:-}"
if [[ "$CMD" == "check" ]]; then
  [[ $# -eq 1 ]] || usage
elif [[ $# -ne 2 ]]; then
  usage
elif [[ ! "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "!! invalid container name: $NAME" >&2
  exit 2
fi

owner_of() {
  docker container inspect -f "{{ index .Config.Labels \"${LABEL_KEY}\" }}" "$1" 2>/dev/null || true
}

# Port of a postgres URL (5432 when absent).
url_port() {
  local rest="${1#*://}"
  rest="${rest%%[/?#]*}"
  rest="${rest##*@}"
  if [[ "$rest" == \[* ]]; then
    rest="${rest#*]}"
    rest="${rest#:}"
  elif [[ "$rest" == *:* ]]; then
    rest="${rest#*:}"
  else
    rest=""
  fi
  printf '%s\n' "${rest:-5432}"
}

# Refuse unless $IT_CONTAINER publishes 5432 on exactly DATABASE_URL's port.
# The runner calls this too, so the two cannot drift.
check() {
  if [[ -z "${IT_CONTAINER:-}" || -z "${DATABASE_URL:-}" ]]; then
    echo "!! check needs IT_CONTAINER and DATABASE_URL (eval \"\$(bash scripts/it-db.sh up <name>)\")" >&2
    exit 1
  fi
  local want mapped ports
  want="$(url_port "$DATABASE_URL")"
  mapped="$(docker port "$IT_CONTAINER" 5432/tcp 2>/dev/null || true)"
  ports="$(printf '%s\n' "$mapped" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | sort -u)"
  if [[ -z "$ports" || "$ports" != "$want" ]]; then
    echo "!! IT_CONTAINER '$IT_CONTAINER' does not own DATABASE_URL port $want" >&2
    echo "!! (docker port says: ${mapped:-nothing}). Another session's database may be on that port." >&2
    echo "!! Refusing. Start your own: eval \"\$(bash scripts/it-db.sh up cf-it-<unique>)\"" >&2
    exit 1
  fi
}

port_in_use() {
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "[:.]$1\$" >/dev/null
}

up() {
  command -v docker >/dev/null 2>&1 || { echo "!! docker is required" >&2; exit 1; }
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    echo "!! container '$NAME' already exists (not ours to reuse). Pick another name." >&2
    exit 1
  fi

  local attempt port started=""
  for attempt in $(seq 1 20); do
    port=$((PORT_MIN + RANDOM % (PORT_MAX - PORT_MIN + 1)))
    if port_in_use "$port"; then continue; fi
    if docker run -d --name "$NAME" -e POSTGRES_PASSWORD=it \
      -p "127.0.0.1:${port}:5432" --label "${LABEL_KEY}=${NAME}" \
      postgres:16-alpine >/dev/null; then
      started=1
      break
    fi
    # Lost a race for the port: docker may leave a Created container behind.
    # Remove it only if it is ours (carries our label).
    if [[ "$(owner_of "$NAME")" == "$NAME" ]]; then docker rm -fv "$NAME" >/dev/null 2>&1 || true; fi
  done
  if [[ -z "$started" ]]; then
    echo "!! could not start '$NAME' on a free port after 20 attempts" >&2
    exit 1
  fi

  local ready=""
  for attempt in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ -z "$ready" ]]; then
    echo "!! postgres in '$NAME' did not become ready; removing it" >&2
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    exit 1
  fi

  local mapped
  mapped="$(docker port "$NAME" 5432/tcp)"
  if ! grep -qE "^127\.0\.0\.1:${port}\$" <<<"$mapped"; then
    echo "!! '$NAME' does not map 5432 to 127.0.0.1:${port} (got: ${mapped:-nothing}); removing it" >&2
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    exit 1
  fi

  echo ">> $NAME ready on 127.0.0.1:${port}" >&2
  echo "export DATABASE_URL=postgresql://postgres:it@127.0.0.1:${port}/postgres"
  echo "export IT_CONTAINER=${NAME}"
}

down() {
  # Only remove containers this script labelled, never someone else's.
  if [[ -z "$(owner_of "$NAME")" ]]; then
    echo ">> '$NAME' not found or not created by it-db.sh; nothing removed" >&2
    return 0
  fi
  docker rm -fv "$NAME" >/dev/null
  echo ">> removed $NAME" >&2
}

case "$CMD" in
  up) up ;;
  down) down ;;
  check) check ;;
  *) usage ;;
esac
