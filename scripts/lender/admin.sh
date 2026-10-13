#!/usr/bin/env bash
# Run the first-admin CLI against a lender's database, from the tools image of
# the image currently deployed. Used for break-glass recovery of a locked-out
# SUPER_ADMIN; provision-lender.sh runs the same CLI for the very first one.
#
#   admin.sh <lender-dir> --email <email> [--break-glass] [--dry-run] [--name <name>]
#
# Prints the one-time password and TOTP secret to this terminal once. Do not
# redirect the output into a log. Audit rows record the host operator (user@host).
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}"; shift || true
need docker
load_lender "$dir"
image="$(cat "$STATE_DIR/current-image" 2>/dev/null)" || die "nothing deployed yet ($STATE_DIR/current-image missing)"
tools_run "$(tools_image_of "$image")" -e NODE_ENV=production -- \
  npx tsx scripts/lender/bootstrap-admin-cli.ts --tenant "$SLUG" "$@"
