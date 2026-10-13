# Running one lender

One lender = one directory = one compose project (`credaflow-<slug>`) = one app
container + one Postgres + their named volumes. Nothing in these scripts knows
the host: a VPS, a managed Docker host or a laptop all work. Everything lives in
`scripts/lender/`; `docs/ONBOARDING.md` is the order to do it in.

Prerequisites on the host: `docker` with compose (v2 plugin or `docker-compose`),
`jq`, `openssl`, `gpg`, `curl`, `flock`, and `git` when building. Keep the lender
directory **outside** the git checkout (the scripts refuse otherwise).

## The lender directory

```
<lender-dir>/                  mode 0700, created by provision-lender.sh
  lender.json                  tenant config (no secrets)
  .env                         mode 0600: generated secrets + settings. Never echoed.
  docker-compose.yml           copy of scripts/lender/docker-compose.lender.yml
  secrets/backup.passphrase    mode 0600: encrypts backups. COPY IT OFF THE HOST.
  backups/                     <slug>-<UTC>[-label].dump.gpg + .counts sidecars
  state/                       image.env, current-image, previous-image, deploys.log
```

## Scripts

| Script | What it does |
|---|---|
| `provision-lender.sh <dir> --config lender.json --port N --public-url URL [--admin-email E] [--build] [--image name:tag]` | env file with generated secrets, compose project, migrate, tenant, first SUPER_ADMIN, then `deploy.sh`. Safe to rerun: never rotates a secret, recreates the tenant or mints a second admin. |
| `deploy.sh <dir> <name:tag> [--build] [--skip-backup] [--health-timeout S]` | backup, migrate, switch, health-check, roll back on failure. |
| `backup.sh <dir> [--label L] [--keep N]` | encrypted `pg_dump -Fc`, read-back check, retention. |
| `restore.sh <dir> <file> [--drop-scratch]` | restore into a NEW scratch database and verify it. |
| `restore.sh <dir> <file> --over-live --confirm <slug>` | verified restore, then swap it in. |
| `npm run lender:bootstrap-tenant -- --config f.json [--dry-run]` | tenant + config + default templates (run in the tools image by provision). |
| `admin.sh <dir> --email E [--break-glass] [--dry-run]` | the first-admin CLI (`lender:bootstrap-admin`) against this lender, for break-glass. provision runs the same CLI for the first admin. |

### Two images

The runtime image (`name:tag`) is the Next.js standalone output and contains no
Prisma CLI, `tsx` or scripts. Migrations and the bootstrap CLIs therefore run
from a **tools image**, `name-tools:tag`, which is the Dockerfile's `builder`
stage. `--build` builds both from the same checkout and the same build args
(cache shared). Without `--build`, both must exist locally or be pullable, so
publishing to a registry means pushing **both** tags. That registry path is not
exercised here (no registry on the staging host).

`NEXT_PUBLIC_*` values are baked into the client bundle at build, so an image is
specific to one lender (`NEXT_PUBLIC_TENANT_SLUG` plus whichever `NEXT_PUBLIC_*`
keys are set in the lender's `.env`).

## Provision

```bash
cd /path/to/CredaFlow          # a clean checkout at the commit to run
scripts/lender/provision-lender.sh /srv/lenders/acme \
  --config /path/to/acme.json --port 3350 --public-url https://app.acme.example \
  --admin-email owner@acme.example --build
```

The first admin's one-time password and TOTP secret are printed to the terminal
once, between `=== first SUPER_ADMIN credentials` markers, by the container. They
are not written to any file or log: do not pipe this command's output into one.
The app binds to `127.0.0.1:<port>`; put the host's TLS reverse proxy in front
(`--bind 0.0.0.0` publishes it directly). Set `TRUSTED_PROXY` in `.env` to the
number of proxies in front, or login rate limiting and the website chat see every
caller as one address.

## Deploy

```bash
scripts/lender/deploy.sh /srv/lenders/acme credaflow-acme:$(git rev-parse --short=12 HEAD) --build
```

Order: images present, database up, **pre-migration backup** (skipped on the very
first deploy, when there is no migration table), `prisma migrate deploy` (the old
app is still serving), switch the app (one `compose up -d app`), then poll
`/api/health` until HTTP 200, `status: ok` (the route runs `SELECT 1`, so the
database is included) and `commit` equal to the image's own `GIT_SHA`.

`--build` refuses a dirty tree (untracked files count): the image would match no
commit. There is no pull + build + restart inside a live directory.

**Failure handling**

- Backup or migration fails: nothing was switched, the old app keeps running.
- Health fails after the switch: the previous image (`state/current-image`) is put
  back and health-checked again; the deploy exits non-zero and says `ROLLED BACK`.
  With no previous image the app is stopped instead.
- **A migration is not reverted.** The old image then runs against the migrated
  schema. A migration that only adds nullable columns is backward compatible; one
  that adds a trigger, CHECK or UNIQUE (see `CLAUDE.md`, "The Database Enforces
  the Rules") takes effect before the new code serves and can reject writes the old
  code still makes. Ship such a migration only together with its code, and expect
  the rollback to be unhealthy for writes. To undo the schema, restore the
  pre-migration backup the deploy printed (`backups/<slug>-<UTC>-pre-<tag>.dump.gpg`)
  with `restore.sh … --over-live`, then redeploy the previous image. That loses
  every write made since the backup.

`state/deploys.log` records each outcome (`DEPLOYED`, `HEALTH_FAILED`,
`ROLLED_BACK`, `MIGRATE_FAILED`, …).

## Backup and restore

`backup.sh` pipes `pg_dump -Fc` straight into **gpg** (symmetric AES256, passphrase
in `secrets/backup.passphrase`); `age` is not assumed installed. Nothing
unencrypted touches disk. The dump is decrypted and `pg_restore --list`ed before
it counts, a `.counts` sidecar records row counts, and the newest `BACKUP_KEEP`
(`.env`, default 14) are kept.

Copy `secrets/backup.passphrase` to a password manager or another host. A backup
on the same disk as its passphrase protects against nothing but a bad migration.
Also copy the backups off the host; these scripts do not.

Cron (these scripts install none). Nightly backup and a weekly restore drill:

```
30 1 * * * /path/to/CredaFlow/scripts/lender/backup.sh /srv/lenders/acme >> /srv/lenders/acme/backups/cron.log 2>&1
45 2 * * 0 /path/to/CredaFlow/scripts/lender/restore.sh /srv/lenders/acme "$(ls -t /srv/lenders/acme/backups/*.dump.gpg | head -1)" --drop-scratch >> /srv/lenders/acme/backups/cron.log 2>&1
```

`restore.sh` creates `<db>_restore_<UTC>`, restores with `--exit-on-error`, checks
`_prisma_migrations` (rows, none unfinished) and that the row counts equal the
sidecar. A dump taken while writes land can differ by in-flight rows; rerun when
quiet. `--over-live --confirm <slug>` additionally takes a `pre-restore` backup,
stops the app, renames the live database to `<db>_pre_restore_<UTC>`, renames the
scratch one into place, starts the app and health-checks it. The old database is
kept; undo by swapping the two names back. Drop it yourself when satisfied.

## Admin recovery

`lender:bootstrap-admin` is one-shot: it refuses when the tenant has any
SUPER_ADMIN (active or not), takes a row lock on the tenant so two runs cannot both
win, and audits `SUPER_ADMIN_BOOTSTRAPPED` (no credential in the row). It works under
`NODE_ENV=production`, creates only that user and no demo data. The TOTP secret is
enrolled at creation: TOTP is mandatory for staff, and user and identity writes
need a TOTP-verified session.

If the only SUPER_ADMIN is locked out (lost password or authenticator, deactivated),
on the host, from a checkout:

```bash
scripts/lender/admin.sh /srv/lenders/<slug> --email <their email> --break-glass [--dry-run]
```

(`admin.sh` runs the CLI from the tools image of the currently deployed image on the
lender's own network; the password reaches it by variable name, not argv.) Break-glass only
resets an **existing** SUPER_ADMIN of that tenant: new password, new TOTP secret,
re-activated, every session ended (`tokenVersion` bump), audited as
`SUPER_ADMIN_BREAK_GLASS_RESET`. It never creates or promotes a user. Login rate
limiting is in process memory (`lib/rate-limit.ts`); restarting the app clears a
throttle. The operator needs docker access to the host, which is the trust boundary.

## Tearing a lender down

Irreversible, and the volumes hold the database and uploads. Take a backup and copy
it off first. Then, for exactly this lender:

```bash
docker compose -p credaflow-<slug> -f <dir>/docker-compose.yml --project-directory <dir> \
  --env-file <dir>/.env --env-file <dir>/state/image.env down --volumes
```

## Environment variables

Generated by `provision-lender.sh` (secrets) or required from you. "Required" means
the lender cannot work correctly without it; everything else degrades or turns a
feature off. Provider values are blank in a new `.env` (commented TODO block).

**Core**

| Variable | Needed | Notes |
|---|---|---|
| `NEXT_PUBLIC_TENANT_SLUG` | required | the `Tenant.slug`; baked at build and read at runtime |
| `NEXTAUTH_URL`, `AUTH_URL` | required | absolute public origin; also the base for the in-process cron scheduler's calls and reset links |
| `NEXTAUTH_SECRET` | required | session signing; compose also sets `AUTH_SECRET` from it |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | required | generated; compose builds `DATABASE_URL` |
| `APP_PORT`, `APP_BIND` | required / optional | host port (compose only, not an app variable); bind address, default `127.0.0.1` |
| `CRON_SECRET` | required | gates `app/api/cron/*`; unset, the scheduler in `instrumentation.ts` is not registered |
| `INTERNAL_API_SECRET` | required | bearer for `/api/notifications/*` |
| `UNSUB_TOKEN_SECRET` | required | unsubscribe links; templated emails are refused without it |
| `WABA_ENC_KEY` | required | 32 bytes base64; seals stored email and WhatsApp credentials. Losing it orphans them |
| `ADMIN_SECRET` | optional | `x-admin-secret` for `/api/admin/tenants` |
| `TRUSTED_PROXY` | set behind a proxy | number of proxies in front; default `0` |
| `APP_MODE` | optional | `all` (default), `staff` or `client` |
| `GIT_SHA`, `BUILD_TIME` | image | baked at build; `/api/health` reports them. Do not set in `.env` |
| `NODE_ENV`, `PORT`, `HOSTNAME`, `PUPPETEER_EXECUTABLE_PATH` | image | set by the Dockerfile and compose |
| `BACKUP_KEEP` | optional | scripts only, default 14 |

**Per integration** (all optional until the feature is used)

| Feature | Variables |
|---|---|
| Payments (Stitch) | `STITCH_CLIENT_ID`, `STITCH_CLIENT_SECRET`, `STITCH_WEBHOOK_SECRET`, `STITCH_BENEFICIARY_NAME`, `STITCH_BANK_ID`, `STITCH_BANK_NAME`, `STITCH_ACCOUNT_NUMBER`, `STITCH_ACCOUNT_TYPE`, `STITCH_BRANCH_CODE` |
| Debit mandates | `DEBIT_MANDATE_CREDITOR_BANK_NAME`, `_ACCOUNT_NUMBER`, `_BRANCH_CODE` (real, printed on every mandate; placeholders are refused), `DEBIT_MANDATE_CREDITOR_TENANT_ID` (must equal the tenant id; provision sets it) |
| KYC (SmileIdentity) | `SMILE_IDENTITY_PARTNER_ID`, `SMILE_IDENTITY_API_KEY`, `SMILE_IDENTITY_ENV` (`production` or `test`), `SMILE_DRY_RUN` |
| Face match | `FACE_MODEL_DIR`, `FACE_SIMILARITY_THRESHOLD`, `FACE_MODEL_LOAD_TIMEOUT_MS`, `FACE_COMPARISON_TIMEOUT_MS` (models are in the image) |
| Bureaus | `EXPERIAN_USERNAME`, `EXPERIAN_PASSWORD`, `EXPERIAN_BASE_URL`, `EXPERIAN_ENV`, `EXPERIAN_ORIGINATING_APP`, `EXPERIAN_TIMEOUT_MS`; TransUnion, BulkSMS and Netcash keys are `TenantConfig` columns set in Settings |
| Bureau submission | `BUREAU_SUBMISSION_MODE` |
| Dry-run switches | `EXPERIAN_DRY_RUN`, `TRANSUNION_DRY_RUN`, `NETCASH_DRY_RUN`, `NETCASH_COLLECTIONS_DRY_RUN`, `BULKSMS_DRY_RUN` (SMS is off by policy), `WA_DRY_RUN`, `SIMULATED_INTEGRATIONS`. On `NODE_ENV=production` a dry-run for a financial or credit provider throws unless declared a sandbox (`lib/integrations/simulation-guard.ts`) |
| Email | primary: Settings > Email, stored sealed with `WABA_ENC_KEY`. Fallback: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`. Delivery guard: `EMAIL_DELIVERY_MODE` (default restricted to an allowlist; `unrestricted` on production only), `EMAIL_RECIPIENT_ALLOWLIST`, `EMAIL_INTERNAL_DOMAINS`, `EMAIL_INBOUND_ALLOWED_HOSTS` |
| WhatsApp Cloud | `WHATSAPP_CLOUD_APP_SECRET`, `WHATSAPP_CLOUD_VERIFY_TOKEN` (generated), `WHATSAPP_GRAPH_VERSION`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_ES_CONFIG_ID` |
| WhatsApp bridge | `WA_ENABLED`, `WA_SENDER_URL`, `WA_BRIDGE_ADMIN_SECRET`, `WA_BRIDGE_ALERT_RECIPIENTS`, `WA_UNOFFICIAL_WEBHOOK_SECRET` |
| Messaging cutover | `MESSAGING_NEW_SEND_*` (13 flags; only the literal `true` enables) |
| Website AI chat | `ANTHROPIC_API_KEY`, `WEBSITE_CHAT_SECRET` (generated, 32+ chars) and `TRUSTED_PROXY` > 0, all three |
| Bot protection | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (build), `TURNSTILE_SECRET_KEY` |
| Document OCR | `VLM_API_URL`, `VLM_MODEL` |
| Links | `NEXT_PUBLIC_PORTAL_LOGIN_URL` or `NEXT_PUBLIC_PORTAL_URL` (build; portal links are omitted or refused without), `NEXT_PUBLIC_PORTAL_ORIGIN`, `PORTAL_PUBLIC_ORIGIN`, `NEXT_PUBLIC_WEBSITE_URL`, `NEXT_PUBLIC_APP_URL`, `STAFF_APP_HOST`, `TENANT_HOST_MAP` |
| Insurance | `CREDIT_LIFE_AUTO_BUNDLE_ENABLED`, `CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS`, `FSP_QUICKQUOTE_*`, `DOCUMENT_SIGNUM_ENABLED` |
| Analytics | `NEXT_PUBLIC_MATOMO_URL`, `_MATOMO_SITE_ID`, `_MATOMO_BLOCKED_HOSTS`, `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_POSTHOG_KEY`, `_POSTHOG_HOST` (all build-time) |
| Demo only, leave unset | `DEMO_MODE` and friends, `TURNSTILE_DEV_BYPASS` |

The list comes from `process.env` / `env.` reads under `app/`, `lib/`, `components/`,
`proxy.ts` and `instrumentation.ts`; it is not generated, so recheck it when adding
an integration.

## Not covered

- Scheduling: only some cron routes are registered in-process. `dpd-update`,
  `reminders` and `escalations` must be called by an external scheduler with
  `x-cron-secret` (see the ownership comment in `instrumentation.ts`); nothing here
  installs one.
- TLS, DNS and the reverse proxy. Log shipping and monitoring.
- Pushing images to a registry, and pulling both tags from one.
- Rotating `WABA_ENC_KEY` or the backup passphrase.
