#!/bin/sh
# Entrypoint wrapper for the demo-sim stack (docker-compose.demo-sim.yml).
# Preloads libfaketime so the wrapped process reads its wall clock from
# $FAKETIME_TIMESTAMP_FILE, then execs the image's own entrypoint.
#
# Refuses to start without the library or the clock file: libfaketime with a
# missing file silently falls back to the real clock, and a simulation that
# quietly runs on today's date is worse than one that does not start.
set -eu

: "${FAKETIME_LIB:?FAKETIME_LIB must name the libfaketime .so for this image}"
: "${FAKETIME_TIMESTAMP_FILE:?FAKETIME_TIMESTAMP_FILE must name the shared clock file}"

if [ ! -f "$FAKETIME_LIB" ]; then
  echo "faketime-entrypoint: $FAKETIME_LIB not found; image lacks libfaketime" >&2
  exit 1
fi
if [ ! -s "$FAKETIME_TIMESTAMP_FILE" ]; then
  echo "faketime-entrypoint: clock file $FAKETIME_TIMESTAMP_FILE missing or empty; run scripts/demo/sim/clock.ts first" >&2
  exit 1
fi

# Prefer the thread-safe build (libfaketimeMT) shipped beside the named one.
# The plain build re-reads the clock file into unsynchronised state on every
# call (FAKETIME_NO_CACHE), and Prisma's query engine stamps @default(now())
# from several threads at once: in T3, one of three NotificationLog rows
# inserted together carried the REAL date while its siblings (and its own
# cuid, generated the same instant) carried the faked one.
MT_LIB="$(dirname "$FAKETIME_LIB")/libfaketimeMT.so.1"
[ -f "$MT_LIB" ] && FAKETIME_LIB="$MT_LIB"

export LD_PRELOAD="$FAKETIME_LIB"
exec "$@"
