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
new tenant id → recreate the app.

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

- **Bank sync cannot be switched on through the product** (`TenantConfig.
  bankSyncEnabled`, no Settings field or API). The statement upload is still
  made every week through the page's Server Action; when it is refused, staff
  capture the statement's EFT credits by hand (`servicing/bank-statement.ts`).
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
  insurance officer, branch manager) plus a platform operator (SUPER_ADMIN),
  all TOTP-enrolled through Settings → Users; two branches; the operator turns
  on the CRM and bureau-submission modules and the bureau supplier details
  (`/api/admin/tenants/[id]` with `ADMIN_SECRET`, from the shared secrets
  file); Settings → Insurance on; referral commission 2%; the
  inbox roster. Credentials: `scripts/demo/.sim-breadth-staff.json`.
- **CRM** (`crm.ts`, `crm-leads.ts`): 23 leads from staff capture, the website
  contact form and the website application form (with agent codes), through
  calls, callbacks, tasks, e-mail, offers and lost reasons; cross-sell
  opportunity work. Lead conversion is NOT driven: the route fails in this
  build (CHECK `LoanApplication_acknowledgement_requires_pasq_document`; fixed
  by e85cc90 on `fix/ci-green-and-quality`).
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
  credentials (TOTP secrets are fresh per bake). A snapshot is written and
  `latest` moved only when every check passed; the newest 4 are kept. It
  refuses to run when this worktree's `prisma/migrations` differ from the
  image's (the sim migrates and seeds from the worktree).
- **restore.sh**: refuses a snapshot baked on another image than the live
  staff container runs. Stops app + portal (never the tunnel), drops and
  recreates the database inside the db container, `pg_restore`s, replaces the
  uploads volume (owned by the image's `nextjs:nodejs`), writes the snapshot's
  tenant id to `DEBIT_MANDATE_CREDITOR_TENANT_ID` in the live `.env.production`,
  `up -d` app + portal and waits for `/api/health` on :3310 and :3312.
- **Moving live to a new build**: `build-image.sh`, set `APP_IMAGE`, `GIT_SHA`,
  `BUILD_TIME` in the live `.env`, `docker-compose -f docker-compose.demo.yml up
  -d --no-deps app app-portal`, then `bake.sh && restore.sh`.
- **Schedules** (crontab of hein, box clock is SAST): `cron-run.sh restore`
  nightly 02:30; `cron-run.sh bake` (bake, then restore) Sundays 00:30. Logs:
  `logs/<job>-<stamp>.log`, newest 14 kept; a failed bake also leaves its
  simulate/verify-pages reports there.

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
