# Running one lender

One lender = one directory = one compose project (`credaflow-lender-<slug>`) = a staff
app container, a client-portal container, one Postgres and their named volumes. Nothing in these scripts knows
the host: any GNU/Linux machine with Docker, a VPS or a managed Docker host. The scripts are
GNU/Linux only (bash 4+, GNU `date -d`, `readlink -m`, `stat -c`, `/proc`, `flock`); they are not tested on macOS or Windows. Everything lives in
`scripts/lender/`; `docs/ONBOARDING.md` is the order to do it in.

The `credaflow-lender-` project prefix keeps a lender clear of the other stacks on a
host (`credaflow-demo`, `credaflow-fairscore`, `credaflow-staging`, …). `provision-lender.sh`
refuses, before creating anything, if a container already carries that compose project
label with a `working_dir` other than this lender directory (or none), or, for a new lender
directory, if any volume or network already carries it (those do not record a working_dir, so
they cannot prove who owns them; on a rerun in an existing directory they are presumed this
lender's own). `deploy.sh`'s port check likewise counts a port as this lender's when one of its
containers is *configured* to publish it, even while that container is crash-looping.

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
  secrets/auth.env             mode 0600: STAFF_AUTH_SECRET + PORTAL_AUTH_SECRET (see below)
  backups/                     <slug>-<UTC>[-label].dump.gpg + .counts sidecars
  state/                       image.env, current-image, previous-image, deploys.log, lender.lock
```

## Scripts

| Script | What it does |
|---|---|
| `provision-lender.sh <dir> --config lender.json --port N --public-url URL --portal-port N --portal-url URL [--admin-email E] [--build] [--image name:tag] [--update-settings]` | env file with generated secrets, compose project, migrate, tenant, first SUPER_ADMIN, then `deploy.sh`. Safe to rerun: never rotates a secret, recreates the tenant or mints a second admin. A rerun that asks for a different port, bind or URL says `kept existing X=…` and changes nothing unless `--update-settings` is given. |
| `deploy.sh <dir> <name:tag> [--build] [--skip-backup] [--health-timeout S]` | backup, migrate, switch, health-check, roll back on failure. |
| `backup.sh <dir> [--label L] [--keep N]` | encrypted `pg_dump -Fc` and uploads tar, read-back checks, retention. |
| `restore.sh <dir> <file> [--drop-scratch]` | restore into a NEW scratch database and verify it and the uploads archive. |
| `restore.sh <dir> <file> --over-live --confirm <slug> [--accept-count-drift] [--allow-unresolved-migration]` | verified restore, then swap the database and the uploads in. |
| `restore-drill.sh <dir> [<file>] [--keep-stack]` | timed restore of database + uploads into a throwaway project, health and count checks, torn down after. |
| `encrypt-uploads.sh <dir> [--dry-run \| --verify]` | encrypt the uploads written before `UPLOADS_ENC_KEY` was set; `--verify` checks they open. |
| `npm run lender:bootstrap-tenant -- --config f.json [--dry-run]` | tenant + config + default templates (run in the tools image by provision). |
| `prisma.sh <dir> migrate status \| resolve --rolled-back\|--applied <name> \| deploy` | recover from a failed migration (below), from the deployed tools image. |
| `admin.sh <dir> --email E [--break-glass [--reactivate]] [--dry-run]` | the first-admin CLI (`lender:bootstrap-admin`) against this lender, for break-glass. provision runs the same CLI for the first admin. |

### Two images

The runtime image (`name:tag`) is the Next.js standalone output and contains no
Prisma CLI, `tsx` or scripts. Migrations and the bootstrap CLIs therefore run
from a **tools image**, `name-tools:tag`, which is the Dockerfile's `builder`
stage. `--build` builds both from the same checkout and the same build args
(cache shared). Without `--build`, both must exist locally or be pullable, so
publishing to a registry means pushing **both** tags. That registry path is not
exercised here (no registry on the staging host).

**What goes into an image.** `--build` builds from a `git archive` export of `HEAD` in a temp
dir, never from the working tree: the Dockerfile does `COPY . .`, and a working tree holds
gitignored files (`.env*`, `*.pem`, `uploads/`, the OCR corpus of real client documents) that must
not ship. It also refuses a dirty tree. `.dockerignore` excludes the same paths for any other
build. Both images carry the labels `io.credaflow.lender-slug` and `io.credaflow.git-sha`;
`deploy.sh` and `provision-lender.sh` refuse an image whose slug label is not this lender's (or
is missing), because the slug is baked into the bundle and another lender's image answers
`/api/health` yet fails every page.

**The env-credential owner's slug is never reused.** `ENV_CREDENTIALS_TENANT_SLUG`
(set by `provision-lender.sh` to the stack's lender) hands the Stitch, SmileIdentity and
Experian accounts in `.env` to whichever tenant holds that slug. Renaming the owner
tenant's slug, or deleting and recreating a tenant under it, gives those accounts to the
new holder. Retire such a slug for good; to move the accounts, change
`ENV_CREDENTIALS_TENANT_SLUG` (or better, store them on the lender's TenantConfig).

`NEXT_PUBLIC_*` values are baked into the client bundle at build, so an image is
specific to one lender (`NEXT_PUBLIC_TENANT_SLUG` plus whichever `NEXT_PUBLIC_*`
keys are set in the lender's `.env`).

## Provision

```bash
cd /path/to/CredaFlow          # a clean checkout at the commit to run
scripts/lender/provision-lender.sh /srv/lenders/acme \
  --config /path/to/acme.json --port 3350 --public-url https://app.acme.example \
  --portal-port 3352 --portal-url https://portal.acme.example \
  --admin-email owner@acme.example --build
```

The first admin's one-time password and TOTP secret are printed to the terminal
once, between `=== first SUPER_ADMIN credentials` markers, by the container. They
are not written to any file or log: do not pipe this command's output into one.
Two containers run from the same image: **staff** (`APP_MODE=staff`, `--port`) and
**portal** (`APP_MODE=client`, `--portal-port`); each 404s the other's routes, so the
reverse proxy must send the staff host to `--port` and the portal host to
`--portal-port`. Both bind to `127.0.0.1`; put the host's TLS reverse proxy in front
(`--bind 0.0.0.0` publishes it directly). Set `TRUSTED_PROXY` in `.env` to the
number of proxies in front, or login rate limiting and the website chat see every
caller as one address.

## Session secrets: staff and portal are separate

Staff and client sessions must not be replayable against each other, so each host
signs its sessions with its own secret. `provision-lender.sh` generates
`STAFF_AUTH_SECRET` and `PORTAL_AUTH_SECRET` (random, 64 hex chars, different) into
`secrets/auth.env` and never rotates them on a rerun. The compose file sets each
container's `AUTH_SECRET` from its own value with a required-variable guard
(`${STAFF_AUTH_SECRET:?…}`), so there is no fallback to a shared secret, and
they sit in `secrets/auth.env`, not `.env`, so the other container's `env_file` never
carries them. `NEXTAUTH_SECRET` stays in `.env` as a third, different secret
(insurance disclosure tokens only).

`deploy.sh` and `provision-lender.sh` refuse, before touching anything, unless the secrets in the
**rendered** compose config (`compose config --format json`, i.e. what the daemon will really
run, after quoting, duplicate keys and `env_file` merging) are both set, at least 32 characters,
different from each other and from `NEXTAUTH_SECRET`, and neither per-host secret reaches a
container's environment through `.env`. All compose calls run with a scrubbed environment (`env -i`
plus the few variables docker itself needs), so an operator's shell `STAFF_AUTH_SECRET=…` or
`APP_BIND=0.0.0.0` cannot override the files. The ports and bind the probes and the port check use
are read from the rendered config too.
Rotating either secret ends every session on that host: edit `secrets/auth.env`
and redeploy.

Provisioning validates everything it writes into `.env`: the two URLs must be
`http(s)://host[:port]` with no path, space or newline, `--bind` an IPv4 address, ports 1-65535,
`--admin-email` and `--image` plain. A rerun reports a changed value as `kept existing …` and
applies it only with `--update-settings`.

## Deploy

```bash
scripts/lender/deploy.sh /srv/lenders/acme credaflow-acme:$(git rev-parse --short=12 HEAD) --build
```

Order: rendered-config check (below), image-slug check, **host ports free** (refuses when something other than this lender's own containers listens on either port), images present, database up, **pre-migration backup** (skipped on the very
first deploy, when there is no migration table), `prisma migrate deploy` (the old
app is still serving), switch both containers (one `compose up -d app app-portal`), then poll
`/api/health` on **both** until HTTP 200, `status: ok` (the route runs `SELECT 1`, so the
database is included) and `commit` equal to the image's own `GIT_SHA`, probed at the bound address (`APP_BIND`; a wildcard bind is probed through `127.0.0.1`). Each host's tenant-resolving login page (`/login`, `/portal/login`) must also return 200.

`--build` refuses a dirty tree (untracked files count): the image would match no
commit. There is no pull + build + restart inside a live directory.

**Failure handling**

- Ports taken, backup or migration fails: nothing was switched, the old app keeps running.
- `compose up` itself fails (a port race, a bad image) or health fails after the switch:
  both take the same path. The previous image (`state/current-image`) is put back and
  health-checked again; the deploy exits non-zero and says `ROLLED BACK`.
- A redeploy of the **same tag** that goes unhealthy has nothing to roll back to. It is
  logged (`SAME_TAG_UNHEALTHY`) and the stack is left running, not stopped, for you to
  inspect. The same holds for a first deploy over a stack that was already serving. Only a
  first deploy of a stack that never served is stopped.
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

**Rollback pins images by id.** The switch and the rollback use the immutable image id
(`state/current-image-id`, `previous-image-id`, `current-tools-id`), so a tag that is re-pushed
between deploys cannot change what is restored. A re-pushed tag that goes unhealthy is rolled back
to the id that was running; only a redeploy of the identical image id is the "left running" case.

### A failed migration

`deploy.sh` stops before switching the app and prints the pre-migration backup. A migration that
failed part-way is recorded as failed in `_prisma_migrations`, and every later `migrate deploy`
refuses (`P3009`) until you resolve it. From the lender's own tools image:

```bash
scripts/lender/prisma.sh /srv/lenders/<slug> migrate status
# the migration was NOT applied (or you rolled its effects back by hand):
scripts/lender/prisma.sh /srv/lenders/<slug> migrate resolve --rolled-back <migration_name>
# the migration's effects ARE all in place (you finished it by hand):
scripts/lender/prisma.sh /srv/lenders/<slug> migrate resolve --applied <migration_name>
scripts/lender/prisma.sh /srv/lenders/<slug> migrate deploy
```

`migrate resolve --rolled-back` leaves the row with `finished_at` NULL and sets `rolled_back_at`; backup and restore treat that as resolved. A backup taken **while** a migration is failed and unresolved is still written (the old app keeps taking writes during that incident, and a gap in backups would be worse), but under a distinct name `<slug>-<UTC>-unresolved.dump.gpg` with a `.unresolved` sidecar naming the migration, and with a loud `WARNING` block in its output (and so in `cron.log`). Those dumps are their own retention pool, so a long incident neither evicts the last clean nightlies nor is evicted by them. `restore.sh` refuses such a file unless `--allow-unresolved-migration` is passed; the last backup *not* marked unresolved is the clean restore point. A restore with no `.counts` sidecar is refused for `--over-live` without `--accept-count-drift`.

Do not hand-edit the schema of a lender database unless you can say exactly what the migration
would have done; the safer path is to restore the pre-migration backup (below) and deploy the
fixed image: `restore.sh <dir> backups/<slug>-<UTC>-pre-<tag>.dump.gpg --over-live --confirm <slug>`.
The restore loses every write since that backup.

## Backup and restore

`backup.sh` pipes `pg_dump -Fc` straight into **gpg** (symmetric AES256, passphrase
in `secrets/backup.passphrase`); `age` is not assumed installed. Nothing
unencrypted touches disk. The dump is decrypted and `pg_restore --list`ed before
it counts. One session holds a `REPEATABLE READ` transaction, exports its snapshot, takes
the row counts in it and runs `pg_dump --snapshot` on the same snapshot, so the `.counts`
sidecar matches the dump exactly even while the app writes. The newest `BACKUP_KEEP`
(`.env`, default 14) are kept **in each pool** (`pre-*` taken before a migration or restore,
and the rest), so nightly backups never push out the pre-migration ones.

The uploads volume is backed up with the database: after the dump, a throwaway
container of the database image tars the volume read-only into gpg the same way
(`<file>.uploads.tar.gpg`, read back and listed before it counts), and
`<file>.files` records the file count (`files=none` before the volume exists).
The documents inside are themselves encrypted at rest when `UPLOADS_ENC_KEY` is
set, so a restore needs that key as well as the passphrase.

Copy `secrets/backup.passphrase` **and `UPLOADS_ENC_KEY` from `.env`** to a password
manager or another host. A backup on the same disk as its passphrase protects
against nothing but a bad migration. Also copy the backups off the host; these
scripts do not.

Cron (these scripts install none). Nightly backup and a weekly restore drill:

```
30 1 * * * /path/to/CredaFlow/scripts/lender/backup.sh /srv/lenders/acme >> /srv/lenders/acme/backups/cron.log 2>&1
45 2 * * 0 /path/to/CredaFlow/scripts/lender/restore-drill.sh /srv/lenders/acme >> /srv/lenders/acme/backups/cron.log 2>&1
```

`restore-drill.sh` restores the newest clean backup (or the one named) into its own
compose project `credaflow-drill-<slug>-<UTC>` (own Postgres, own volumes, the deployed
image on a random loopback port), and passes only when `pg_restore --exit-on-error`
succeeds, the row and file counts equal the sidecars, every encrypted upload opens
with `UPLOADS_ENC_KEY`, and the app answers `/api/health` with `status: ok`. It prints
the time of each step and the total, then `down -v`s the project. The drill app has no
`CRON_SECRET` (no scheduler) and no provider credentials: a restored copy never
messages a borrower.

### Encryption at rest of existing uploads

Every file `lib/storage.ts` writes is encrypted with a per-file key wrapped by
`UPLOADS_ENC_KEY`, bound to its path under the uploads volume (a file moved or
swapped under another name does not open): client documents, NCA artefacts and
the insurance disclosure PDFs (`disclosures/`). Tenant logos (`tenant-logos/`) are
public and stay plaintext. With `UPLOADS_ENC_REQUIRED=true` storage fails closed: no
key, no write, and a plaintext file is refused on read, which `/api/health` reports as
a storage failure. It is off unless set, so the first deploy of this code never breaks
an existing stack whose files are still plaintext.

New lenders get `UPLOADS_ENC_KEY` and `UPLOADS_ENC_REQUIRED=true` from
`provision-lender.sh`. For a lender provisioned before it: rerun `provision-lender.sh`
(it adds the missing key, never rotates one, and does not switch the requirement on for
an existing directory), redeploy so the app reads and writes with the key, take a
backup, then `encrypt-uploads.sh <dir> --dry-run`, `encrypt-uploads.sh <dir>`,
`encrypt-uploads.sh <dir> --verify`; then set `UPLOADS_ENC_REQUIRED=true` in `.env`
and redeploy. It converts one file at a time (a temp file with
a random name, read-back, rename; temp files of an interrupted run are deleted first),
skips files already encrypted, never re-wraps a file encrypted under another key or one
that fails its check (it reports them), and refuses while the running app lacks the key.

`restore.sh` creates `<db>_restore_<UTC>`, restores with `--exit-on-error`, checks
`_prisma_migrations` (rows, none unfinished) and compares the row counts with the
sidecar. A difference is a loud `WARNING` naming the tables (`User: backup=9 restored=1`),
never a block on a scratch restore; `--over-live` refuses it unless you add
`--accept-count-drift`. Any failed query drops the scratch database. `--over-live --confirm <slug>` additionally takes a `pre-restore` backup,
stops the app, renames the live database to `<db>_pre_restore_<UTC>`, renames the
scratch one into place, starts the app and health-checks it. The old database is
kept; undo by swapping the two names back. Drop it yourself when satisfied.
The uploads archive is checked against `<file>.files` the same way (a difference is
drift). Over live, with the app stopped and before the database swap, it is unpacked
into `<volume>/.restore-<UTC>` and counted; only then do the live files move to
`<volume>/.pre-restore-<UTC>` and the restored ones into place. A failed unpack leaves
the files and the database as they were and starts the app again.

## Health

`/api/health` answers `status: ok` (200) when the database answers `SELECT 1` and
storage round-trips a probe file through `lib/storage` (encryption included), else
`status: error` (503); `deploy.sh` and the compose healthcheck read that. Without
credentials the body is `status` plus the deploy marker `deploy.sh` compares (`mode`,
`commit`, `builtAt`, `checkedAt`) and never says which check failed or why. With the
`x-cron-secret` header it adds `checks` (`database`, `storage`, `storageEncryption`
`on`/`off`, `cron` `ok`/`stale`/`not_scheduled`), `warnings` (degraded but not failing:
`cron_stale`, `storage_encryption_off`, `webhook_outbox_failures`, so a stack that was
down overnight still passes its next deploy) and `detail` (per-job freshness, and
`webhookOutboxFailures24h`: webhook events a database trigger could not write in the last
24 hours; the payment, loan or application was saved, its event was lost; the rows are in
`WebhookOutboxFailure`). Probe errors go to the container log only. Cron
freshness comes from `CronHeartbeat`, written after every in-process job
(`instrumentation.ts`); jobs an external scheduler owns are not tracked. Point an uptime
monitor at it; nothing here sends alerts.

## Lender API logs and webhooks

`ApiRequestLog` gets a row for every `/api/v1` request that names a real key; requests
naming no key, and 429s, are sampled (10 a minute per process; the rest are counted in the
container log). Rate limits: 120 a minute per key; failed authentications per caller
address (30 a minute, when `TRUSTED_PROXY` makes the address known), else in one global
bucket (300 a minute), answer 429 instead of 401. A valid key is never throttled by other
callers' failures, and key buckets live in their own store, so no flood of addresses can
evict one. The nightly `lender-api-retention` cron deletes request logs after
`API_LOG_RETENTION_DAYS` (90), and finished webhook deliveries with their events and
outbox failures after `WEBHOOK_LOG_RETENTION_DAYS` (30).
Deliveries are claimed fairly: per run at most 25 per endpoint and 50 per lender.
A webhook endpoint whose receiver fails 20 POSTs in a row is paused (audited
`WEBHOOK_ENDPOINT_PAUSED`); its deliveries wait without spending attempts until an admin
resumes it in Settings → API & webhooks. Deliveries of a lender that is not ACTIVE wait too.
A local fault (no `WEBHOOK_SECRET_KEY`, a secret that will not open) sends nothing: the
delivery is retried every 5 minutes without spending an attempt or counting toward the pause.

## Admin recovery

`lender:bootstrap-admin` is one-shot: it refuses when the tenant has any
SUPER_ADMIN (active or not), takes a row lock on the tenant so two runs cannot both
win, and audits `SUPER_ADMIN_BOOTSTRAPPED` (no credential in the row). It works under
`NODE_ENV=production`, creates only that user and no demo data. The TOTP secret is
enrolled at creation whatever the lender's staff-2FA setting (a per-lender
`TenantConfig` setting, on by default): user and identity writes need a
TOTP-verified session either way.

If the only SUPER_ADMIN is locked out (lost password or authenticator, deactivated),
on the host, from a checkout:

```bash
scripts/lender/admin.sh /srv/lenders/<slug> --email <their email> --break-glass [--reactivate] [--dry-run]
```

(`admin.sh` runs the CLI from the tools image of the currently deployed image on the
lender's own network; the password reaches it by variable name, not argv.) Break-glass only
resets an **existing** SUPER_ADMIN of that tenant: new password, new TOTP secret,
re-activated (only with `--reactivate` if the account was deactivated, with a warning: a deactivation may have been deliberate), every session ended (`tokenVersion` bump), audited as
`SUPER_ADMIN_BREAK_GLASS_RESET`. It never creates or promotes a user. Login rate
limiting is in process memory (`lib/rate-limit.ts`); restarting the app clears a
throttle. `admin.sh` fixes the tenant to the lender's own: a `--tenant` argument is refused. The operator needs docker access to the host, which is the trust boundary.

## One lock per lender

`provision-lender.sh`, `deploy.sh`, `backup.sh` and `restore.sh` share `state/lender.lock`
(`flock`), taken after a host-wide lock per compose project (`$XDG_RUNTIME_DIR/credaflow-lender-locks-<uid>/<project>.lock`, else `/tmp`), which
provision holds from the project-collision check until its `up`, so two directories (or a symlink and its target) racing for
the same slug cannot both pass the check. The lender directory is canonicalised (`pwd -P`) everywhere. A script that
holds the lock passes the open descriptor to the scripts it calls; nothing in the environment can claim the lock. A second one waits up to `LENDER_LOCK_WAIT` seconds (default 600), then stops with
a message, so a nightly backup rides out a deploy and two deploys never interleave. They call
each other (deploy takes its pre-migration backup) without deadlocking.

## Tearing a lender down

Irreversible, and the volumes hold the database and uploads. Take a backup and copy
it off first. Then, for exactly this lender:

```bash
docker compose -p credaflow-lender-<slug> -f <dir>/docker-compose.yml --project-directory <dir> \
  --env-file <dir>/.env --env-file <dir>/secrets/auth.env --env-file <dir>/state/image.env down --volumes
```

## Environment variables

Every variable the app reads, required or optional per integration, with what sets it: `docs/DEPLOY-ENV.md`.

## Not covered

- Scheduling: only some cron routes are registered in-process. `dpd-update`,
  `reminders` and `escalations` must be called by an external scheduler with
  `x-cron-secret` (see the ownership comment in `instrumentation.ts`); nothing here
  installs one.
- TLS, DNS and the reverse proxy. Log shipping, and alerting on `/api/health`.
- Pushing images to a registry, and pulling both tags from one.
- Rotating `WABA_ENC_KEY`, `UPLOADS_ENC_KEY`, `WEBHOOK_SECRET_KEY` or the backup passphrase.
