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
# Uploads: the backup's <file>.uploads.tar.gpg is decrypted and listed, and its
# file count compared with the <file>.files sidecar (same rule as the row
# counts). A backup made before uploads were backed up has no sidecar: noted.
#
# --over-live (needs --confirm <slug>, the lender's own slug) then: takes a
# `pre-restore` backup of the live database and uploads, stops the app,
# unpacks the uploads into <volume>/.restore-<UTC>, checks the count there, moves
# the current files into <volume>/.pre-restore-<UTC> and the restored ones into
# place, renames the live database to <db>_pre_restore_<UTC> and the verified
# scratch one to <db>, starts the app and health-checks it. The old database
# and the old files are KEPT; to undo, stop the app and swap them back.
# Dropping them is a manual decision.
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${1:-}" file="${2:-}"; shift 2 || true
over_live=false confirm="" drop=false accept_drift=false allow_unresolved=false
while [ $# -gt 0 ]; do
  case "$1" in
    --over-live) over_live=true; shift ;;
    --confirm) confirm="${2:?--confirm needs the lender slug}"; shift 2 ;;
    --drop-scratch) drop=true; shift ;;
    --accept-count-drift) accept_drift=true; shift ;;
    --allow-unresolved-migration) allow_unresolved=true; shift ;;
    *) die "usage: restore.sh <lender-dir> <backup.dump.gpg> [--drop-scratch | --over-live --confirm <slug> [--accept-count-drift]] [--allow-unresolved-migration]" ;;
  esac
done
[ -n "$file" ] || die "usage: restore.sh <lender-dir> <backup.dump.gpg> [--drop-scratch | --over-live --confirm <slug> [--accept-count-drift]] [--allow-unresolved-migration]"
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

# A backup taken while a migration was failed and unresolved (backup.sh marks it) is the
# state of an incident, not a clean restore point: restoring it is a decision, not a default.
if [[ "${file##*/}" == *-unresolved* || -e "$file.unresolved" ]] && ! $allow_unresolved; then
  die "refusing: $(basename "$file") was taken while migration(s) were failed and unresolved ($(cat "$file.unresolved" 2>/dev/null || echo see its name)). Restore the last clean backup instead, or pass --allow-unresolved-migration."
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

mig="$(psql_db "$scratch" "$MIG_STATE_SQL")" \
  || fail "could not read _prisma_migrations in the restored database; scratch database dropped"
read -r unfinished total <<<"$mig"
if $allow_unresolved; then
  [ "${total:-0}" -gt 0 ] || fail "migration table check failed (no migrations); scratch database dropped"
  [ "${unfinished:-0}" -eq 0 ] || note "WARNING: --allow-unresolved-migration: ${unfinished} migration(s) in this dump are failed and unresolved"
else
  [ "${total:-0}" -gt 0 ] && [ "${unfinished:-1}" -eq 0 ] || fail "migration table check failed (total=${total:-?} unfinished=${unfinished:-?}); scratch database dropped"
fi

restored="$(psql_db "$scratch" "$COUNTS_SQL")" || fail "could not count rows in the restored database; scratch database dropped"
echo "restored row counts in $scratch:" >&2; sed 's/^/  /' <<<"$restored" >&2
drift=""
if [ -f "$file.counts" ]; then
  if drift="$(count_drift "$file.counts" "$restored")"; then
    note "counts match the backup's sidecar; migrations: $total applied, ${unfinished:-0} unfinished"
  else
    # The sidecar is taken from the dump's own snapshot, so drift means an edited or
    # swapped sidecar, or a different file: loud, naming the tables, never silent.
    note "WARNING: restored row counts DIFFER from the backup's recorded counts in:"
    sed 's/^/  /' <<<"$drift" >&2
  fi
else
  note "WARNING: no $file.counts sidecar; counts not compared (migrations: $total applied, ${unfinished:-0} unfinished)"
  drift="no sidecar: row counts were not compared"
fi
# The uploads archive: read back end to end and counted against its sidecar.
archive="$file.uploads.tar.gpg"
want_files="$(sed -n 's/^files=//p' "$file.files" 2>/dev/null | head -n1)"
have_files=""
if [ -z "$want_files" ]; then
  note "WARNING: no $(basename "$file").files sidecar: this backup predates uploads backups; uploads are not restored"
  drift="${drift:+$drift$'\n'}no uploads sidecar"
elif [ "$want_files" = none ]; then
  note "the backup records no uploads volume (files=none): uploads are not restored"
else
  [ -f "$archive" ] || fail "the backup records $want_files uploaded file(s) but $(basename "$archive") is missing; scratch database dropped"
  listing="$(gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$archive" | tar -tf -)" \
    || fail "uploads archive $(basename "$archive") failed to decrypt or list; scratch database dropped"
  have_files="$(grep -vc '/$' <<<"$listing" || true)"
  if [ "$have_files" = "$want_files" ]; then
    note "uploads archive holds $have_files file(s), as recorded"
  else
    note "WARNING: uploads archive holds $have_files file(s); the backup recorded $want_files"
    drift="${drift:+$drift$'\n'}uploads: backup=$want_files archive=$have_files"
  fi
fi

if [ -n "$drift" ] && $over_live && ! $accept_drift; then
  fail "refusing --over-live: the row or file counts could not be confirmed ($(head -n1 <<<"$drift")). If that is expected, rerun with --accept-count-drift; scratch database dropped"
fi

if ! $over_live; then
  verdict="VERIFIED"; [ -z "$drift" ] || verdict="VERIFIED WITH WARNINGS (counts not confirmed, see above)"
  if $drop; then drop_scratch; note "$verdict; scratch database $scratch dropped"
  else keep_scratch=true; note "$verdict; scratch database $scratch left for inspection (drop it with DROP DATABASE \"$scratch\", or pass --drop-scratch next time)"; fi
  exit 0
fi

note "--over-live: safety backup of the current database first"
"$LENDER_SCRIPTS/backup.sh" "$LENDER_DIR" --label pre-restore >/dev/null
lcompose stop app app-portal >/dev/null
if [ -n "$have_files" ]; then
  # Unpacked beside the live files and counted before anything moves: a bad
  # archive leaves the volume as it was (and the app is started again).
  if ! restored_files="$(gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$archive" \
      | docker run --rm -i -e "TS=$ts" -e "EXPECT=$have_files" -v "$(uploads_volume):/u" "$UPLOADS_HELPER_IMAGE" sh -c "$RESTORE_UPLOADS_SH")"; then
    lcompose up -d --no-deps app app-portal >/dev/null
    fail "uploads could not be restored; the live files and database are unchanged and the app is started again"
  fi
  note "uploads restored ($restored_files file(s)); previous files kept in volume directory .pre-restore-$ts"
fi
psql_db postgres "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname IN ('$PGDB','$scratch') AND pid <> pg_backend_pid()" >/dev/null
psql_db postgres "ALTER DATABASE \"$PGDB\" RENAME TO \"$old\"; ALTER DATABASE \"$scratch\" RENAME TO \"$PGDB\"" >/dev/null
lcompose up -d --no-deps app app-portal >/dev/null
if wait_stack_health "" 120; then
  note "RESTORED over live. Previous database kept as \"$old\" (undo: stop app; rename it back)."
else
  die "app unhealthy after restore; previous database kept as \"$old\" (stop app, ALTER DATABASE \"$PGDB\" RENAME TO …; ALTER DATABASE \"$old\" RENAME TO \"$PGDB\")"
fi
