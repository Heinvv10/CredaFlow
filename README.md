# CredaFlow

A white-label loan management system for South African credit providers
registered under the National Credit Act. One codebase serves any lender: its
identity, regulator numbers, brand colours and feature flags are configuration
in the database, never code.

- **Staff app** — applications, affordability and bureau checks, approval,
  signing, disbursement, collections and Section 129, CRM, insurance, reports,
  compliance registers (DSAR, complaints, conflicts of interest, breaches).
- **Client portal** — apply, sign, debit mandates, statements, payments.
- **Public website** — the lender's own site, calculators, qualification and
  an AI chat, printing only that lender's identity.
- **NCA documents** — Section 129 notices, credit agreements and PASQ,
  certificates of balance, statements, debit mandates, FAIS disclosures.

Architecture, tenancy and the database enforcement model are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); engineering rules for
contributors and agents are in [`CLAUDE.md`](CLAUDE.md).

## Quick start

Needs Node 22, npm and Docker.

```bash
npm ci --legacy-peer-deps              # plain `npm install` leaves an incomplete tree

# A throwaway Postgres 16
docker run -d --name credaflow-dev-db -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:16-alpine

cp .env.example .env
# set at least:
#   DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/postgres
#   NEXTAUTH_SECRET=<openssl rand -base64 32>
#   NEXTAUTH_URL=http://localhost:3000
#   NEXT_PUBLIC_TENANT_SLUG=acme

SEED_PRINT_CREDENTIALS=1 npx prisma migrate reset --force   # migrations + demo seed; prints the logins
npm run dev                            # http://localhost:3000
```

The seed creates one neutral demo lender, **Acme**, with an ADMIN and a
CREDIT_OFFICER (each with a TOTP secret — add it to an authenticator app),
demo clients with a portal password, and one active loan. No password is in
source: each is generated when its row is first created and kept on reruns,
or set by `SEED_ADMIN_PASSWORD`, `SEED_OFFICER_PASSWORD` and
`SEED_PORTAL_PASSWORD`. Credentials print only with `SEED_PRINT_CREDENTIALS=1`,
so they stay out of CI logs; print them on the run that creates the rows. A
database seeded before the passwords left the source still accepts the old
published ones: rerun the seed once with all three `SEED_*_PASSWORD` set. The
seed refuses to run with `NODE_ENV=production`.

Staff sign in at `/login`; clients at `/portal/login`; the website is `/`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server |
| `npm run lint` | eslint |
| `npm test` | vitest (unit and mocked suites) |
| `npm run ci:quick` | local type, lint, agent-doc and date gates; pass test paths after `--` |
| `npm run ci:quality` | complete local quality gate, including unit, face-model and build checks |
| `npm run ci:integration` | complete real-DB gate against an automatically removed PostgreSQL 16 container |
| `npm run ci:full` | `ci:quality` followed by `ci:integration` |
| `bash scripts/run-integration-tests.sh` | real-database integration suites (see below) |
| `npm run seed:base` / `seed:staging` | demo seed; `seed:staging` adds the larger demo data set |
| `npm run claude-md:check` / `agents:check` / `agents:mirror` | agent-doc drift gates and the `AGENTS.md` mirrors |
| `npm run dates:check` / `test:tz` | date-boundary lint and the time-zone matrix |
| `npm run db:drift` | compares a live database's enforcement objects with the migrations |
| `npx tsx scripts/palette-contrast.ts` | WCAG contrast of the theme tokens |

## Tests

- **Unit and mocked suites** — `npm test`. Most mock Prisma, so they cannot see
  database triggers or CHECK constraints.
- **Integration suites** — `*.integration.test.ts`, gated behind `RUN_*_IT`
  variables. Run them all against a disposable, migrated Postgres:

  ```bash
  eval "$(bash scripts/it-db.sh up cf-it-<unique>)"   # free port; exports DATABASE_URL + IT_CONTAINER
  bash scripts/it-db.sh check                          # abort here if the port is not yours
  npx prisma migrate deploy
  bash scripts/run-integration-tests.sh
  bash scripts/it-db.sh down cf-it-<unique>
  ```

  The script refuses a database that is not on this machine or a
  docker-compose service named `db` or `postgres` unless
  `ALLOW_REMOTE_TEST_DB=1`. For a local URL it also refuses unless
  `IT_CONTAINER` owns the URL's port (`CI=true` or `REQUIRE_IT_CONTAINER=0`
  opts out).
  `scripts/integration-baseline.txt` lists the suites known to fail; it may
  only shrink.

CI (`.github/workflows/quality-gate.yml`) runs the quality and integration
jobs. Draft PR updates use no runner; marking a PR ready runs both jobs. The
nightly schedule reruns integration against the current trunk.

## Environment

`.env.example` documents every variable. The groups:

- **Core** — `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
  `NEXT_PUBLIC_TENANT_SLUG` (the tenant background jobs act for).
- **Hosts and URLs** — `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_WEBSITE_URL`,
  `TENANT_HOST_MAP`, `STAFF_APP_HOST`. No defaults: unset links are omitted.
- **Payments and mandates** — `STITCH_*`, `DEBIT_MANDATE_CREDITOR_*`.
- **Messaging** — `SMTP_FROM_NAME`, `EMAIL_INTERNAL_DOMAINS`, `WA_SENDER_URL`,
  `WA_BRIDGE_ALERT_RECIPIENTS`.
- **Documents** — `VLM_API_URL`, `VLM_MODEL`, optional `VLM_API_KEY` + `VLM_ALLOW_HOSTED` for a hosted endpoint, demo stacks only (OCR of uploaded documents).
- **Website** — `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
  `ANTHROPIC_API_KEY`, `WEBSITE_CHAT_SECRET`, `TRUSTED_PROXY`, analytics
  (`NEXT_PUBLIC_MATOMO_*`, `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_POSTHOG_*`),
  insurance quotes (`FSP_QUICKQUOTE_*`).
- **Jobs and internal calls** — `CRON_SECRET`, `INTERNAL_API_SECRET`.

The lender's identity is not environment: an ADMIN enters it in
**Settings → Lender identity**, and documents refuse to render until it is set.

## Docker

`Dockerfile` builds a standalone Next.js image; `docker-compose.yml` runs the
staff app, the client portal (same image, `APP_MODE=client`) and Postgres.
There is no deploy path yet: hosting is an open decision.

NCA variable-rate written notices retain the actual effective-date deadline
(30 South African business days), provider acceptance evidence and historical
late-dispatch/uncertainty status. The independent `asset-finance-rate-notices` worker scans
and retries durable obligations every 15 minutes, with staff escalation before,
on and after the deadline. Repricing sends only after its financial commit;
late dispatch completes the workflow without erasing its timing or escalation history.
