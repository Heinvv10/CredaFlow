#!/usr/bin/env bash
# Cron entry point for the demo schedules (crontab of user hein):
#
#   cron-run.sh restore   nightly: restore.sh latest
#   cron-run.sh bake      weekly: bake.sh, then restore.sh of the new latest
#
# cron's PATH lacks /usr/local/bin (docker-compose), so it is set here. Output
# goes to $DEMO_DATA_DIR/logs/<job>-<UTC stamp>.log; the newest 14 per job are
# kept, as are the newest 14 of each kind of failed-bake report. The exit
# status is the job's, so cron mail (if any) sees failures.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"
cd "$DEMO_ROOT"

job="${1:-}"
case "$job" in
  restore) cmd=(scripts/demo/restore.sh) ;;
  bake) cmd=(bash -c 'scripts/demo/bake.sh && scripts/demo/restore.sh') ;;
  *) die "usage: cron-run.sh restore|bake" ;;
esac

mkdir -p "$LOG_DIR"
log="$LOG_DIR/$job-$(date -u +%Y%m%dT%H%M%SZ).log"
rc=0
"${cmd[@]}" > "$log" 2>&1 || rc=$?
echo "exit $rc" >> "$log"

# Newest 14 job logs, and newest 14 of the reports a failed bake leaves.
for pattern in "$job-*.log" "bake-*-report.txt" "bake-*-pages.txt"; do
  find "$LOG_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort | head -n -14 \
    | while read -r old; do rm -f "${LOG_DIR:?}/$old"; done
done
exit "$rc"
