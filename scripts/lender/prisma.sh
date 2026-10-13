#!/usr/bin/env bash
# Run `prisma migrate status|resolve|deploy` against a lender's database, from the
# tools image of the currently deployed image, for recovering from a failed
# migration (docs/DEPLOY.md, "A failed migration").
#
#   prisma.sh <lender-dir> migrate status
#   prisma.sh <lender-dir> migrate resolve --rolled-back <migration-name>
#   prisma.sh <lender-dir> migrate resolve --applied <migration-name>
#   prisma.sh <lender-dir> migrate deploy
#
# Takes the lender lock; nothing else of prisma is exposed.
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}"; shift || true
need docker
load_lender "$dir"
[ "${1:-}" = migrate ] && [[ "${2:-}" =~ ^(status|resolve|deploy)$ ]] || die "usage: prisma.sh <lender-dir> migrate status | resolve --rolled-back|--applied <name> | deploy"
[ "$2" = resolve ] || [ $# -eq 2 ] || die "usage: prisma.sh <lender-dir> migrate status | deploy (no further arguments)"
if [ "$2" = resolve ]; then
  [[ "${3:-}" =~ ^--(rolled-back|applied)$ ]] && [[ "${4:-}" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] && [ $# -eq 4 ] || die "usage: prisma.sh <lender-dir> migrate resolve --rolled-back|--applied <migration-name>"
fi
acquire_lender_lock "$LENDER_DIR"
lcompose up -d db >/dev/null
wait_db
image="$(cat "$STATE_DIR/current-image" 2>/dev/null)" || die "nothing deployed yet ($STATE_DIR/current-image missing)"
tools="$(cat "$STATE_DIR/current-tools-id" 2>/dev/null || tools_image_of "$image")"
tools_run "$tools" -e NODE_ENV=production -- npx prisma "$@"
