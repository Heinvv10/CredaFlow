#!/usr/bin/env bash
# Builds the demo PRODUCT image from this worktree and prints its tag.
#
#   scripts/demo/build-image.sh            # → credaflow:demo-<tag>
#
# Tag: credaflow:demo-<short sha>, or credaflow:demo-<short sha>-dirty-<hash8>
# when the worktree has uncommitted changes (worktree_tag in lib.sh: hash8 is
# over `git diff HEAD` + untracked files, so an unchanged tree reuses its tag
# and a changed one never overwrites a tag a snapshot names). GIT_SHA (what
# /api/health reports) is the same string. An existing tag is not rebuilt.
#
# Build args match the live demo's (its compose .env): NEXT_PUBLIC_TENANT_SLUG
# and NEXT_PUBLIC_PORTAL_LOGIN_URL are read from $LIVE_DIR/.env. One addition:
# NEXT_PUBLIC_TURNSTILE_SITE_KEY is Cloudflare's documented always-pass TEST
# site key, so the portal forms hide the widget (instead of an amber "Turnstile
# is disabled" notice) and the server accepts them with the test secret.
#
# Moving the live demo onto the result (then bake + restore, because restore
# refuses a snapshot baked on another image): set APP_IMAGE, GIT_SHA and
# BUILD_TIME in $LIVE_DIR/.env, then in $LIVE_DIR
#   docker-compose -f docker-compose.demo.yml up -d --no-deps app app-portal
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"

TURNSTILE_TEST_SITE_KEY=1x00000000000000000000AA

tag="$(worktree_tag)"
image="credaflow:demo-$tag"
if docker image inspect "$image" >/dev/null 2>&1; then
  note "$image already exists; not rebuilding"
  echo "$image"
  exit 0
fi

slug="$(env_get "$LIVE_DIR/.env" NEXT_PUBLIC_TENANT_SLUG)"
portal_login="$(env_get "$LIVE_DIR/.env" NEXT_PUBLIC_PORTAL_LOGIN_URL)"
[ -n "$slug" ] && [ -n "$portal_login" ] || die "NEXT_PUBLIC_TENANT_SLUG / NEXT_PUBLIC_PORTAL_LOGIN_URL missing from $LIVE_DIR/.env"

note "building $image (tenant $slug, portal $portal_login)"
docker build -f "$DEMO_ROOT/Dockerfile" -t "$image" \
  --build-arg GIT_SHA="$tag" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg NEXT_PUBLIC_TENANT_SLUG="$slug" \
  --build-arg NEXT_PUBLIC_PORTAL_LOGIN_URL="$portal_login" \
  --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_TEST_SITE_KEY" \
  "$DEMO_ROOT" >&2
echo "$image"
