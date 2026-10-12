#!/usr/bin/env bash
# One-screen health of the demo schedules: latest snapshot (age, image), the
# image the live demo runs, the runner's commit, the last bake and restore
# results, LAST_FAILURE.
#
#   scripts/demo/status.sh
#
# Exits 1 when something needs attention: a LAST_FAILURE, no snapshot, a
# snapshot older than 35 days (the monthly bake missed), or a snapshot baked
# on another image than live runs (every nightly restore then refuses), a
# runner that is dirty, missing, unrecorded or not at the commit
# update-runner.sh recorded, or databases and upload copies an earlier restore
# left behind.
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

# Leftovers of earlier restores. restore.sh drops only its own run's old
# database and upload copy, and keeps earlier ones for manual recovery.
if old_dbs="$(live_sql postgres "SELECT string_agg(datname, ' ' ORDER BY datname) FROM pg_database WHERE datname ~ '_old_[0-9]+\$'" 2>/dev/null)"; then
  [ -z "$old_dbs" ] || flag "leftover databases from earlier restores: $old_dbs"
else
  flag "could not list the databases in $LIVE_DB"
fi
if uploads="$(docker exec "$LIVE_APP" ls -A /app/uploads 2>/dev/null)"; then
  old_uploads="$(printf '%s\n' "$uploads" | grep '^\.old-' | paste -sd' ' || true)"
  [ -z "$old_uploads" ] || flag "leftover upload copies from earlier restores in $LIVE_APP:/app/uploads: $old_uploads"
else
  flag "could not list $LIVE_APP:/app/uploads"
fi

if git -C "$DEMO_RUNNER_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "runner: $DEMO_RUNNER_DIR at $(git -C "$DEMO_RUNNER_DIR" log -1 --format='%h %s')"
  if [ -s "$RUNNER_STATE" ]; then
    echo "  last update: $(jq -r '"\(.commit[0:7]) at \(.updatedAt) (from \(.previous[0:7]))"' "$RUNNER_STATE")"
    [ "$(jq -r .commit "$RUNNER_STATE")" = "$(git -C "$DEMO_RUNNER_DIR" rev-parse HEAD)" ] \
      || flag "the runner is not at the commit update-runner.sh last recorded"
  else
    flag "the runner has no update record ($RUNNER_STATE): move it with update-runner.sh"
  fi
  [ -z "$(git -C "$DEMO_RUNNER_DIR" status --porcelain)" ] || flag "the runner has uncommitted or untracked changes"
elif [ -s "$RUNNER_STATE" ]; then
  flag "runner $DEMO_RUNNER_DIR not found (update-runner.sh recorded $(jq -r .commit "$RUNNER_STATE"))"
else
  echo "runner: none at $DEMO_RUNNER_DIR"
fi

for job in bake restore; do
  if [ -s "$LOG_DIR/last-$job" ]; then
    echo "last $job: $(cat "$LOG_DIR/last-$job")"
  else
    echo "last $job: (no record in $LOG_DIR/last-$job)"
  fi
  newest="$(find "$LOG_DIR" -maxdepth 1 -name "$job-*.log" -printf '%f\n' 2>/dev/null | sort | tail -1 || true)"
  [ -z "$newest" ] || echo "  newest cron log: $newest ($(tail -1 "$LOG_DIR/$newest"))"
done

any_failure=false
for job in bake restore; do
  if [ -s "$LOG_DIR/LAST_FAILURE-$job" ]; then
    any_failure=true
    flag "LAST_FAILURE-$job ($LOG_DIR/LAST_FAILURE-$job):"
    sed 's/^/       /' "$LOG_DIR/LAST_FAILURE-$job"
  fi
done
$any_failure || echo "LAST_FAILURE: none"
exit "$attention"
