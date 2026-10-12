#!/usr/bin/env bash
# Moves the demo runner — the clean, detached checkout the demo's cron jobs run
# from ($DEMO_RUNNER_DIR) — to a named commit, on purpose and only then.
#
#   scripts/demo/update-runner.sh <commit>
#
# Refuses when the runner has uncommitted or untracked changes (gitignored
# files, such as .env.demo-sim and scripts/demo/.sim-*, are fine), while a bake,
# restore or cron-run lock is held, or when <commit> is not reachable from a
# local branch. The three locks stay held until the update is done, so no job
# starts on a half-installed tree. After `git checkout --detach`: npm ci
# --legacy-peer-deps only when package-lock.json differs between the old and
# the new commit, then npx prisma generate, then npm run face-models:fetch when
# the new commit has that script. $RUNNER_STATE (status.sh) records the commit
# only once every step succeeded.
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: update-runner.sh <commit>"
runner="$DEMO_RUNNER_DIR"
top="$(git -C "$runner" rev-parse --show-toplevel 2>/dev/null)" && [ "$top" = "$(cd "$runner" && pwd -P)" ] \
  || die "$runner is not the top of a git checkout (DEMO_RUNNER_DIR)"

mkdir -p "$DEMO_DATA_DIR"
exec 7>"$BAKE_LOCK" 8>"$RESTORE_LOCK" 9>"$CRON_RUN_LOCK"
flock -n 7 || die "a bake is running ($BAKE_LOCK)"
flock -n 8 || die "a restore is running ($RESTORE_LOCK)"
flock -n 9 || die "a cron job is running or queued ($CRON_RUN_LOCK)"

[ -z "$(git -C "$runner" status --porcelain)" ] \
  || die "$runner has uncommitted or untracked changes; it must stay a clean checkout"

new="$(git -C "$runner" rev-parse --verify --quiet "$1^{commit}")" || die "no commit $1"
[ -n "$(git -C "$runner" for-each-ref --contains "$new" refs/heads)" ] \
  || die "$new is not reachable from any local branch"
old="$(git -C "$runner" rev-parse HEAD)"

note "runner $runner: $old → $new"
git -C "$runner" checkout --quiet --detach "$new"
cd "$runner"
if git diff --quiet "$old" "$new" -- package-lock.json; then
  note "package-lock.json unchanged; npm ci skipped"
else
  npm ci --legacy-peer-deps
fi
npx prisma generate
if node -e 'process.exit(require("./package.json").scripts?.["face-models:fetch"] ? 0 : 1)'; then
  npm run face-models:fetch
fi

jq -n --arg commit "$new" --arg previous "$old" --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{commit: $commit, previous: $previous, updatedAt: $updatedAt}' > "$RUNNER_STATE.tmp"
mv "$RUNNER_STATE.tmp" "$RUNNER_STATE"
note "runner at $(git log -1 --format='%h %s' "$new")"
