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
#   Suites known to fail are recorded in scripts/integration-baseline.txt and
#   excluded from the gate. Everything NOT in the baseline must pass. The baseline may only shrink,
#   and both directions are enforced:
#     - a gated suite that breaks  -> job fails (regression)
#     - a baselined suite that now passes -> job fails, telling you to delete
#       its line, so the baseline can never quietly become permanent
#     - a PR that ADDS a line to the baseline -> job fails, in the
#       "Baseline may only shrink" step of .github/workflows/quality-gate.yml.
#       That check lives in the workflow, not here, because it needs the base
#       branch to diff against and this script must stay runnable locally.
#
# USAGE
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh --baseline-only
#   DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh --check-database-url
#   IT_SHARD=2/3 DATABASE_URL=postgresql://... bash scripts/run-integration-tests.sh
#
# WHY --no-file-parallelism
#   Every suite shares ONE database. vitest runs files in parallel by default,
#   and suites that pass alone then fail on each other's rows. Run them
#   sequentially or the gate reports contamination as breakage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="${ROOT}/scripts/integration-baseline.txt"
cd "$ROOT"

# The ONE definition of what counts as a baseline entry. Used below to build
# BASE, and exposed as --print-baseline so the "Baseline may only shrink" step
# in .github/workflows/quality-gate.yml can ask THIS script rather than
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

# Same-machine guard. Many sessions share this host and start throwaway
# containers with one password; when a session's `docker run -p` loses the port
# race and its script carries on, it migrates and tests ANOTHER session's
# database. scripts/it-db.sh starts a container on a free port and exports
# IT_CONTAINER; the container must really own the URL's port (the check lives in
# `it-db.sh check`, which the recipe also runs before `prisma migrate deploy`).
# IT_CONTAINER unset on a local host is refused, except under CI=true (GitHub
# Actions service container) or with REQUIRE_IT_CONTAINER=0 (explicit opt-out).
# Compose hosts (`db`, `postgres`) are not checked.
# Tested by scripts/__tests__/run-integration-tests-container-guard.test.ts.
GUARD_HOST="$(database_host "$DATABASE_URL" || true)"
if [[ "$GUARD_HOST" =~ ^(localhost|127\.0\.0\.1|\[::1\])$ ]]; then
  if [[ -n "${IT_CONTAINER:-}" ]]; then
    bash "$ROOT/scripts/it-db.sh" check
  elif [[ "${CI:-}" == "true" || "${REQUIRE_IT_CONTAINER:-}" == "0" ]]; then
    echo ">> note: IT_CONTAINER unset; local DATABASE_URL not verified as yours (CI=true or REQUIRE_IT_CONTAINER=0)" >&2
  else
    echo "!! DATABASE_URL is local but IT_CONTAINER is unset, so nothing proves this database" >&2
    echo "!! is yours; another session may own that port. Refusing. Use:" >&2
    echo "!!   eval \"\$(bash scripts/it-db.sh up cf-it-<unique>)\"" >&2
    echo "!! (CI=true or REQUIRE_IT_CONTAINER=0 opts out.)" >&2
    exit 1
  fi
fi

if [[ "${1:-}" == "--check-database-url" ]]; then
  echo ">> DATABASE_URL host accepted"
  exit 0
fi

# Opt-in suites: gated behind a RUN_*_IT variable that this runner deliberately does NOT
# export, because running them is not a database check and is too heavy for this job
# (the lender build-context test builds the real Docker images and runs out of memory
# here). They are removed from the gated set and LISTED below, so they are never
# silently dropped: run one by hand with its own variable (named in the file's header).
OPT_IN_VARS=(RUN_DOCKER_BUILD_IT)

mapfile -t FOUND < <(find . -name '*.integration.test.ts' -not -path './node_modules/*' \
  -not -path './.claude/*' -not -path './.worktrees/*' -not -path './.next/*' | sed 's|^\./||' | sort)
ALL=(); OPT_IN_FILES=()
for f in "${FOUND[@]:-}"; do
  [[ -z "$f" ]] && continue
  skip=""
  for v in "${OPT_IN_VARS[@]}"; do grep -q "\b$v\b" "$f" && skip="$v"; done
  if [[ -n "$skip" ]]; then OPT_IN_FILES+=("$f  ($skip=1)"); else ALL+=("$f"); fi
done

# Lists the opt-in suites and stops (used by the test of this runner; needs the same DATABASE_URL rule as a run).
if [[ "${1:-}" == "--print-opt-in" ]]; then
  printf '%s\n' "${OPT_IN_FILES[@]:-}" | sed '/^$/d'
  exit 0
fi

if [[ ${#ALL[@]} -eq 0 ]]; then
  echo "!! Found no *.integration.test.ts files. Refusing: a gate that finds" >&2
  echo "!! nothing to run reports success while testing nothing." >&2
  exit 1
fi

# IT_SHARD=i/n keeps only shard i of n, so CI can run the serial suite as n
# parallel jobs, each against its own database. Applied to ALL, before the
# baseline split, so each shard gates and re-checks only its own files and the
# baseline and opt-in rules above and below are unchanged. Assignment is greedy
# by weight (scripts/integration-weights.txt, DEFAULT_WEIGHT when unlisted),
# heaviest first, ties broken by path: deterministic, and every discovered file
# lands in exactly one shard, listed or not.
# Tested by scripts/__tests__/run-integration-tests-shard.test.ts.
WEIGHTS="${ROOT}/scripts/integration-weights.txt"
DEFAULT_WEIGHT=3
assign_shards() {
  awk 'NR == FNR { if ($0 !~ /^[[:space:]]*(#|$)/) w[$2] = $1; next }
       { printf "%s\t%s\n", (($0 in w) ? w[$0] : def), $0 }' def="$DEFAULT_WEIGHT" "$WEIGHTS" - \
    | LC_ALL=C sort -t$'\t' -k1,1nr -k2,2 \
    | awk -F'\t' -v n="$1" '{ best = 1; for (i = 2; i <= n; i++) if (load[i] < load[best]) best = i
                             load[best] += $1; print best "\t" $2 }'
}
SHARD_LABEL=""
if [[ -n "${IT_SHARD:-}" ]]; then
  if ! [[ "$IT_SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
    echo "!! IT_SHARD must be i/n with 1 <= i <= n (got '$IT_SHARD')" >&2
    exit 2
  fi
  SHARD_I="${BASH_REMATCH[1]}"; SHARD_N="${BASH_REMATCH[2]}"
  if [[ ! -r "$WEIGHTS" ]]; then
    echo "!! shard weights not readable: $WEIGHTS" >&2
    exit 1
  fi
  mapfile -t ALL < <(printf '%s\n' "${ALL[@]}" | assign_shards "$SHARD_N" \
    | awk -F'\t' -v i="$SHARD_I" '$1 == i { print $2 }' | LC_ALL=C sort)
  # An empty shard (more shards than suites, or a broken weights file) would
  # pass while testing nothing. Refuse it, like the empty-ALL check above.
  if [[ ${#ALL[@]} -eq 0 ]]; then
    echo "!! shard ${IT_SHARD} selected no suites. Refusing: it would pass while testing nothing." >&2
    exit 1
  fi
  SHARD_LABEL=" (shard ${IT_SHARD})"
fi

# Lists the selected files, after opt-in removal and sharding, and stops (used by the test of this runner).
if [[ "${1:-}" == "--print-selected" ]]; then
  printf '%s\n' "${ALL[@]:-}" | sed '/^$/d'
  exit 0
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
  if printf '%s\n' "${BASE[@]:-}" | grep -xF "$f" >/dev/null; then SKIPPED+=("$f"); else GATED+=("$f"); fi
done

# Every suite opts in through its own variable; enable them all, except the opt-in ones.
EXPORT_VARS=()
while read -r v; do
  [[ -z "$v" ]] && continue
  # shellcheck disable=SC2076  # literal match against the opt-in list
  [[ " ${OPT_IN_VARS[*]} " =~ " $v " ]] && continue
  EXPORT_VARS+=("$v")
done < <(
  grep -rho 'RUN_[A-Z0-9_]*_IT' --include='*.integration.test.ts' . 2>/dev/null | sort -u
)
if [[ "${1:-}" == "--print-exports" ]]; then printf '%s\n' "${EXPORT_VARS[@]:-}" | sed '/^$/d'; exit 0; fi
for v in "${EXPORT_VARS[@]:-}"; do [[ -n "$v" ]] && export "$v=1"; done
# The RLS query hook (lib/tenant-rls.ts) is off by default in the app; every
# suite runs with it on, so the batch-transaction path is exercised everywhere.
export TENANT_RLS="${TENANT_RLS:-on}"
# One worker, whatever the environment says. vitest reads VITEST_MAX_WORKERS
# (and VITEST_MAX_THREADS) from the environment and they override
# --no-file-parallelism: a shell that exports VITEST_MAX_WORKERS=4 (velo-server's
# do) runs four suites at once on the one database, and they deadlock on each
# other's test DDL and see each other's rows. Measured 2026-10-22: three files
# that sleep 2 s each started within 6 ms of each other with it set, one after
# the other with it at 1. Tested by scripts/__tests__/run-integration-tests-serial.test.ts.
export VITEST_MAX_WORKERS=1
unset VITEST_MAX_THREADS

echo ">> ${#ALL[@]} integration suites${SHARD_LABEL}: ${#GATED[@]} gated, ${#SKIPPED[@]} baselined, ${#OPT_IN_FILES[@]} opt-in (not run here)"
for f in "${OPT_IN_FILES[@]:-}"; do [[ -n "$f" ]] && echo ">>   opt-in, NOT run by this gate: $f"; done

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
