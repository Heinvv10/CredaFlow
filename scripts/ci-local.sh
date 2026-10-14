#!/usr/bin/env bash
# Run CredaFlow's GitHub gates locally before spending hosted-runner minutes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
[[ $# -gt 0 ]] && shift
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: bash scripts/ci-local.sh quick [test paths...]
       bash scripts/ci-local.sh quality
       bash scripts/ci-local.sh integration
       bash scripts/ci-local.sh full

quick        Generate Prisma, typecheck, lint, and run the doc/date gates.
             Optional test paths are passed to Vitest.
quality      Run the complete GitHub quality job locally.
integration Start disposable PostgreSQL 16, migrate it, and run every DB suite.
full         Run quality and integration in order.
EOF
}

if [[ ! "$MODE" =~ ^(quick|quality|integration|full)$ ]]; then
  usage >&2
  exit 2
fi

export TZ=UTC
export PUPPETEER_SKIP_DOWNLOAD=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

run_quick() {
  echo ">> Generate Prisma client"
  npx prisma generate
  echo ">> Typecheck"
  npx tsc --noEmit
  echo ">> Typecheck demo simulator"
  npm run demo:typecheck
  echo ">> Lint"
  npm run lint
  echo ">> Agent-doc gates"
  npm run claude-md:check
  npm run agents:check
  echo ">> Date gates"
  npm run dates:check
  npm run test:tz
  if [[ $# -gt 0 ]]; then
    echo ">> Targeted tests"
    npx vitest run "$@"
  fi
}

require_pdf_tools() {
  local missing=()
  local tool
  for tool in pdftoppm pdfinfo qpdf; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "!! Missing PDF tools: ${missing[*]}" >&2
    echo "!! On Debian/Ubuntu: sudo apt-get install poppler-utils qpdf" >&2
    exit 1
  fi
}

run_quality() {
  run_quick
  require_pdf_tools
  echo ">> Unit tests"
  npx vitest run
  echo ">> Face models"
  npm run face-models:fetch
  FACE_MODEL_TESTS=1 npx vitest run lib/kyc/face-model/compare.models.test.ts
  echo ">> Production build"
  npm run build
}

CI_CONTAINER=""
cleanup() {
  if [[ -n "$CI_CONTAINER" ]]; then
    echo ">> Remove disposable PostgreSQL container $CI_CONTAINER"
    docker rm -fv "$CI_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_integration() {
  command -v docker >/dev/null 2>&1 || {
    echo "!! docker is required for the local integration gate" >&2
    exit 1
  }
  command -v pdftotext >/dev/null 2>&1 || {
    echo "!! pdftotext is required (Debian/Ubuntu: sudo apt-get install poppler-utils)" >&2
    exit 1
  }

  CI_CONTAINER="credaflow-ci-${BASHPID}"
  echo ">> Start disposable PostgreSQL 16 container $CI_CONTAINER"
  docker run -d --name "$CI_CONTAINER" \
    -e POSTGRES_PASSWORD=it \
    -p 127.0.0.1::5432 \
    postgres:16-alpine >/dev/null

  local ready=0
  local attempt
  for attempt in {1..30}; do
    if docker exec "$CI_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != "1" ]]; then
    echo "!! PostgreSQL did not become ready" >&2
    exit 1
  fi

  local port_line port
  port_line="$(docker port "$CI_CONTAINER" 5432/tcp)"
  port="${port_line##*:}"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "!! Could not resolve the disposable PostgreSQL port: $port_line" >&2
    exit 1
  fi

  (
    export DATABASE_URL="postgresql://postgres:it@127.0.0.1:${port}/postgres"
    echo ">> Apply migrations"
    npx prisma migrate deploy
    echo ">> Generate Prisma client"
    npx prisma generate
    echo ">> Integration gate"
    bash scripts/run-integration-tests.sh
  )

  cleanup
  CI_CONTAINER=""
}

case "$MODE" in
  quick) run_quick "$@" ;;
  quality) run_quality ;;
  integration) run_integration ;;
  full)
    run_quality
    run_integration
    ;;
esac
