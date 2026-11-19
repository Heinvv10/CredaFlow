# Handoff — Fairscore re-bake (2026-10-13 21:18 SAST)

**Status: paused by Hein ("Re-bake tomorrow").** Two sessions worked on the Fairscore stack tonight. Merge the two plans before anyone touches it again.

## Done
- **PR #49 merged** (`7641214`). It adds `DEMO_LENDER` (`prisma/demo-lender.ts`, profiles `acme` (default) and `fairscore`). Everything that hardcoded Acme now follows the profile:
  - the base and staging seeds;
  - the simulator staff, persona and mailbox emails, the inbox and CRM copy, and the bureau name;
  - `fresh-stack.sh` and `bake.sh`;
  - `build-image.sh`, which tags `credaflow:<lender>-<sha>`.

  `DEMO_LENDER_LOGO` uploads the logo through the audited route during the bake. `restore.sh` now refuses a snapshot whose `tenantSlug` differs from `NEXT_PUBLIC_TENANT_SLUG` in `$LIVE_DIR/.env`. The Acme default is pinned by tests; Acme's existing snapshots carry `tenantSlug: "acme"`.
- **PR #61 merged** (`b43ea9c`). Credit checks v1 (#54) blocks approval while flags are open, and the specimen statements always raise `DOCUMENT_AUTHENTICITY/PRODUCER_UNEXPECTED`.
  - The simulator now clears open flags before every decision.
  - The kit stories gain a Clear step.
  - Hein chose this: the clear route accepts a password-only session only when `DEMO_MODE` and `DEMO_CLEAR_STAFF_TOTP` are both exactly `true`. The audit row records `twoFactor: waived`. Without #61, no build containing #54 can be approved in a TOTP-free demo, and that includes **Acme's next bake**.
  - The blind review's LOW findings are on PR #61 as follow-ups.
- Fairscore logo saved at `~/credaflow-fairscore-data/branding/fairscore-logo.png` (sha256 `b16ab1dc…`).

## Not done (the original task's steps 4–10)
- No Fairscore snapshot exists. The first bake was on `7641214` and was stopped by me at 19:58 (exact PGID, 0 vLLM restarts) because the credit checks blocked approvals.
- The stack was not switched by this session, no cron line was added, the kit was not rebuilt, and nothing was verified.

## The collision
- Session `bb7f455a`, approved by Hein at 19:49, upgraded Fairscore to `credaflow:fairscore-6d18489` with slug **acme**.
  - It renamed data in place, with a DB backup and 7 migrations.
  - It reset `TENANT_HOST_MAP`/`NEXT_PUBLIC_TENANT_SLUG` to `acme`, because my 19:51 slug edit made both hosts return 500 after its recreate.
  - It is building `scripts/demo/upgrade-stack.sh`, which puts Fairscore on the Acme demo's commit.
- Fairscore **works now**: `6d18489`, slug `acme`, data renamed.
- **To decide:** `upgrade-stack.sh` assumes slug `acme`; the re-bake makes the slug `fairscore`. Pick one model, and make the upgrade script check the snapshot slug the way `restore.sh` now does.

## State left on disk
- `~/Workspace/CredaFlow-fairscore-runner`: detached at `b43ea9c`, with node_modules. `.env.demo-sim` is Fairscore's: slug `fairscore`, host map `localhost=fairscore,127.0.0.1=fairscore`, public origins `https://fairscore.credaflow.com`.
- `~/Workspace/CredaFlow-fairscore/.env.production` still has my `DEMO_CLEAR_STAFF_TOTP=true` and `EMAIL_INTERNAL_DOMAINS=fairscore.example`. They take effect on the next recreate. The originals are in `~/credaflow-fairscore-data/env-backups/*.pre-rebake-20261013T195122`.
- Image `credaflow:fairscore-7641214` (lacks #61). The `b43ea9c` image is not built; `build-image.sh` refuses while the Fairscore `.env` slug is `acme`.
- The sim stack `credaflow-demo-sim` holds the aborted Fairscore bake's partial data (not live; the next `fresh-stack.sh` wipes it).
- Worktrees `CredaFlow-lender-identity` and `CredaFlow-demo-clear-checks`: both merged, removable.
- Acme (`credaflow-demo`, runner, crontab) was not touched.

## Re-bake recipe, once the plan is agreed
```bash
cd ~/Workspace/CredaFlow-fairscore-runner      # move to main first: git checkout --detach origin/main && npm ci --legacy-peer-deps
export DEMO_LENDER=fairscore DEMO_DATA_DIR=~/credaflow-fairscore-data \
  LIVE_DIR=~/Workspace/CredaFlow-fairscore DEMO_LIVE_PROJECT=credaflow-fairscore \
  DEMO_LENDER_LOGO=~/credaflow-fairscore-data/branding/fairscore-logo.png SIM_VLM_RETRY_BACKOFF_MS=60000,120000,240000
# Fairscore .env NEXT_PUBLIC_TENANT_SLUG=fairscore (build arg), then:
scripts/demo/build-image.sh                    # → credaflow:fairscore-<sha>
# after 17:00, in setsid + a watcher on `systemctl show vllm-qwen -p NRestarts`:
scripts/demo/bake.sh --image credaflow:fairscore-<sha>
# switch: APP_IMAGE/GIT_SHA in .env, TENANT_HOST_MAP=…=fairscore in .env.production, up -d --no-deps app app-portal, then
scripts/demo/restore.sh
```
Cron, to add after a proven restore (back up the crontab first):
`45 2 * * * DEMO_LENDER=fairscore DEMO_DATA_DIR=/home/hein/credaflow-fairscore-data LIVE_DIR=/home/hein/Workspace/CredaFlow-fairscore DEMO_LIVE_PROJECT=credaflow-fairscore /home/hein/Workspace/CredaFlow-fairscore-runner/scripts/demo/cron-run.sh restore`

Notes:
- The bake retires the SUPER_ADMIN operator: it is inactive and has no login. "Clear SUPER_ADMIN TOTP" is therefore moot unless Hein wants an active operator login in the public demo, which also holds ADMIN_SECRET.
- `bake.lock` lives in each `DEMO_DATA_DIR`. The sim stack is one per host, so never bake Acme and Fairscore at once.
