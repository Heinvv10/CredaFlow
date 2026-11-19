# Handoff — Fairscore native re-bake LIVE (2026-10-14 22:10 SAST)

Supersedes `2026-10-13-fairscore-rebake.md`. Hein: the slug "should be fairscore".

## Live
- fairscore.credaflow.com / fairscore-staff.credaflow.com: `/api/health` commit `fairscore-e91aac3` on both.
- Image `credaflow:fairscore-e91aac3` (main e91aac3: #49 DEMO_LENDER + #61 demo credit-check clear), slug `fairscore`, portal login URL baked in.
- Snapshot `~/credaflow-fairscore-data/snapshots/20261014T184333Z`: native DEMO_LENDER=fairscore bake, all checks passed (simulate, check-dates, ledger, 95/95 pages), 0 vLLM restarts. 32 loans, 53 applications, 55 clients.
- Restored with restore.sh (staff TOTP + 2FA policy off). Cron added: `45 2 * * *` Fairscore restore (Acme lines untouched; crontab backup in `~/credaflow-fairscore-data/env-backups/`). Proven with `env -i … cron-run.sh restore` (rc 0, 13.3 s).

## Verified
- Browser: Fairscore brand, tagline, NCR placeholder and the "Fairscore demo — all data shown is sample data" banner.
- Staff password-only sign-in → LOAN_ADMIN session, totpVerified false, /dashboard 200.
- Certificate of balance PDF: "Fairscore (Pty) Ltd", 0 'acme' hits.
- DB: every text/json column of every public table searched for 'acme' → 0 hits.
- Kit: `~/Downloads/credaflow-fairscore-demo-kit-2026-10-14/` (0700), 3 live personas, emails only @fairscore.invalid.

## Follow-ups
- **Host-wide bake lock: PR #94** (2026-10-15), blind review APPROVED on a18060e6, queued in the merge queue (`mq status`). bake.sh holds `~/.credaflow-demo-sim.lock`; cron bakes wait up to 3 h (DEMO_SIM_LOCK_WAIT). Also fixes a flaky "no Acme text" seed IT (cuid matched '%acme%'). The runners pick it up on their next update; the Fairscore runner is a detached checkout, move it to main after #94 lands.
- SUPER_ADMIN: the bake retires the operator (inactive, no login), so nothing to clear.
- Fairscore is on e91aac3; Acme is on b7b9fa9. Re-bake Fairscore after hours to reach parity (recipe below). Do not `upgrade-stack.sh` across a slug change.
- PR #61 LOW review findings still open as follow-ups.
- Removable: worktrees `CredaFlow-lender-identity`, `CredaFlow-demo-clear-checks`; images `credaflow:fairscore-6d18489`, `fairscore-7641214`; the stale 2026-10-13 kit (dir + zip) in ~/Downloads.

## Re-bake recipe (after 17:00, nothing else on the sim stack)
```bash
cd ~/Workspace/CredaFlow-fairscore-runner && git checkout --detach origin/main && npm ci --legacy-peer-deps
export DEMO_LENDER=fairscore DEMO_DATA_DIR=~/credaflow-fairscore-data LIVE_DIR=~/Workspace/CredaFlow-fairscore \
  DEMO_LIVE_PROJECT=credaflow-fairscore DEMO_LENDER_LOGO=~/credaflow-fairscore-data/branding/fairscore-logo.png \
  SIM_VLM_RETRY_BACKOFF_MS=60000,120000,240000
scripts/demo/build-image.sh                         # → credaflow:fairscore-<sha>
setsid scripts/demo/bake.sh --image credaflow:fairscore-<sha>   # watch vllm-qwen NRestarts
# .env APP_IMAGE/GIT_SHA → new tag; docker-compose -f docker-compose.demo.yml up -d --no-deps app app-portal
scripts/demo/restore.sh
DEMO_LENDER=fairscore DEMO_DATA_DIR=~/credaflow-fairscore-data npx tsx scripts/demo/kits/build.ts
```

## 2026-10-15 update
- PR #94 merged 07:31 SAST (merge-queue batch #100, 7eac61a3). Fairscore runner moved to main a9bb8e0d with update-runner.sh.
- Another session ran `upgrade-stack.sh` on Fairscore at 05:00 SAST: live is `credaflow:fairscore-b7b9fa9a` (slug fairscore, DB kept, backup `backups/pre-b7b9fa9a-20261015T025958Z.dump`). The e91aac3 snapshot no longer matches, so the 02:45 restore refuses it until a bake on fairscore-b7b9fa9a succeeds.
- A watched Fairscore bake on `credaflow:fairscore-b7b9fa9a` is scheduled for 17:05 SAST 2026-10-15 (queues on the sim lock up to 3 h). After it passes: restore.sh (or let the 02:45 cron do it), rebuild the kit.
- 17:10: cancelled that bake (it was only waiting on the sim lock). Hein asked credaflow-4c to move Fairscore to current main tonight (after the tsela and Acme bakes); I asked 4c to bake Fairscore on the upgraded image afterwards, or hand me the tag. Until a matching snapshot exists, the 02:45 Fairscore restore fails (live stays up, just isn't reset).
- 2026-10-16 06:25: credaflow-4c upgraded Fairscore to `fairscore-9165dbde` (2026-10-15 20:27) but no Fairscore bake followed; the 02:45 restore failed (image mismatch, LAST_FAILURE-restore). Runner moved to 9165dbde. Watched bake on credaflow:fairscore-9165dbde scheduled 17:05 SAST 2026-10-16, then restore.sh. demo.credaflow.com now serves "Tsela Lending" (`tsela-56c4863b`), not Acme — another session's change.
- 2026-10-16 06:40 (revised): 9165dbde can't be baked (pre-#115: signing OTP 502) and its image lacks #116 (no Chromium home → custom-template PDFs fail). Runner moved to origin/main c0b1aca5. Scheduled 17:05: build credaflow:fairscore-<sha> from the runner, watched bake on it; then (by hand) switch APP_IMAGE/GIT_SHA, `up -d --no-deps app app-portal` with DEMO_DATA_DIR exported (compose reads ${DEMO_DATA_DIR}/secrets.env), restore.sh, verify, rebuild kit. credaflow-4c and credaflow-08 leave Fairscore to this session; 08 owns Acme.
- 2026-10-16 06:30: Hein: "another agent is deploying". Cancelled my scheduled 17:05 Fairscore build+bake; nothing of mine is running or scheduled. Runner left at c0b1aca5 (clean). Fairscore still needs a snapshot on its live image or the 02:45 restore keeps failing.
