#!/usr/bin/env bash
# Encrypted pg_dump of one lender's database.
#
#   backup.sh <lender-dir> [--label NAME] [--keep N]
#
# Writes <lender-dir>/backups/<slug>-<UTC>[-label].dump.gpg: a pg_dump custom
# format file (-Fc) piped straight into gpg (AES256, symmetric, passphrase in
# secrets/backup.passphrase). Nothing unencrypted touches the disk. A sidecar
# <file>.counts records row counts so restore.sh can verify a restore.
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
  out="$LENDER_DIR/backups/$SLUG-$(date -u -d "now + $n seconds" +%Y%m%dT%H%M%SZ)${label:+-$label}.dump.gpg"
  [ ! -e "$out" ] && break
done
[ ! -e "$out" ] || die "$out already exists"

trap 'rm -f "$out.partial" "$out.counts.partial"' EXIT

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
[ -z "${unfinished#mig_unfinished=}" ] || die "refusing to keep this backup: migration(s) ${unfinished#mig_unfinished=} are unfinished (failed, not resolved), so restore.sh would reject it. Resolve them first (docs/DEPLOY.md, 'A failed migration'); a backup taken BEFORE the failed migration is the one to restore."

# The dump must be readable end to end before it counts as a backup.
gpg --batch --quiet --pinentry-mode loopback --decrypt --passphrase-file "$pass" "$out.partial" \
  | lcompose exec -T db pg_restore --list > /dev/null || die "backup failed its read-back check; discarded"

mv "$out.partial" "$out"; mv "$out.counts.partial" "$out.counts"
note "backup written: $out ($(stat -c %s "$out") bytes)"

# Retention: the newest $keep dumps in EACH pool, so a run of nightly backups can
# never push out the pre-migration (pre-*) ones, nor the reverse. Only files whose
# whole name matches the exact pattern we write are ever considered (so an odd
# filename, even one holding a newline, can neither be listed wrongly nor make rm
# reach outside backups/); names sort by UTC stamp. NUL-delimited throughout.
prune_pool() {
  local f b n=0
  while IFS= read -r -d '' f; do
    b="${f##*/}"
    [[ "$b" =~ ^$SLUG-[0-9]{8}T[0-9]{6}Z(-[A-Za-z0-9._-]+)?\.dump\.gpg$ ]] || continue
    if [[ "$b" =~ ^$SLUG-[0-9]{8}T[0-9]{6}Z-pre- ]]; then [ "$1" = pre ] || continue; else [ "$1" = nightly ] || continue; fi
    n=$((n + 1))
    [ "$n" -gt "$keep" ] || continue
    note "retention: removing $b"
    rm -f -- "$LENDER_DIR/backups/$b" "$LENDER_DIR/backups/$b.counts"
  done < <(find "$LENDER_DIR/backups" -maxdepth 1 -type f -name '*.dump.gpg' -print0 | sort -z -r)
}
prune_pool pre
prune_pool nightly
echo "$out"
