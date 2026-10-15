#!/usr/bin/env bash
# Encrypt a lender's existing uploads at rest (scripts/encrypt-uploads.ts), from
# the tools image of the deployed image, on the lender's uploads volume.
#
#   encrypt-uploads.sh <lender-dir> [--dry-run | --verify]
#
# Order: UPLOADS_ENC_KEY in .env (provision-lender.sh adds it), redeploy so the
# app reads and writes with it, THEN run this. It refuses while the running app
# does not carry the same key, since files it converts would be unreadable to
# the app. Idempotent; --dry-run counts, --verify checks every encrypted file
# opens with the key. Take a backup first (backup.sh).
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}"; mode="${2:-}"
case "$mode" in "" | --dry-run | --verify) ;; *) die "usage: encrypt-uploads.sh <lender-dir> [--dry-run | --verify]" ;; esac
[ $# -le 2 ] || die "usage: encrypt-uploads.sh <lender-dir> [--dry-run | --verify]"
need docker
load_lender "$dir"
acquire_lender_lock "$LENDER_DIR"
key="$(env_get "$ENV_FILE" UPLOADS_ENC_KEY)"
[ -n "$key" ] || die "UPLOADS_ENC_KEY is not set in $ENV_FILE (rerun provision-lender.sh to add it, then redeploy)"
image="$(cat "$STATE_DIR/current-image" 2>/dev/null)" || die "nothing deployed yet ($STATE_DIR/current-image missing)"
tools="$(cat "$STATE_DIR/current-tools-id" 2>/dev/null || tools_image_of "$image")"

if [ "$mode" != --verify ]; then
  running="$(lcompose ps -q app)"
  [ -n "$running" ] || die "the app is not running: deploy it with UPLOADS_ENC_KEY first"
  live="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$running" | sed -n 's/^UPLOADS_ENC_KEY=//p')"
  [ "$live" = "$key" ] || die "the running app does not carry this UPLOADS_ENC_KEY: redeploy (deploy.sh) before converting files"
fi

ro=""; [ "$mode" = "" ] || ro=":ro"
UPLOADS_ENC_KEY="$key" docker run --rm -e UPLOADS_ENC_KEY -v "$(uploads_volume):/app/uploads$ro" "$tools" \
  npx tsx scripts/encrypt-uploads-cli.ts --dir /app/uploads ${mode:+"$mode"}
