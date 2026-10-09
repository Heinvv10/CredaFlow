#!/usr/bin/env bash
#
# Run the opt-in real-DB integration suites against a live PostgreSQL.
#
# WHY THIS EXISTS
#   Almost every *.integration.test.ts is gated behind its own RUN_*_IT env var
#   and defaults to describe.skip. Nothing in `npm test` or CI ran one of them,
#   so a suite could break and stay broken indefinitely while every signal
#   stayed green: a DB-layer rule can look tested when its coverage simply
#   cannot execute. "No coverage" and "dead coverage" are
#   indistinguishable from the outside — this script is what tells them apart.
#
#   "Almost" every: lib/messaging/email-provider-boundary.integration.test.ts
#   has no RUN_*_IT gate and mocks @/lib/prisma. It is a unit test wearing the
#   integration suffix and it already ran under `npm test`. It is swept up here
#   and passes trivially. Do not read its green as real-DB coverage.
#
# THE RATCHET
#   17 of 38 suites failed on the first pass here. Three of those were parallel-
#   execution contamination and pass alone (see --no-file-parallelism below), so
#   14 are recorded in scripts/integration-baseline.txt and excluded from the
#   gate. Everything NOT in the baseline must pass. The baseline may only shrink,
#   and both directions are enforced:
#     - a gated suite that breaks  -> job fails (regression)
#     - a baselined suite that now passes -> job fails, telling you to delete
#       its line, so the baseline can never quietly become permanent
#     - a PR that ADDS a line to the baseline -> job fails, in the
#       "Baseline may only shrink" step of .github/workflows/integration-tests.yml.
#       That check lives in the workflow, not here, because it needs the base
#       branch to diff against and this script must stay runnable locally.
#
# USAGE
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh --baseline-only
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh --check-database-url
#
# WHY --no-file-parallelism
#   Every suite shares ONE database. vitest runs files in parallel by default,
#   and three messaging suites failed only because of that — they pass alone
#   and were wrongly recorded as broken on the first pass here. Run them
#   sequentially or the gate reports contamination as breakage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="${ROOT}/scripts/integration-baseline.txt"
cd "$ROOT"

# The ONE definition of what counts as a baseline entry. Used below to build
# BASE, and exposed as --print-baseline so the "Baseline may only shrink" step
# in .github/workflows/integration-tests.yml can ask THIS script rather than
# carry its own copy. Two copies of a parser drift, and a drifted one there
# would silently disagree about which lines count — precisely the kind of hole
# that step exists to close.
print_baseline() {
  local f="${1:-$BASELINE}"
  if [[ ! -r "$f" ]]; then
    echo "!! baseline not readable: $f" >&2
    return 1
  fi
  # `grep -v` exits 1 when it selects NOTHING, and under `set -o pipefail` that
  # kills any caller that has not guarded it. A register with no entries left is
  # this ratchet's goal state — the PR that pays off the last suite — not an
  # error, so it must exit 0 with empty output. The readability check above is
  # what lets `|| true` stay narrow: with the file known readable, exit 1 can
  # only mean "no entries", never "no such file".
  grep -vE '^\s*(#|$)' "$f" | sed 's|^\./||' | sort -u || true
}

# Deliberately above the DATABASE_URL check: parsing needs no database. Takes an
# optional path so the step can normalise the base revision's file too.
if [[ "${1:-}" == "--print-baseline" ]]; then
  print_baseline "${2:-$BASELINE}"
  exit 0
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "!! DATABASE_URL is required — these suites need a real, fully migrated PostgreSQL." >&2
  echo "!! They must NEVER be pointed at staging or production: they create and" >&2
  echo "!! delete tenants, clients and loans. Use a disposable database." >&2
  exit 1
fi

# Refuse any database that is not on this machine or a docker-compose service
# named `db` or `postgres`. These suites write real rows; a mistyped host would
# corrupt a live ledger. An allow-list, not a pattern: a bare name like
# `prodbox` resolves through search domains, and numeric forms like
# `0x0a000005` resolve to remote addresses. libpq and Prisma also take the host
# from a `host=`/`hostaddr=` query parameter, which overrides the authority,
# so any such parameter is refused — and any percent-encoding in the query,
# which they decode (`%68ost=`). ALLOW_REMOTE_TEST_DB=1 is the explicit
# override for a disposable database elsewhere.
# Tested by scripts/__tests__/run-integration-tests-db-host.test.ts.
database_host() {
  local rest="${1#*://}"
  [[ "$rest" == "$1" ]] && return 1          # no scheme: not a URL
  rest="${rest%%[/?#]*}"                     # authority only
  rest="${rest##*@}"                         # drop userinfo (last @ wins)
  if [[ "$rest" == \[* ]]; then
    printf '%s\n' "${rest%%]*}]"             # [ipv6]
  else
    printf '%s\n' "${rest%%:*}"
  fi
}
if [[ "${ALLOW_REMOTE_TEST_DB:-}" != "1" ]]; then
  DB_HOST="$(database_host "$DATABASE_URL" || true)"
  QUERY=""
  [[ "$DATABASE_URL" == *\?* ]] && QUERY="${DATABASE_URL#*\?}"
  if [[ "${QUERY,,}" =~ (^|[\&\;])(host|hostaddr)= || "$QUERY" == *%* ]] \
    || ! [[ "$DB_HOST" =~ ^(localhost|127\.0\.0\.1|\[::1\]|db|postgres)$ ]]; then
    echo "!! DATABASE_URL host '${DB_HOST:-?}' is not this machine or a docker service (db, postgres)," >&2
    echo "!! or its query sets host=/hostaddr=. Refusing." >&2
    echo "!! Set ALLOW_REMOTE_TEST_DB=1 only for a disposable database you own." >&2
    exit 1
  fi
fi

if [[ "${1:-}" == "--check-database-url" ]]; then
  echo ">> DATABASE_URL host accepted"
  exit 0
fi

mapfile -t ALL < <(find . -name '*.integration.test.ts' -not -path './node_modules/*' \
  -not -path './.claude/*' -not -path './.worktrees/*' | sed 's|^\./||' | sort)

if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "!! Found no *.integration.test.ts files. Refusing: a gate that finds" >&2
  echo "!! nothing to run reports success while testing nothing." >&2
  exit 1
fi

mapfile -t BASE < <(print_baseline "$BASELINE" 2>/dev/null || true)

# A baseline naming a file that no longer exists is stale, and would silently
# shrink the gate. Fail rather than skip.
STALE=()
for b in "${BASE[@]:-}"; do
  [[ -z "$b" ]] && continue
  [[ -f "$b" ]] || STALE+=("$b")
done
if [[ ${#STALE[@]} -gt 0 ]]; then
  echo "!! integration-baseline.txt names files that do not exist:" >&2
  printf '!!   %s\n' "${STALE[@]}" >&2
  echo "!! Remove them — a stale baseline entry hides a real suite." >&2
  exit 1
fi

GATED=(); SKIPPED=()
for f in "${ALL[@]}"; do
  if printf '%s\n' "${BASE[@]:-}" | grep -qxF "$f"; then SKIPPED+=("$f"); else GATED+=("$f"); fi
done

# Every suite opts in through its own variable; enable them all.
while read -r v; do [[ -n "$v" ]] && export "$v=1"; done < <(
  grep -rho 'RUN_[A-Z0-9_]*_IT' --include='*.integration.test.ts' . 2>/dev/null | sort -u
)

echo ">> ${#ALL[@]} integration suites: ${#GATED[@]} gated, ${#SKIPPED[@]} baselined"

if [[ "${1:-}" != "--baseline-only" ]]; then
  # The same refusal as the empty-ALL check above, for the same reason. Under
  # `set -u`, an empty array still expands to ZERO words, so `npx vitest run
  # --no-file-parallelism "${GATED[@]}"` would degrade to a bare `npx vitest
  # run`, fall back to vitest's default glob, execute the ~485-file UNIT suite,
  # pass, and print "integration gate OK" having run no integration suite at
  # all. Reachable whenever every discovered suite is baselined.
  if [[ ${#GATED[@]} -eq 0 ]]; then
    echo "!! Every discovered suite is baselined — nothing is gated." >&2
    echo "!! Refusing: with no file arguments vitest runs the unit suite instead" >&2
    echo "!! and this job would report success while testing nothing." >&2
    exit 1
  fi
  echo ">> running gated suites (these MUST pass)"
  npx vitest run --no-file-parallelism "${GATED[@]}"
fi

# Ratchet: anything baselined that now passes must leave the baseline, or the
# list ossifies and stops meaning "known broken".
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo ">> re-checking ${#SKIPPED[@]} baselined suites (expected to fail)"
  FIXED=()
  for f in "${SKIPPED[@]}"; do
    if npx vitest run "$f" >/dev/null 2>&1; then FIXED+=("$f"); fi
  done
  if [[ ${#FIXED[@]} -gt 0 ]]; then
    echo "!! These baselined suites now PASS. Delete their lines from" >&2
    echo "!! scripts/integration-baseline.txt so they are gated from now on:" >&2
    printf '!!   %s\n' "${FIXED[@]}" >&2
    exit 1
  fi
  echo ">> baseline still accurate — none of them pass yet"
fi

echo ">> integration gate OK"
