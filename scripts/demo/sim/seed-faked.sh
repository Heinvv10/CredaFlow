#!/usr/bin/env bash
# Runs the base seed (prisma/seed.ts), or another script given as $1 (relative
# to the repo root; sim/provision-operator.ts) with any further arguments,
# UNDER THE SIM CLOCK.
#
# The seed stamps rows with host-side `new Date()` values (daysAgo(), loan
# dates) and Prisma's engine fills @default(now()) / @updatedAt itself, so a
# seed run on the host carries the real date. This runs it in a throwaway
# node:22 (Debian, glibc — the worktree's Prisma engine is debian-openssl-3.0.x)
# container on the sim network, with libfaketime preloaded from the shared
# clock file and Prisma's RTLD_DEEPBIND flag patched out exactly as
# Dockerfile.demo-sim does — into a temp copy bind-mounted over the worktree's
# file, so the host's node_modules is never modified.
#
#   scripts/demo/sim/seed-faked.sh > scripts/demo/.sim-credentials.txt
#
# DEMO_LENDER (prisma/demo-lender.ts) is passed through, so the seed brands
# the tenant as the lender the bake is for.
#
# Set the clock (clock.ts set …) and migrate first. Seed output (including the
# credentials, SEED_PRINT_CREDENTIALS=1) goes to stdout; progress to stderr.
set -euo pipefail

# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/../lib.sh"
ROOT="$DEMO_ROOT"
IMAGE=credaflow-demo-sim-seed:local
RUNTIME=node_modules/@prisma/client/runtime/library.js
SCRIPT="${1:-prisma/seed.ts}"
[ $# -eq 0 ] || shift

# Exported and handed to the container by name (-e DATABASE_URL): the URL
# carries the password, so it never appears in an argv.
DATABASE_URL="$(env_get "$ROOT/.env.demo-sim" DATABASE_URL)"
export DATABASE_URL
[ -n "$DATABASE_URL" ] || { echo "seed-faked: DATABASE_URL missing from .env.demo-sim" >&2; exit 1; }
[ -s "$ROOT/scripts/demo/.sim-clock/faketime.rc" ] || { echo "seed-faked: set the sim clock first (clock.ts set …)" >&2; exit 1; }

# Pinned demo passwords (lib.sh SEED_PASSWORDS, seed_passwords_ok).
seed_env=()
if [ -f "$SEED_PASSWORDS" ]; then
  if ! seed_passwords_ok "$SEED_PASSWORDS"; then
    echo "seed-faked: $SEED_PASSWORDS may hold only SEED_*_PASSWORD=… lines (no comments)" >&2
    exit 1
  fi
  seed_env=(--env-file "$SEED_PASSWORDS")
fi

docker build -q -t "$IMAGE" - >&2 <<'EOF'
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime openssl && rm -rf /var/lib/apt/lists/*
EOF

PATCH_DIR="$(mktemp -d)"
cp "$ROOT/$RUNTIME" "$PATCH_DIR/library.js"
grep -q '|so.default.constants.dlopen.RTLD_DEEPBIND' "$PATCH_DIR/library.js"
sed -i 's/|so.default.constants.dlopen.RTLD_DEEPBIND//' "$PATCH_DIR/library.js"
if grep -q 'RTLD_DEEPBIND' "$PATCH_DIR/library.js"; then
  echo "seed-faked: RTLD_DEEPBIND still present after the patch" >&2
  exit 1
fi
chmod 644 "$PATCH_DIR/library.js"

# The seed writes the same document artifacts as the app. Give this host user
# temporary group write access to the simulator's uploads volume, then restore
# the app's ownership even when the seed fails.
APP_UID="$(docker exec "$SIM_APP" id -u)"
APP_GID="$(docker exec "$SIM_APP" id -g)"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
mkdir -p "$ROOT/uploads"
docker exec -u root "$SIM_APP" chown "$APP_UID:$HOST_GID" /app/uploads
docker exec -u root "$SIM_APP" chmod 2775 /app/uploads
cleanup() {
  docker exec -u root "$SIM_APP" chown -R "$APP_UID:$APP_GID" /app/uploads
  docker exec -u root "$SIM_APP" chmod g-s /app/uploads
  docker exec -u root "$SIM_APP" chmod 755 /app/uploads
  rm -rf "$PATCH_DIR"
}
trap cleanup EXIT

docker run --rm \
  --network "$SIM_NETWORK" \
  --user "$HOST_UID:$HOST_GID" \
  -e HOME=/tmp \
  -e DATABASE_URL \
  -e DEMO_LENDER \
  -e DEMO_MODE=true \
  -e EXPERIAN_DRY_RUN=true \
  -e EXPERIAN_ENV=UAT \
  ${seed_env[@]+"${seed_env[@]}"} \
  -e SEED_PRINT_CREDENTIALS=1 \
  -e TZ=UTC \
  -e FAKETIME_TIMESTAMP_FILE=/sim-clock/faketime.rc \
  -e FAKETIME_NO_CACHE=1 \
  -e FAKETIME_DONT_FAKE_MONOTONIC=1 \
  -e LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 \
  -v "$ROOT":/w:ro \
  -v "${SIM_PROJECT}_uploads":/w/uploads \
  -v "$PATCH_DIR/library.js":"/w/$RUNTIME":ro \
  -v "$ROOT/scripts/demo/.sim-clock":/sim-clock:ro \
  -w /w \
  "$IMAGE" \
  node_modules/.bin/tsx "$SCRIPT" "$@"
