#!/usr/bin/env bash
# Builds the demo PRODUCT image from this worktree and prints its tag.
#
#   scripts/demo/build-image.sh                                 # → credaflow:demo-<tag>
#   DEMO_LENDER=fairscore LIVE_DIR=… scripts/demo/build-image.sh  # → credaflow:fairscore-<tag>
#
# The prefix is "demo" for the default lender (acme) and the DEMO_LENDER name
# otherwise: the build args differ per lender, so two lenders never share a tag.
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
# Two optional overrides, for upgrade-stack.sh (unset, nothing above changes):
#   DEMO_BUILD_ROOT=<dir>   build this source tree (a checkout or worktree)
#                           instead of the one this script lives in; the tag, the
#                           lender check and the Dockerfile all come from it
#   DEMO_IMAGE_NAME=<tag>   use this image tag instead of credaflow:<prefix>-<tag>,
#                           and label the image credaflow.tenant_slug=<slug> so a
#                           later reuse of the tag can tell which tenant it serves
#
# Moving the live demo onto the result (then bake + restore, because restore
# refuses a snapshot baked on another image): set APP_IMAGE, GIT_SHA and
# BUILD_TIME in $LIVE_DIR/.env, then in $LIVE_DIR
#   docker-compose -f docker-compose.demo.yml up -d --no-deps app app-portal
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"
DEMO_ROOT="${DEMO_BUILD_ROOT:-$DEMO_ROOT}"

TURNSTILE_TEST_SITE_KEY=1x00000000000000000000AA

want_slug="$(demo_slug)"   # also refuses an unknown DEMO_LENDER
tag="$(worktree_tag)"
prefix=demo
[ "${DEMO_LENDER:-acme}" = acme ] || prefix="$DEMO_LENDER"
image="${DEMO_IMAGE_NAME:-credaflow:$prefix-$tag}"
if docker image inspect "$image" >/dev/null 2>&1; then
  note "$image already exists; not rebuilding"
  echo "$image"
  exit 0
fi

slug="$(env_get "$LIVE_DIR/.env" NEXT_PUBLIC_TENANT_SLUG)"
portal_login="$(env_get "$LIVE_DIR/.env" NEXT_PUBLIC_PORTAL_LOGIN_URL)"
[ -n "$slug" ] && [ -n "$portal_login" ] || die "NEXT_PUBLIC_TENANT_SLUG / NEXT_PUBLIC_PORTAL_LOGIN_URL missing from $LIVE_DIR/.env"
[ "$slug" = "$want_slug" ] || die "$LIVE_DIR/.env has tenant slug '$slug'; DEMO_LENDER=${DEMO_LENDER:-acme} needs '$want_slug'"

# A tag chosen by the caller is labelled with the tenant slug it bakes in; the
# default build gets no label (its argv is unchanged).
label_args=()
[ -z "${DEMO_IMAGE_NAME:-}" ] || label_args=(--label "credaflow.tenant_slug=$slug")

note "building $image (tenant $slug, portal $portal_login)"
docker build -f "$DEMO_ROOT/Dockerfile" -t "$image" \
  --build-arg GIT_SHA="$tag" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg NEXT_PUBLIC_TENANT_SLUG="$slug" \
  --build-arg NEXT_PUBLIC_PORTAL_LOGIN_URL="$portal_login" \
  --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_TEST_SITE_KEY" \
  ${label_args[@]+"${label_args[@]}"} \
  "$DEMO_ROOT" >&2
echo "$image"
