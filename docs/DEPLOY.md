# Running one lender

One lender = one directory = one compose project (`credaflow-lender-<slug>`) = a staff
app container, a client-portal container, one Postgres and their named volumes. Nothing in these scripts knows
the host: a VPS, a managed Docker host or a laptop all work. Everything lives in
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
| `backup.sh <dir> [--label L] [--keep N]` | encrypted `pg_dump -Fc`, read-back check, retention. |
| `restore.sh <dir> <file> [--drop-scratch]` | restore into a NEW scratch database and verify it. |
| `restore.sh <dir> <file> --over-live --confirm <slug> [--accept-count-drift]` | verified restore, then swap it in. |
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

Copy `secrets/backup.passphrase` to a password manager or another host. A backup
on the same disk as its passphrase protects against nothing but a bad migration.
Also copy the backups off the host; these scripts do not.

Cron (these scripts install none). Nightly backup and a weekly restore drill:

```
30 1 * * * /path/to/CredaFlow/scripts/lender/backup.sh /srv/lenders/acme >> /srv/lenders/acme/backups/cron.log 2>&1
45 2 * * 0 /path/to/CredaFlow/scripts/lender/restore.sh /srv/lenders/acme "$(ls -t /srv/lenders/acme/backups/*.dump.gpg | head -1)" --drop-scratch >> /srv/lenders/acme/backups/cron.log 2>&1
```

`restore.sh` creates `<db>_restore_<UTC>`, restores with `--exit-on-error`, checks
`_prisma_migrations` (rows, none unfinished) and compares the row counts with the
sidecar. A difference is a loud `WARNING` naming the tables (`User: backup=9 restored=1`),
never a block on a scratch restore; `--over-live` refuses it unless you add
`--accept-count-drift`. Any failed query drops the scratch database. `--over-live --confirm <slug>` additionally takes a `pre-restore` backup,
stops the app, renames the live database to `<db>_pre_restore_<UTC>`, renames the
scratch one into place, starts the app and health-checks it. The old database is
kept; undo by swapping the two names back. Drop it yourself when satisfied.

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
(`flock`). A second one waits up to `LENDER_LOCK_WAIT` seconds (default 600), then stops with
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
- TLS, DNS and the reverse proxy. Log shipping and monitoring.
- Pushing images to a registry, and pulling both tags from one.
- Rotating `WABA_ENC_KEY` or the backup passphrase.
