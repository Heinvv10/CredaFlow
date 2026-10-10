#!/usr/bin/env bash
# One-screen health of the demo schedules: latest snapshot (age, image), the
# image the live demo runs, the last bake and restore results, LAST_FAILURE.
#
#   scripts/demo/status.sh
#
# Exits 1 when something needs attention: a LAST_FAILURE, no snapshot, a
# snapshot older than 35 days (the monthly bake missed), or a snapshot baked
# on another image than live runs (every nightly restore then refuses).
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"

attention=0
flag() { echo "  !! $*"; attention=1; }

echo "demo data: $DEMO_DATA_DIR"
snap_image=""
if [ -e "$SNAP_DIR/latest/meta.json" ]; then
  stamp="$(jq -r .stamp "$SNAP_DIR/latest/meta.json")"
  snap_image="$(jq -r .image "$SNAP_DIR/latest/meta.json")"
  finished="$(jq -r .finishedAt "$SNAP_DIR/latest/meta.json")"
  age_days="$(( ($(date +%s) - $(date -d "$finished" +%s)) / 86400 ))"
  echo "latest snapshot: $stamp (finished $finished, ${age_days} d ago; window $(jq -r '.simWindow | "\(.start) → \(.until)"' "$SNAP_DIR/latest/meta.json"))"
  echo "  baked on:  $snap_image"
  [ "$age_days" -le 35 ] || flag "snapshot is older than 35 days: the monthly bake has not succeeded"
else
  flag "no snapshot ($SNAP_DIR/latest)"
fi

if live="$(docker inspect -f '{{.Config.Image}}' "$LIVE_APP" 2>/dev/null)"; then
  echo "  live runs: $live ($LIVE_APP $(docker inspect -f '{{.State.Status}}' "$LIVE_APP"))"
  if [ -n "$snap_image" ] && [ "$snap_image" != "$live" ]; then
    flag "image mismatch: restore.sh refuses this snapshot until a bake on $live succeeds"
  fi
else
  flag "$LIVE_APP not found"
fi

for job in bake restore; do
  if [ -s "$LOG_DIR/last-$job" ]; then
    echo "last $job: $(cat "$LOG_DIR/last-$job")"
  else
    echo "last $job: (no record in $LOG_DIR/last-$job)"
  fi
  newest="$(find "$LOG_DIR" -maxdepth 1 -name "$job-*.log" -printf '%f\n' 2>/dev/null | sort | tail -1)"
  [ -z "$newest" ] || echo "  newest cron log: $newest ($(tail -1 "$LOG_DIR/$newest"))"
done

if [ -s "$LOG_DIR/LAST_FAILURE" ]; then
  flag "LAST_FAILURE ($LOG_DIR/LAST_FAILURE):"
  sed 's/^/       /' "$LOG_DIR/LAST_FAILURE"
else
  echo "LAST_FAILURE: none"
fi
exit "$attention"
