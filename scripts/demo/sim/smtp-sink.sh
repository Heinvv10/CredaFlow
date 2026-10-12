#!/usr/bin/env bash
# Starts (idempotently) or stops the sim stack's SMTP sink (smtp-sink.ts): a
# container on the sim network named credaflow-demo-sim-smtp, port 2525,
# filing every message under scripts/demo/.out/sim-mail/. No host port.
#
#   scripts/demo/sim/smtp-sink.sh up | down
#
# `down` must run before `docker-compose … down`: a container still attached
# to the sim network stops compose from removing it (fresh-stack.sh does this).
set -euo pipefail

# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/../lib.sh"
ROOT="$DEMO_ROOT"
NAME="$SIM_SMTP"
NETWORK="$SIM_NETWORK"
IMAGE=node:22-bookworm-slim
MAIL_DIR="$ROOT/scripts/demo/.out/sim-mail"

case "${1:-}" in
  up)
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = true ]; then
      echo "smtp-sink: already running" >&2
      exit 0
    fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    mkdir -p "$MAIL_DIR"
    docker run -d --name "$NAME" \
      --network "$NETWORK" \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp \
      -e SIM_MAIL_DIR=/mail \
      -v "$ROOT":/w:ro \
      -v "$MAIL_DIR":/mail \
      -w /w \
      "$IMAGE" \
      node_modules/.bin/tsx scripts/demo/sim/smtp-sink.ts >/dev/null
    for _ in $(seq 1 30); do
      docker logs "$NAME" 2>&1 | grep -q listening && { echo "smtp-sink: up" >&2; exit 0; }
      sleep 1
    done
    echo "smtp-sink: did not start" >&2
    docker logs "$NAME" >&2 || true
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "smtp-sink: down" >&2
    ;;
  *)
    echo "usage: smtp-sink.sh up|down" >&2
    exit 2
    ;;
esac
