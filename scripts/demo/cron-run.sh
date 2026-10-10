#!/usr/bin/env bash
# Cron entry point for the demo schedules (crontab of user hein):
#
#   cron-run.sh restore                 nightly 02:30: restore.sh latest
#   cron-run.sh bake [--first-sunday]   monthly: bake.sh, then restore.sh of the
#                                       new latest
#
# --first-sunday exits 0 at once (no log) unless today is a Sunday in days 1-7:
# cron ORs day-of-month with day-of-week, so "first Sunday" is the cron line
# `0 2 1-7 * *` plus this check.
#
# Jobs run one at a time under $DEMO_DATA_DIR/cron-run.lock, waiting up to 3 h
# for it: the 02:30 restore queues behind a 02:00 bake (whose own restore has
# then already run; restoring the same snapshot again costs seconds) rather
# than restoring the live stack mid-bake.
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

usage="usage: cron-run.sh restore | bake [--first-sunday]"
job="${1:-}"
case "$job" in
  restore) [ $# -eq 1 ] || die "$usage"; cmd=(scripts/demo/restore.sh) ;;
  bake)
    case "${2:-}" in
      "") ;;
      --first-sunday) [ "$(date +%u)" = 7 ] && [ "$(date +%-d)" -le 7 ] || exit 0 ;;
      *) die "$usage" ;;
    esac
    [ $# -le 2 ] || die "$usage"
    cmd=(bash -c 'scripts/demo/bake.sh && scripts/demo/restore.sh') ;;
  *) die "$usage" ;;
esac

mkdir -p "$LOG_DIR"
log="$LOG_DIR/$job-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 8>"$DEMO_DATA_DIR/cron-run.lock"
if ! flock -w 10800 8; then
  echo "cron-run.sh: another demo job held cron-run.lock for 3 h; $job not run" > "$log"
  echo "exit 1" >> "$log"
  exit 1
fi
rc=0
# 8>&- : the job's children must not inherit (and so outlive us holding) the lock.
"${cmd[@]}" > "$log" 2>&1 8>&- || rc=$?
echo "exit $rc" >> "$log"

# Newest 14 job logs, and newest 14 of the reports a failed bake leaves.
for pattern in "$job-*.log" "bake-*-report.txt" "bake-*-pages.txt"; do
  find "$LOG_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort | head -n -14 \
    | while read -r old; do rm -f "${LOG_DIR:?}/$old"; done
done
exit "$rc"
