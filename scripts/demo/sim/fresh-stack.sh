#!/usr/bin/env bash
# DESTROYS and rebuilds the demo-SIM stack's data (project credaflow-demo-sim
# only: its db volume and uploads volume), then brings it up migrated and
# base-seeded with the clock at $1.
#
#   scripts/demo/sim/fresh-stack.sh 2026-04-01T07:30:00+02:00
#
# Steps beyond the README's manual bring-up:
#   - the uploads volume is created root-owned (the image has no /app/uploads),
#     so it is chowned to the app user or every document upload 500s;
#   - the seed runs under the fake clock (seed-faked.sh);
#   - DEBIT_MANDATE_CREDITOR_TENANT_ID is rewritten to the new "acme" tenant id
#     and the app recreated, or every debit mandate is refused (503);
#   - the secrets shared with the live demo ($DEMO_DATA_DIR/secrets.env, see
#     ensure_shared_secrets in scripts/demo/lib.sh) are created when absent:
#     WABA_ENC_KEY (the product refuses to store an SMTP password unencrypted,
#     and the simulator points Settings → Email at the sim's SMTP sink),
#     ADMIN_SECRET (the CRM and bureau-submission modules can only be switched
#     on by a platform operator, /api/admin/tenants — breadth/setup.ts) and
#     NEXTAUTH_SECRET (the FAIS disclosure token is signed with it; without it
#     every standalone insurance sale fails at the disclosure, 500);
#   - the SMTP sink is stopped first, or compose cannot remove the network.
set -euo pipefail

START="${1:?usage: fresh-stack.sh <ISO start instant>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker-compose -f docker-compose.demo-sim.yml --env-file .env.demo-sim)
HOST_DB="$(node -e 'console.log(require("node:util").parseEnv(require("fs").readFileSync(".env.demo-sim","utf8")).SIM_HOST_DATABASE_URL)')"

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' credaflow-demo-sim-app)" = healthy ] && return 0
    sleep 2
  done
  echo "fresh-stack: app did not become healthy" >&2
  return 1
}

# shellcheck source=scripts/demo/lib.sh
. scripts/demo/lib.sh
ensure_shared_secrets

scripts/demo/sim/smtp-sink.sh down
"${COMPOSE[@]}" down -v >&2
npx tsx scripts/demo/sim/clock.ts set "$START" --no-wait
"${COMPOSE[@]}" up -d >&2
docker exec -u root credaflow-demo-sim-app chown nextjs:nodejs /app/uploads

DATABASE_URL="$HOST_DB" NODE_ENV= npx prisma migrate deploy >&2
(umask 077; scripts/demo/sim/seed-faked.sh > scripts/demo/.sim-credentials.txt)

TENANT_ID="$(psql "${HOST_DB%%\?*}" -At -c "SELECT id FROM \"Tenant\" WHERE slug = 'acme'")"
[ -n "$TENANT_ID" ] || { echo "fresh-stack: no acme tenant after seeding" >&2; exit 1; }
sed -i "s/^DEBIT_MANDATE_CREDITOR_TENANT_ID=.*/DEBIT_MANDATE_CREDITOR_TENANT_ID=$TENANT_ID/" .env.demo-sim
"${COMPOSE[@]}" up -d app >&2
wait_healthy
echo "fresh-stack: up at $(npx tsx scripts/demo/sim/clock.ts now), tenant acme=$TENANT_ID" >&2
