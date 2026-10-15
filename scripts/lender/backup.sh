#!/usr/bin/env bash
# Encrypted backup of one lender: its database and its uploads volume.
#
#   backup.sh <lender-dir> [--label NAME] [--keep N]
#
# Writes <lender-dir>/backups/<slug>-<UTC>[-label].dump.gpg: a pg_dump custom
# format file (-Fc) piped straight into gpg (AES256, symmetric, passphrase in
# secrets/backup.passphrase). Nothing unencrypted touches the disk. A sidecar
# <file>.counts records row counts so restore.sh can verify a restore.
# Beside it, <file>.uploads.tar.gpg is a tar of the uploads volume (the
# ClientDocument files, themselves encrypted at rest when UPLOADS_ENC_KEY is
# set) encrypted the same way, and <file>.files records its file count
# (`files=none` when the stack has no uploads volume yet). The database is
# dumped first, then the files: a document written in between is in the tar but
# not the dump (harmless); one deleted in between is missing from both.
# Restoring the uploads also needs UPLOADS_ENC_KEY from .env: copy it off the
# host with the passphrase.
# Afterwards the newest N backups are kept in each pool, pre-* (taken before
# a migration or restore) and the rest (default BACKUP_KEEP in .env, else 14),
# and older ones deleted. gpg is used because age is not assumed installed.
#
# Cron (not installed by these scripts), nightly 01:30 server time:
#   30 1 * * * /path/to/CredaFlow/scripts/lender/backup.sh /path/to/lender-dir >> /path/to/lender-dir/backups/cron.log 2>&1
set -euo pipefail
# shellcheck source=scripts/lender/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

label="" keep=""
dir="${1:-}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label="${2:?--label needs a value}"; shift 2 ;;
    --keep) keep="${2:?--keep needs a value}"; shift 2 ;;
    *) die "usage: backup.sh <lender-dir> [--label NAME] [--keep N]" ;;
  esac
done
[[ -z "$label" || "$label" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "label must be 1-40 chars of [A-Za-z0-9._-]"
need docker gpg
load_lender "$dir"
acquire_lender_lock "$LENDER_DIR"
[ -n "$keep" ] || keep="$(env_get "$ENV_FILE" BACKUP_KEEP)"; keep="${keep:-14}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive integer"
pass="$LENDER_DIR/secrets/backup.passphrase"
[ -s "$pass" ] || die "$pass missing or empty (provision-lender.sh creates it)"

umask 077
mkdir -p "$LENDER_DIR/backups"
# One file per second per label: if this second's name is taken (a deploy retried at once), use the next free second's stamp.
for n in 0 1 2 3 4 5; do
  stamp="$(date -u -d "now + $n seconds" +%Y%m%dT%H%M%SZ)"
  out="$LENDER_DIR/backups/$SLUG-$stamp${label:+-$label}.dump.gpg"
  [ ! -e "$out" ] && [ ! -e "$LENDER_DIR/backups/$SLUG-$stamp-unresolved${label:+-$label}.dump.gpg" ] && break
done
[ ! -e "$out" ] || die "$out already exists"

trap 'rm -f "$out.partial" "$out.counts.partial" "$out.uploads.partial"' EXIT

# The dump and the row counts come from ONE exported snapshot (lib.sh,
# SNAPSHOT_DUMP_SH), so the sidecar matches the dump exactly even under writes.
counts_file="/tmp/lender-counts-$$-$RANDOM"
lcompose exec -T -e "U=$PGUSER" -e "DB=$PGDB" -e "COUNTS_SQL=$COUNTS_SQL" -e "COUNTS_FILE=$counts_file" -e "MIG_UNFINISHED_WHERE=$MIG_UNFINISHED_WHERE" db sh -c "$SNAPSHOT_DUMP_SH" \
  | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$pass" -o "$out.partial"
[ -s "$out.partial" ] || die "backup is empty"
lcompose exec -T db sh -c 'cat "$1"; rm -f "$1"' sh "$counts_file" > "$out.counts.partial"
[ -s "$out.counts.partial" ] || die "no row counts came back from the snapshot session"
unfinished="$(lcompose exec -T db sh -c 'cat "$1.mig"; rm -f "$1.mig"' sh "$counts_file")"
[[ "$unfinished" == mig_unfinished=* ]] || die "the snapshot session did not report the migration table state"
# A failed migration that is not yet resolved does NOT stop the backup: the old app keeps
# taking writes during exactly that incident, and a gap in backups would be worse. The
# dump is kept under a distinct name (-unresolved), flagged by a .unresolved sidecar,
# announced loudly, and restore.sh refuses it unless --allow-unresolved-migration.
unresolved="${unfinished#mig_unfinished=}"

# The dump must be readable end to end before it counts as a backup.
gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$out.partial" \
  | lcompose exec -T db pg_restore --list > /dev/null || die "backup failed its read-back check; discarded"

# The uploads volume, read-only through a throwaway container of the database
# image (present on every lender host, and it has tar). Same encryption and the
# same read-back rule as the dump; the file count goes into the .files sidecar.
vol="$(uploads_volume)"
files=none
if docker volume inspect "$vol" >/dev/null 2>&1; then
  docker run --rm -v "$vol:/u:ro" "$UPLOADS_HELPER_IMAGE" tar -cf - -C /u . \
    | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$pass" -o "$out.uploads.partial"
  listing="$(gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$out.uploads.partial" | tar -tf -)" \
    || die "uploads archive failed its read-back check; discarded"
  files="$(grep -vc '/$' <<<"$listing" || true)"
else
  note "no uploads volume ($vol) yet: database only"
fi

final="$out"
[ -z "$unresolved" ] || final="$LENDER_DIR/backups/$SLUG-$stamp-unresolved${label:+-$label}.dump.gpg"
mv "$out.partial" "$final"; mv "$out.counts.partial" "$final.counts"
[ "$files" = none ] || mv "$out.uploads.partial" "$final.uploads.tar.gpg"
printf 'files=%s\n' "$files" > "$final.files"
out="$final"
note "uploads: $files file(s)"
note "backup written: $out ($(stat -c %s "$out") bytes)"
if [ -n "$unresolved" ]; then
  printf '%s\n' "$unresolved" > "$out.unresolved"
  note "WARNING ======================================================================"
  note "WARNING: this backup was taken while migration(s) are FAILED AND UNRESOLVED:"
  note "WARNING:   $unresolved"
  note "WARNING: it is kept (a gap in backups during an incident is worse) under the name"
  note "WARNING: $(basename "$out"), and restore.sh refuses it unless given"
  note "WARNING: --allow-unresolved-migration. Resolve the migration (docs/DEPLOY.md, 'A failed"
  note "WARNING: migration'); the last backup NOT marked unresolved is the clean restore point."
  note "WARNING ======================================================================"
fi

# Retention: the newest $keep dumps in EACH pool (pre-*, unresolved, the rest), so a run of
# nightly backups can never push out the pre-migration ones, and a long incident's
# unresolved dumps can never push out the last clean nightlies, nor the reverse. Only files whose
# whole name matches the exact pattern we write are ever considered (so an odd
# filename, even one holding a newline, can neither be listed wrongly nor make rm
# reach outside backups/); names sort by UTC stamp. NUL-delimited throughout.
prune_pool() {
  local f b n=0 pool
  while IFS= read -r -d '' f; do
    b="${f##*/}"
    [[ "$b" =~ ^$SLUG-[0-9]{8}T[0-9]{6}Z(-[A-Za-z0-9._-]+)?\.dump\.gpg$ ]] || continue
    if [[ "$b" =~ ^$SLUG-[0-9]{8}T[0-9]{6}Z-pre- ]]; then pool=pre
    elif [[ "$b" =~ ^$SLUG-[0-9]{8}T[0-9]{6}Z-unresolved ]]; then pool=unresolved
    else pool=nightly; fi
    [ "$pool" = "$1" ] || continue
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    note "retention: removing $b"
    rm -f -- "$LENDER_DIR/backups/$b" "$LENDER_DIR/backups/$b.counts" "$LENDER_DIR/backups/$b.unresolved" \
      "$LENDER_DIR/backups/$b.uploads.tar.gpg" "$LENDER_DIR/backups/$b.files"
  done < <(find "$LENDER_DIR/backups" -maxdepth 1 -type f -name '*.dump.gpg' -print0 | sort -z -r)
}
prune_pool pre
prune_pool unresolved
prune_pool nightly
echo "$out"
