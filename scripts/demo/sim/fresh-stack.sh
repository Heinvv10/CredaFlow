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
#   - the SMTP sink is stopped first, or compose cannot remove the network;
#   - every compose call is pinned to the sim project (-p, sim_compose in
#     lib.sh) and SIM_HOST_DATABASE_URL must be the sim db's port.
set -euo pipefail

START="${1:?usage: fresh-stack.sh <ISO start instant>}"
# shellcheck source=scripts/demo/lib.sh
. "$(dirname "$0")/../lib.sh"
cd "$DEMO_ROOT"
HOST_DB="$(env_get .env.demo-sim SIM_HOST_DATABASE_URL)"

# migrate deploy runs from the host against HOST_DB: refuse anything but the
# sim db's own published port, so a stray URL cannot migrate another database.
# The URL (it carries the password) goes through the environment, not argv.
# shellcheck disable=SC2016  # the template literal is JavaScript, not shell
host_port="$(HOST_DB="$HOST_DB" node -e 'const u = new URL(process.env.HOST_DB); process.stdout.write(`${u.hostname}:${u.port}`)' 2>/dev/null || true)"
[ "$host_port" = "$SIM_DB_HOST_PORT" ] \
  || die "SIM_HOST_DATABASE_URL in .env.demo-sim points at '${host_port:-unparseable}', not the sim db ($SIM_DB_HOST_PORT)"

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$SIM_APP")" = healthy ] && return 0
    sleep 2
  done
  echo "fresh-stack: app did not become healthy" >&2
  return 1
}

ensure_shared_secrets

scripts/demo/sim/smtp-sink.sh down
sim_compose down -v >&2
npx tsx scripts/demo/sim/clock.ts set "$START" --no-wait
sim_compose up -d >&2
docker exec -u root "$SIM_APP" chown nextjs:nodejs /app/uploads

DATABASE_URL="$HOST_DB" NODE_ENV='' npx prisma migrate deploy >&2
(umask 077; scripts/demo/sim/seed-faked.sh > scripts/demo/.sim-credentials.txt)

TENANT_ID="$(sim_sql "SELECT id FROM \"Tenant\" WHERE slug = 'acme'")"
[ -n "$TENANT_ID" ] || { echo "fresh-stack: no acme tenant after seeding" >&2; exit 1; }
sed -i "s/^DEBIT_MANDATE_CREDITOR_TENANT_ID=.*/DEBIT_MANDATE_CREDITOR_TENANT_ID=$TENANT_ID/" .env.demo-sim
sim_compose up -d app >&2
wait_healthy
echo "fresh-stack: up at $(npx tsx scripts/demo/sim/clock.ts now), tenant acme=$TENANT_ID" >&2
