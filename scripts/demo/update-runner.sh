#!/usr/bin/env bash
# Moves the demo runner — the clean, detached checkout the demo's cron jobs run
# from ($DEMO_RUNNER_DIR) — to a named commit, on purpose and only then.
#
#   scripts/demo/update-runner.sh <commit>
#
# Run it from another checkout: bash reads a script while it runs, so it
# refuses to update the tree it is read from. Refuses when the runner has
# uncommitted or untracked changes (gitignored files, such as .env.demo-sim and
# scripts/demo/.sim-*, are fine), while a bake, restore or cron-run lock is
# held, or when <commit> is not reachable from a local branch. The three locks
# stay held until the update is done, so no job starts on a half-installed tree.
#
# After `git checkout --detach`: npm ci --legacy-peer-deps unless node_modules
# was installed from this exact package-lock.json (a sha256 marker that npm ci
# itself removes, written only after it succeeded), then npx prisma generate,
# then npm run face-models:fetch when the commit has that script. If any of
# them fails, the runner is checked out at the previous commit again and that
# commit's install is redone the same way; the update then exits 1. $RUNNER_STATE
# (status.sh) records the commit only once every step succeeded.
set -euo pipefail
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: update-runner.sh <commit>"
case "$1" in -*) die "the commit must not start with \"-\": $1" ;; esac
runner="$DEMO_RUNNER_DIR"
top="$(git -C "$runner" rev-parse --show-toplevel 2>/dev/null)" && [ "$top" = "$(cd "$runner" && pwd -P)" ] \
  || die "$runner is not the top of a git checkout (DEMO_RUNNER_DIR)"
[ "$top" != "$(cd "$DEMO_ROOT" && pwd -P)" ] \
  || die "$runner is the checkout this script runs from; run update-runner.sh from another checkout"

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

INSTALL_MARKER=node_modules/.update-runner-lockfile.sha256
lockfile_hash() { sha256sum package-lock.json | cut -d' ' -f1; }

# install — the checked-out commit's dependencies, client and models. Every
# step ends in `|| return`: it runs as an `if` condition, where errexit is off.
install() {
  if [ "$(cat "$INSTALL_MARKER" 2>/dev/null)" = "$(lockfile_hash)" ]; then
    note "node_modules matches package-lock.json; npm ci skipped"
  else
    rm -f "$INSTALL_MARKER"
    npm ci --legacy-peer-deps || return
    mkdir -p node_modules && lockfile_hash > "$INSTALL_MARKER" || return
  fi
  npx prisma generate || return
  # lib/registry/generated/ is not committed, and postinstall only ran if npm ci did.
  if node -e 'process.exit(require("./package.json").scripts?.["gen:registries"] ? 0 : 1)'; then
    npm run --silent gen:registries || return
  fi
  if node -e 'process.exit(require("./package.json").scripts?.["face-models:fetch"] ? 0 : 1)'; then
    npm run face-models:fetch || return
  fi
}

note "runner $runner: $old → $new"
git -C "$runner" checkout --quiet --detach "$new"
cd "$runner"
if ! install; then
  note "update to $new failed; checking the runner out at $old again"
  git checkout --quiet --detach "$old" && install \
    || die "ROLLBACK FAILED: the runner is at $(git rev-parse --short HEAD) with an unverified install; fix it before the next cron job"
  die "update to $new failed; the runner is back at $old"
fi

jq -n --arg commit "$new" --arg previous "$old" --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{commit: $commit, previous: $previous, updatedAt: $updatedAt}' > "$RUNNER_STATE.tmp"
mv "$RUNNER_STATE.tmp" "$RUNNER_STATE"
note "runner at $(git log -1 --format='%h %s' "$new")"
