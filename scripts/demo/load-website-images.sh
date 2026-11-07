#!/usr/bin/env bash
# Loads a directory of website photos into a RUNNING docker-compose demo stack
# (no bake, no sim): the live demo's staff UI can do the same one slot at a time.
#
#   scripts/demo/load-website-images.sh <compose-project> <tenant-slug> <images-dir>
#   scripts/demo/load-website-images.sh credaflow-nairobi nairobi ~/credaflow-nairobi-data/branding/website-images
#
# <images-dir> holds hero.jpg, product-<code>.jpg, community.jpg and manifest.json
# (scripts/demo/website-images.ts). The stack must run an image that has the
# websiteImagery migration (a stack on an older image has no such column).
#
# set-website-images.ts runs in a throwaway node container from THIS worktree
# (mounted read-only; it needs `npm ci` here), on the stack's network, against
# the stack's DATABASE_URL, as the app container's own uid:gid, with the stack's
# uploads volume at /w/uploads. Files and directories are therefore created
# owned by the app user, which later staff uploads need. It refuses a stack whose
# app container is not DEMO_MODE=true.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <compose-project> <tenant-slug> <images-dir>" >&2; exit 1; }
project="$1" slug="$2" dir="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="$project-app"
die() { echo "load-website-images: $*" >&2; exit 1; }

[ -d "$dir" ] || die "$dir is not a directory"
dir="$(cd "$dir" && pwd)"
docker inspect "$app" >/dev/null 2>&1 || die "$app not found (is the stack up?)"
[ -d "$ROOT/node_modules/@prisma/client" ] || die "run npm ci --legacy-peer-deps in $ROOT first"

env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app"; }
grep -qx 'DEMO_MODE=true' <<< "$(env_of)" || die "$app is not DEMO_MODE=true; this loader is for demo stacks"
DATABASE_URL="$(env_of | sed -n 's/^DATABASE_URL=//p' | head -1)"
[ -n "$DATABASE_URL" ] || die "$app has no DATABASE_URL"
export DATABASE_URL
uid="$(docker exec "$app" id -u)"
gid="$(docker exec "$app" id -g)"
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' "$app")"
[ -n "$volume" ] || die "$app has no named volume at /app/uploads"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$app" | head -1)"
[ -n "$network" ] || die "$app is on no network"

# Fail on a bad directory before touching the stack.
(cd "$ROOT" && npx tsx scripts/demo/set-website-images.ts --check "$dir") || die "$dir is not a valid image directory"

image=credaflow-imagery-loader:local
docker build -q -t "$image" - >&2 <<'DOCKERFILE'
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
DOCKERFILE

mkdir -p "$ROOT/uploads" # the mount point for the volume inside the read-only worktree
docker run --rm \
  --network "$network" \
  --user "$uid:$gid" \
  -e HOME=/tmp \
  -e DATABASE_URL \
  -e DEMO_MODE=true \
  -v "$ROOT":/w:ro \
  -v "$volume":/w/uploads \
  -v "$dir":"$dir":ro \
  -w /w \
  "$image" \
  node_modules/.bin/tsx scripts/demo/set-website-images.ts "$slug" "$dir"
