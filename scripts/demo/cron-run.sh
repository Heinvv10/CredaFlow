#!/usr/bin/env bash
# Cron entry point for the demo schedules (installed lines:
# scripts/demo/crontab.example):
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
# cron's PATH lacks /usr/local/bin (docker-compose), so it is set here, with
# DEMO_NODE_DIR (the directory holding node and npx, resolved when the crontab
# line is installed; see crontab.example) in front. Output goes to
# $DEMO_DATA_DIR/logs/<job>-<UTC stamp>.log; the newest 14 per job are kept, as
# are the newest 14 of each kind of failed-bake report. The exit status is the
# job's, so cron mail (if any) sees failures.
#
# Failure record: any non-zero exit writes $LOG_DIR/LAST_FAILURE-<job> (time,
# job, exit code, log path); the next success of the SAME job removes only its
# own file, so a failed monthly bake stays flagged until a bake succeeds, even
# though the nightly restores keep succeeding. scripts/demo/status.sh prints
# both. Nothing
# is sent anywhere: no external notification channel is configured.
set -euo pipefail
export PATH="${DEMO_NODE_DIR:+$DEMO_NODE_DIR:}/usr/local/bin:/usr/bin:/bin"
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
    # Another lender's bake may hold the host-wide sim lock: queue behind it.
    cmd=(env DEMO_SIM_LOCK_WAIT=10800 bash -c 'scripts/demo/bake.sh && scripts/demo/restore.sh') ;;
  *) die "$usage" ;;
esac

mkdir -p "$LOG_DIR"
log="$LOG_DIR/$job-$(date -u +%Y%m%dT%H%M%SZ).log"
failure="$LOG_DIR/LAST_FAILURE-$job"
record_failure() {
  printf 'at=%s\njob=%s\nexit=%s\nlog=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$job" "$1" "$log" > "$failure"
}
missing=""
for tool in node npx docker docker-compose jq flock; do
  command -v "$tool" >/dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "cron-run.sh: not on PATH ($PATH):$missing; set DEMO_NODE_DIR (crontab.example)" > "$log"
  echo "exit 127" >> "$log"
  record_failure 127
  exit 127
fi
exec 8>"$CRON_RUN_LOCK"
if ! flock -w 10800 8; then
  echo "cron-run.sh: another demo job held cron-run.lock for 3 h; $job not run" > "$log"
  echo "exit 1" >> "$log"
  record_failure 1
  exit 1
fi
rc=0
# 8>&- : the job's children must not inherit (and so outlive us holding) the lock.
"${cmd[@]}" > "$log" 2>&1 8>&- || rc=$?
echo "exit $rc" >> "$log"
if [ "$rc" -ne 0 ]; then
  record_failure "$rc"
else
  rm -f "$failure"
fi

# Newest 14 job logs, and newest 14 of the reports a failed bake leaves.
for pattern in "$job-*.log" "bake-*-report.txt" "bake-*-pages.txt"; do
  find "$LOG_DIR" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort | head -n -14 \
    | while read -r old; do rm -f "${LOG_DIR:?}/$old"; done
done
exit "$rc"
