#!/usr/bin/env bash
# Restore an encrypted backup (backup.sh) into a NEW scratch database and
# verify it. The live database is never touched unless --over-live is given.
#
#   restore.sh <lender-dir> <backup.dump.gpg> [--drop-scratch]
#   restore.sh <lender-dir> <backup.dump.gpg> --over-live --confirm <slug> [--accept-count-drift]
#
# Verification (any failure exits non-zero and drops the scratch database):
#   - pg_restore finishes with --exit-on-error;
#   - _prisma_migrations has rows and none unfinished;
#   - the row counts are compared with the sidecar backup.sh wrote from the dump's
#     own snapshot. A difference is a loud WARNING naming the tables, never a
#     block on a scratch restore; --over-live refuses it unless --accept-count-drift.
# A verified scratch database <db>_restore_<UTC> is left in place (inspect it,
# then DROP DATABASE) unless --drop-scratch is given.
#
# --over-live (needs --confirm <slug>, the lender's own slug) then: takes a
# `pre-restore` backup of the live database, stops the app, renames the live
# database to <db>_pre_restore_<UTC> and the verified scratch one to <db>,
# starts the app and health-checks it. The old database is KEPT; to undo, stop
# the app and swap the two names back. Dropping it is a manual decision.
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}" file="${2:-}"; shift 2 || true
over_live=false confirm="" drop=false accept_drift=false
while [ $# -gt 0 ]; do
  case "$1" in
    --over-live) over_live=true; shift ;;
    --confirm) confirm="${2:?--confirm needs the lender slug}"; shift 2 ;;
    --drop-scratch) drop=true; shift ;;
    --accept-count-drift) accept_drift=true; shift ;;
    *) die "usage: restore.sh <lender-dir> <backup.dump.gpg> [--drop-scratch | --over-live --confirm <slug> [--accept-count-drift]]" ;;
  esac
done
[ -n "$file" ] || die "usage: restore.sh <lender-dir> <backup.dump.gpg> [--drop-scratch | --over-live --confirm <slug> [--accept-count-drift]]"
need docker gpg
load_lender "$dir"
acquire_lender_lock "$LENDER_DIR"
[ -f "$file" ] || die "backup $file not found"
file="$(readlink -f "$file")"
pass="$LENDER_DIR/secrets/backup.passphrase"
[ -s "$pass" ] || die "$pass missing or empty"
if $over_live; then
  check_rendered_config
  [ "$confirm" = "$SLUG" ] || die "refusing --over-live: pass --confirm $SLUG to replace the live database of '$SLUG'"
elif [ -n "$confirm" ] || $accept_drift; then
  die "--confirm and --accept-count-drift only apply to --over-live"
fi

ts="$(date -u +%Y%m%d%H%M%S)"
scratch="${PGDB}_restore_$ts" old="${PGDB}_pre_restore_$ts"
[[ "$scratch" =~ ^[a-z_][a-z0-9_]{0,60}$ ]] || die "unexpected database name '$scratch'"
[ "$scratch" != "$PGDB" ] || die "internal error: scratch database equals the live database"
lcompose up -d db >/dev/null; wait_db

drop_scratch() { psql_db postgres "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null; }
# Whatever makes this script stop before the scratch database is verified (a failed
# query under set -e, a failed restore, a drift refusal) drops it: no half-restored leftovers.
keep_scratch=false
cleanup() { $keep_scratch || drop_scratch >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { die "$*"; }

note "restoring $(basename "$file") into new database $scratch"
psql_db postgres "CREATE DATABASE \"$scratch\"" >/dev/null
gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$file" \
  | lcompose exec -T db pg_restore --no-owner --exit-on-error -U "$PGUSER" -d "$scratch" || fail "pg_restore failed; scratch database dropped"

mig="$(psql_db "$scratch" "SELECT count(*) FILTER (WHERE finished_at IS NULL) || ' ' || count(*) FROM _prisma_migrations")" \
  || fail "could not read _prisma_migrations in the restored database; scratch database dropped"
read -r unfinished total <<<"$mig"
[ "${total:-0}" -gt 0 ] && [ "${unfinished:-1}" -eq 0 ] || fail "migration table check failed (total=${total:-?} unfinished=${unfinished:-?}); scratch database dropped"

restored="$(psql_db "$scratch" "$COUNTS_SQL")" || fail "could not count rows in the restored database; scratch database dropped"
echo "restored row counts in $scratch:" >&2; sed 's/^/  /' <<<"$restored" >&2
drift=""
if [ -f "$file.counts" ]; then
  if drift="$(count_drift "$file.counts" "$restored")"; then
    note "counts match the backup's sidecar; migrations: $total applied, 0 unfinished"
  else
    # The sidecar is taken from the dump's own snapshot, so drift means an edited or
    # swapped sidecar, or a different file: loud, naming the tables, never silent.
    note "WARNING: restored row counts DIFFER from the backup's recorded counts in:"
    sed 's/^/  /' <<<"$drift" >&2
  fi
else
  note "WARNING: no $file.counts sidecar; counts not compared (migrations: $total applied, 0 unfinished)"
fi
if [ -n "$drift" ] && $over_live && ! $accept_drift; then
  fail "refusing --over-live: the restored counts differ from the backup's (tables above). If that is expected, rerun with --accept-count-drift; scratch database dropped"
fi

if ! $over_live; then
  verdict="VERIFIED"; [ -z "$drift" ] || verdict="VERIFIED WITH WARNINGS (count drift above)"
  if $drop; then drop_scratch; note "$verdict; scratch database $scratch dropped"
  else keep_scratch=true; note "$verdict; scratch database $scratch left for inspection (drop it with DROP DATABASE \"$scratch\", or pass --drop-scratch next time)"; fi
  exit 0
fi

note "--over-live: safety backup of the current database first"
"$LENDER_SCRIPTS/backup.sh" "$LENDER_DIR" --label pre-restore >/dev/null
lcompose stop app app-portal >/dev/null
psql_db postgres "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname IN ('$PGDB','$scratch') AND pid <> pg_backend_pid()" >/dev/null
psql_db postgres "ALTER DATABASE \"$PGDB\" RENAME TO \"$old\"; ALTER DATABASE \"$scratch\" RENAME TO \"$PGDB\"" >/dev/null
lcompose up -d --no-deps app app-portal >/dev/null
if wait_stack_health "" 120; then
  note "RESTORED over live. Previous database kept as \"$old\" (undo: stop app; rename it back)."
else
  die "app unhealthy after restore; previous database kept as \"$old\" (stop app, ALTER DATABASE \"$PGDB\" RENAME TO …; ALTER DATABASE \"$old\" RENAME TO \"$PGDB\")"
fi
