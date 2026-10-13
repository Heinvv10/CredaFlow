# Demo simulator — sim stack, clock, API client

Plan: `docs/plans/2026-10-10-demo-simulator.md` (T1). The sim stack
(`docker-compose.demo-sim.yml`, project `credaflow-demo-sim`) runs the demo
image and Postgres under one fake clock, on `127.0.0.1:3320` (app) and
`127.0.0.1:5456` (db). No tunnel, no public ingress. It is not the live demo.

## Bring-up (fresh)

```bash
# .env.demo-sim must exist (untracked): POSTGRES_*, DATABASE_URL (db:5432),
# SIM_HOST_DATABASE_URL (127.0.0.1:5456), AUTH_SECRET,
# NEXTAUTH_URL/AUTH_URL=http://localhost:3320,
# NEXT_PUBLIC_TENANT_SLUG=acme, TENANT_HOST_MAP=localhost=acme,127.0.0.1=acme,
# the live demo's *_DRY_RUN / SIMULATED_INTEGRATIONS settings, VLM_API_URL,
# public link origins (PORTAL_PUBLIC_ORIGIN, NEXT_PUBLIC_PORTAL_URL,
# NEXT_PUBLIC_WEBSITE_URL, NEXT_PUBLIC_APP_URL = https://demo.credaflow.com)
# and DEBIT_MANDATE_CREDITOR_TENANT_ID (rewritten by fresh-stack.sh).
# Secrets shared with the live demo — CRON_SECRET, INTERNAL_API_SECRET,
# ADMIN_SECRET, NEXTAUTH_SECRET, WABA_ENC_KEY, TURNSTILE_SECRET_KEY (Cloudflare
# test secret) and the fictional DEBIT_MANDATE_CREDITOR_BANK_NAME/
# _ACCOUNT_NUMBER/_BRANCH_CODE — live in ~/credaflow-demo-data/secrets.env
# (ensure_shared_secrets in scripts/demo/lib.sh; the app loads it second).
scripts/demo/sim/fresh-stack.sh 2026-04-01T07:30:00+02:00   # DESTROYS the sim volumes
npx tsx scripts/demo/sim/smoke.ts   # optional: leaves the clock at +30 days
```

`fresh-stack.sh` = `down -v` → clock → `up` → chown the uploads volume →
`prisma migrate deploy` → `seed-faked.sh` (the base seed under the fake clock,
in a throwaway container) → rewrite `DEBIT_MANDATE_CREDITOR_TENANT_ID` to the
new tenant id → recreate the app. Every compose call is pinned to the sim
project (`sim_compose` in `scripts/demo/lib.sh`, `-p credaflow-demo-sim`), and
it refuses a `SIM_HOST_DATABASE_URL` that is not `127.0.0.1:5456`. All Docker
names (live and sim) are constants in `lib.sh`.

The network is pinned to 172.16.120.0/24 because the host firewall only lets
172.16.0.0/12 Docker networks reach the VLM on :8100.

## Scenarios

`scripts/demo/scenarios/` drives storylines through the HTTP API only.
`run-origination.ts --persona <id> --start YYYY-MM-DD [--stop-after <step>]`
runs one persona from capture to payout (or decline); see `origination.ts`.

## The bake (T4)

```bash
scripts/demo/sim/fresh-stack.sh 2026-04-01T07:30:00+02:00
npx tsx scripts/demo/simulate.ts [--start 2026-04-01] [--until YYYY-MM-DD] [--resume]
npx tsx scripts/demo/sim/verify-pages.ts          # after the bake, never during it
npx tsx scripts/demo/simulate/report.ts           # re-print the report from saved state
```

`simulate.ts` steps one simulated day at a time to `--until` (default: today,
stopping at the real time). Each day plays the day's crons at their SAST slots
interleaved with scenario events: origination steps (`scenarios/origination.ts`
timetable), the 14:00 debit-order results upload, receipts, the Monday bank
statement import, reminders, Section 129, arrangements, attorney referral and
write-off. `simulate/plan.ts` schedules each persona relative to the window so
it ends in its storyline's state; the report at the end checks every storyline,
`assert_payment_allocation_reconciles()` and `check-dates`. State is saved after
every event in `scripts/demo/.sim-state.json`; `--resume` continues a crashed run.

- **Bank sync** is switched on in the servicing setup through Settings → Bank
  Statement Import (`PATCH /api/settings/bank-sync`, the TOTP-verified admin).
  Each statement is uploaded through the page's Server Action and every EFT
  credit reconciled from the review queue: confirmed when the matcher proposed
  the right loan, otherwise assigned to it (`servicing/bank-statement.ts`). A
  refused upload fails the event; there is no hand-capture fallback.
- **Outbound email** goes to `smtp-sink.sh` (container `credaflow-demo-sim-smtp`,
  mail filed under `scripts/demo/.out/sim-mail/`), configured through Settings →
  Email; a Section 129 notice is only issued when the provider accepts it. The
  bake deactivates the email config at the end. The `WABA_ENC_KEY` the product
  needs to store an SMTP password is in the shared secrets file (live uses the
  same key, so the restored config still decrypts).
- **The collections manager** (LOAN_ADMIN, for dual-control write-off) is created
  and TOTP-enrolled through Settings; credentials in `scripts/demo/.sim-staff.json`.
- Do not sign in from another process while a bake runs: the clock jumps between
  generating a TOTP code and verifying it, so the code is refused.

## Breadth (T5)

`scripts/demo/breadth/` adds every other staff-app module to the same event
queue (`breadth/index.ts`), through the routes the screens call:

- **Setup** (first business day, 08:15): three staff (second credit officer,
  insurance officer, branch manager), all TOTP-enrolled through Settings →
  Users; two branches; a platform operator (SUPER_ADMIN, which no route can
  create; `fresh-stack.sh` bootstraps it with `provision-operator.ts`, and
  `bake.sh` deactivates it and drops its credentials before the snapshot) turns
  on the CRM and bureau-submission modules and the bureau supplier details
  (`/api/admin/tenants/[id]` with `ADMIN_SECRET`, from the shared secrets
  file); Settings → Insurance on; referral commission 2%; the
  inbox roster. Credentials: `scripts/demo/.sim-breadth-staff.json`.
- **CRM** (`crm.ts`, `crm-leads.ts`): 23 leads from staff capture, the website
  contact form and the website application form (with agent codes), through
  calls, callbacks, tasks, e-mail, offers and lost reasons; cross-sell
  opportunity work; three leads convert into a client and a submitted
  application (`POST /api/crm/leads/[id]/convert`).
- **Referral agents** (`referrals.ts`), **insurance** (`insurance*.ts`: funeral
  catalogue, FAIS quote → advice → disclosure → bind, claims, commissions; no
  credit life — with `CREDIT_LIFE_AUTO_BUNDLE_ENABLED=false` it cannot be
  accepted), **compliance** (`compliance.ts`), **inbox** (`inbox.ts`, e-mail
  only — WhatsApp is off) and **bureau** (`bureau.ts`: adverse-listing
  confirmations; the files come from the bureau crons, which the bake plays in
  TEST mode).
- The second credit officer runs the origination of odd-numbered background
  personas (`Sim.originationActors`).
- `NEXTAUTH_SECRET` must be set (shared secrets file): the FAIS
  disclosure token is signed with it, not with `AUTH_SECRET`.
- Agreement generation is retried once when the route reports a failed
  finalization it cleaned up (`agreementIntegrity: staging_failed`): on a
  loaded host its transaction can overrun Prisma's 5 s interactive limit.

`verify-pages.ts` loads every page of the staff navigation
(`lib/navigation.ts`), the module sub-pages, sampled detail pages, and the
client portal navigation for a borrower with a loan and a policy.

## Bake, snapshot, restore (T6)

State outside git, in `~/credaflow-demo-data/` (`DEMO_DATA_DIR`): `secrets.env`,
`snapshots/<UTC stamp>/` + `latest`, `logs/`. Scripts in `scripts/demo/`:

```bash
scripts/demo/build-image.sh   # product image from this worktree → credaflow:demo-<sha>[-dirty-<hash8>]
scripts/demo/bake.sh          # ~35 min; on the image the live demo runs
scripts/demo/restore.sh       # latest → the live demo stack; [snapshot] [--force-image]
```

- **Image tag**: `credaflow:demo-<short sha>`, plus `-dirty-<hash8>` (sha256 of
  `git diff HEAD` + untracked files) when the tree is uncommitted. `/api/health`
  reports the same string as `commit`. Build args are the live demo's (tenant
  slug and portal login URL from its `.env`) plus Cloudflare's always-pass test
  Turnstile site key.
- **bake.sh**: sim image on the live image → `fresh-stack.sh` → `simulate.ts`
  → `check-dates` → `assert_payment_allocation_reconciles()` →
  `verify-pages` → `db.dump` (pg_dump -Fc), `uploads.tar.gz`, `meta.json`
  (image, sim window, tenant id, counts, checks) and the bake's staff
  credentials (TOTP secrets are fresh per bake; `restore.sh` clears staff TOTP on
  the live demo, SUPER_ADMIN excepted). A snapshot is written and
  `latest` moved only when every check passed; the newest 4 are kept. It
  refuses to run when this worktree's `prisma/migrations` differ from the
  image's (the sim migrates and seeds from the worktree).
- **restore.sh**: refuses, before touching anything, a target whose app,
  portal and db are not in compose project `credaflow-demo` started from
  `LIVE_DIR`, or whose app/portal lack `DEMO_MODE=true`; and a snapshot baked
  on another image than the live staff container runs. While the demo keeps
  serving it `pg_restore`s into `<db>_restore_<ts>` (row counts checked against
  `meta.json`) and unpacks the uploads into `.restore-<ts>` in the volume (file
  count checked). If the live app runs with `DEMO_CLEAR_STAFF_TOTP=true` (set
  in the live `.env.production`), the staged db has TOTP turned off for every
  staff user except SUPER_ADMIN, so presenters sign in with a password only;
  the bake enrols TOTP, so without it every restore turns TOTP back on.
  Then: stop app + portal (never the tunnel) → rename the live
  db to `<db>_old_<ts>` and the staged one into place (one transaction) → swap
  the uploads (old ones to `.old-<ts>`) → tenant id into
  `DEBIT_MANDATE_CREDITOR_TENANT_ID` in the live `.env.production` → `up -d`
  app + portal → `/api/health` on both. The old db and uploads are dropped
  only once both answer; any failure after the stop renames them back and
  restarts app + portal. Measured on a throwaway copy of the live stack:
  14–24 s, ~6 s of it down.
- **Moving live to a new build**: `build-image.sh`, set `APP_IMAGE`, `GIT_SHA`,
  `BUILD_TIME` in the live `.env`, `docker-compose -f docker-compose.demo.yml up
  -d --no-deps app app-portal`, then `bake.sh && restore.sh`.
- **Schedules** (`scripts/demo/crontab.example`, box clock is SAST):
  `cron-run.sh restore` nightly 02:30; `cron-run.sh bake --first-sunday`
  (bake, then restore) at 02:00 on the first Sunday of the month
  (`0 2 1-7 * *` + the weekday check in `cron-run.sh`). Jobs share
  `cron-run.lock`, so that night's restore waits for the bake. Logs:
  `logs/<job>-<stamp>.log`, newest 14 kept; a failed bake also leaves its
  simulate/verify-pages reports there.
- **Failures**: a failed job writes `logs/LAST_FAILURE-<job>` (time, job, exit code,
  log), removed by the next success of the same job; bake and restore record
  their last outcome in `logs/last-bake` / `logs/last-restore`.
  `scripts/demo/status.sh` prints these with the snapshot's age and whether its
  image matches live (exit 1 when something needs attention). Nothing is sent
  anywhere; no notification channel is configured.
- **VLM pacing** (`sim/vlm-gate.ts`): the VLM is shared with FibreFlow
  production, so the bake has at most one extraction in flight, uploads the
  next document only after the previous one's extraction settled, pauses
  `SIM_VLM_PAUSE_MS` (default 5000) between them, and re-extracts a failure
  after `SIM_VLM_RETRY_BACKOFF_MS` (default `30000,60000,120000`) before
  failing the persona.

## Another lender (DEMO_LENDER)

`prisma/demo-lender.ts` holds the demo lenders (`acme`, the default, and
`fairscore`): tenant slug, lender identity, colours, staff and client email
domains, bureau trading name. `DEMO_LENDER=<name>` selects one for the seed
(`seed-faked.sh` passes it into the container), the simulator's staff, persona
and mailbox addresses and copy, `fresh-stack.sh`, `bake.sh` (`meta.json`
`tenantSlug`) and `build-image.sh` (tag `credaflow:<name>-<sha>`; `demo-` for
acme). Unset, everything is exactly Acme as before.

Another lender's bake needs its own checkout (its `.env.demo-sim` names the
lender's slug in `NEXT_PUBLIC_TENANT_SLUG` and `TENANT_HOST_MAP`, and its
public origins), its own `DEMO_DATA_DIR`, and that lender's live stack:

```bash
export DEMO_LENDER=fairscore DEMO_DATA_DIR=~/credaflow-fairscore-data \
  LIVE_DIR=~/Workspace/CredaFlow-fairscore DEMO_LIVE_PROJECT=credaflow-fairscore
export DEMO_LENDER_LOGO=$DEMO_DATA_DIR/branding/fairscore-logo.png   # optional PNG
scripts/demo/build-image.sh && scripts/demo/bake.sh && scripts/demo/restore.sh
```

The sim stack (`credaflow-demo-sim`) is one per host and `bake.lock` lives in
each `DEMO_DATA_DIR`, so never bake two lenders at once.

## Modules

- `clock.ts` — `setClock(date)`, `advanceDays(n)`, `now()`, `appNow()`. The
  clock file (`scripts/demo/.sim-clock/faketime.rc`) holds a libfaketime
  relative offset in seconds, so the app and every DB backend agree to the
  millisecond. `setClock` waits until `/api/health` `checkedAt` matches.
- `api.ts` — `SimClient`: one cookie jar per actor. `loginStaff(email,
  password, totpSecret)` and `loginClient(email, password)` run the Auth.js
  credentials flow the login form uses; `get/post/put` return
  `{status, json, text, bytes}` and throw `ApiError` (with the body) on an
  unexpected status.
- `credentials.ts` — reads the seed's ADMIN / CREDIT_OFFICER / portal
  credentials from `.sim-credentials.txt`.
- `cron.ts` — `runCronsForDay("YYYY-MM-DD")` runs each due `/api/cron/*` job
  at its SAST slot with `x-cron-secret`. `SKIPPED_CRONS` lists what never runs
  and why. The app's in-process scheduler cannot reach itself in this stack,
  so crons run only when this calls them.
- `readonly-db.ts` — the simulator's only database access: a Prisma client
  whose sessions run `default_transaction_read_only=on`.
- `check-dates.ts` — fails if an event timestamp in any table lies outside
  [start − 31d, end + 1d] (business-date columns are listed and excluded).

## Rules the clock imposes

- **Time only moves forward.** TOTP replay protection stores the last code's
  counter per user; rewinding the clock makes every later staff login fail
  `totp_invalid`. The smoke sets 2026-04-01, so re-run it on a fresh DB.
- **Sessions expire on the fake clock.** Auth.js JWTs last 30 days; re-login
  after long jumps.
- **Login rate limits use the fake clock:** 10 attempts per email and 30 per
  IP per 15 minutes (`lib/auth.ts`). All sim actors share one IP.
- `faketime-entrypoint.sh` preloads the thread-safe `libfaketimeMT`: with the
  plain build, Prisma's multi-threaded engine occasionally stamped a row with
  the real date (one NotificationLog row in T3).
- The app image is `credaflow:demo-sim` (`Dockerfile.demo-sim`): the product
  image named by the `BASE_IMAGE` build arg (`SIM_BASE_IMAGE`; `bake.sh` passes
  the image the live demo runs) plus libfaketime and a patch removing Prisma's `RTLD_DEEPBIND`, without
  which Prisma's `@default(now())` / `@updatedAt` carry the real date.
