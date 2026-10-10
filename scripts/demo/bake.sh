#!/usr/bin/env bash
# Bakes a demo snapshot on the sim stack and files it under
# $DEMO_DATA_DIR/snapshots/<UTC timestamp>/.
#
#   scripts/demo/bake.sh [--image credaflow:demo-…] [--start YYYY-MM-DD]
#
#   --image  product image to bake on; default: the image the live demo's
#            staff container runs, so restore.sh accepts the result.
#   --start  first simulated day; default: the 1st of the month six months
#            back, so the window stays 6–7 months as the weeks pass.
#
# Steps: rebuild the sim image on --image → fresh-stack.sh (DESTROYS the sim
# volumes) → simulate.ts to today → check-dates → ledger invariant →
# verify-pages → pg_dump -Fc + uploads tarball + meta.json → `latest` symlink
# → keep the newest 4 snapshots. A snapshot is written only when every check
# passed; any failure exits non-zero and leaves `latest` where it was.
#
# Takes ~35 min. Do not sign in to the sim stack while it runs (sim/README.md).
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"
cd "$DEMO_ROOT"

image="" start=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="${2:?--image needs a value}"; shift 2 ;;
    --start) start="${2:?--start needs a value}"; shift 2 ;;
    *) die "usage: bake.sh [--image <tag>] [--start YYYY-MM-DD]" ;;
  esac
done
[ -n "$image" ] || image="$(live_image)"
[ -n "$start" ] || start="$(date -d "$(date +%Y-%m-01) -6 months" +%F)"
docker image inspect "$image" >/dev/null 2>&1 || die "image $image not found"

mkdir -p "$SNAP_DIR"
exec 9>"$DEMO_DATA_DIR/bake.lock"
flock -n 9 || die "another bake is running"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$SNAP_DIR/.partial-$stamp"
rm -rf "$SNAP_DIR"/.partial-*
(umask 077; mkdir "$work")
# On failure keep the two reports (never the credentials) next to the logs,
# and record the failure for status.sh.
keep_reports() {
  local rc=$? f
  for f in simulate-report.txt verify-pages.txt; do
    [ -e "$work/$f" ] && { mkdir -p "$LOG_DIR"; cp "$work/$f" "$LOG_DIR/bake-$stamp-$f"; }
  done
  rm -rf "$work"
  record_result bake "failed (exit $rc) bake $stamp from $start on $image; latest unchanged"
}
trap keep_reports EXIT

# The sim migrates and seeds from this worktree's prisma/, so it must carry
# exactly the migrations baked into the image the snapshot will run on.
image_migrations="$(docker run --rm --entrypoint ls "$image" /app/prisma/migrations | LC_ALL=C sort)"
[ "$image_migrations" = "$(find prisma/migrations -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)" ] \
  || die "prisma/migrations in this worktree differ from $image's; rebuild the image (build-image.sh) or bake on a matching one"

ensure_shared_secrets
export SIM_BASE_IMAGE="$image"
note "sim image on $image"
sim_compose build app >&2

note "fresh sim stack from $start"
scripts/demo/sim/fresh-stack.sh "${start}T07:30:00+02:00"

note "simulate $start → today (report: $work/simulate-report.txt)"
npx tsx scripts/demo/simulate.ts --start "$start" > "$work/simulate-report.txt" \
  || { tail -40 "$work/simulate-report.txt" >&2; die "simulate.ts failed"; }

sim_end="$(npx tsx scripts/demo/sim/clock.ts now)"
note "check-dates [$start, $sim_end]"
npx tsx scripts/demo/sim/check-dates.ts --start "${start}T00:00:00+02:00" --end "$sim_end"

note "ledger invariant"
sim_sql 'SELECT assert_payment_allocation_reconciles()' >/dev/null

note "verify-pages"
npx tsx scripts/demo/sim/verify-pages.ts > "$work/verify-pages.txt" \
  || { grep -v '^200 ok' "$work/verify-pages.txt" >&2 || true; die "verify-pages failed"; }

note "snapshot"
docker exec "$SIM_DB" \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' > "$work/db.dump"
docker exec "$SIM_APP" tar -czf - -C /app/uploads . > "$work/uploads.tar.gz"
upload_files="$(tar -tzf "$work/uploads.tar.gz" | grep -vc '/$' || true)"
# The seed's TOTP secrets are fresh per bake: these are the staff logins that
# work on the live demo after this snapshot is restored.
cp scripts/demo/.sim-credentials.txt scripts/demo/.sim-staff.json scripts/demo/.sim-breadth-staff.json "$work/"

tenant_id="$(sim_sql "SELECT id FROM \"Tenant\" WHERE slug = 'acme'")"
[ -n "$tenant_id" ] || die "no acme tenant in the sim database"
counts="$(sim_sql "$SNAPSHOT_COUNTS_SQL")"

jq -n \
  --arg stamp "$stamp" --arg startedAt "$started_at" --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg image "$image" --arg imageId "$(docker image inspect -f '{{.Id}}' "$image")" \
  --arg simImageId "$(docker image inspect -f '{{.Id}}' "$SIM_IMAGE")" \
  --arg worktreeTag "$(worktree_tag)" \
  --arg simStart "$(jq -r .start scripts/demo/.sim-state.json)" \
  --arg simUntil "$(jq -r .until scripts/demo/.sim-state.json)" \
  --arg simClockEnd "$sim_end" --arg tenantId "$tenant_id" \
  --argjson counts "$counts" --argjson uploadFiles "$upload_files" \
  '{stamp: $stamp, startedAt: $startedAt, finishedAt: $finishedAt,
    image: $image, imageId: $imageId, simImageId: $simImageId, worktreeTag: $worktreeTag,
    simWindow: {start: $simStart, until: $simUntil, clockEnd: $simClockEnd},
    tenantSlug: "acme", tenantId: $tenantId, counts: ($counts + {uploadFiles: $uploadFiles}),
    checks: {simulate: "passed", checkDates: "passed", ledgerInvariant: "passed", verifyPages: "passed"}}' \
  > "$work/meta.json"

mv "$work" "$SNAP_DIR/$stamp"
trap - EXIT
ln -sfn "$stamp" "$SNAP_DIR/latest"
record_result bake "ok $stamp from $start on $image"

# Keep the newest 4 (timestamp names sort chronologically).
find "$SNAP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -printf '%f\n' | sort | head -n -4 \
  | while read -r old; do rm -rf "${SNAP_DIR:?}/$old"; note "pruned $old"; done

note "baked $SNAP_DIR/$stamp ($(du -sh "$SNAP_DIR/$stamp" | cut -f1))"
jq -c '{image, simWindow, tenantId, counts, checks}' "$SNAP_DIR/$stamp/meta.json"
