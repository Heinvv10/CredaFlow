# Handoff — 2026-10-16 06:25 SAST (credaflow-4c)

**Goal of the session:** land #80, settle the #80 KYC leftovers, fix the CI flakes, redeploy demo + Fairscore.
**Follows:** `.claude/handoffs/2026-10-15-0542.md` (that work is now closed).

## Done
- **#80 merged** (8a548c1d, 05:57 on 2026-10-15).
- **#99 merged:** test flakes.
  - The lender lock-wait test held the lock for a fixed 4 s and checked after 400 ms. It now waits for a `locked` line from flock and holds the lock until the test ends.
  - Specimen byte-identity (60 s), seed password IT (120 s) and the three `locks` tests (30 s) got budgets sized to CPU-bound work.
  - `ci:full` passed twice in a row.
- **#102 merged:** the #80 leftovers, with Hein's decisions.
  - **(b)** An ID copy byte-identical (same `contentSha256`) to the newest verified copy is not a replacement.
  - **Hidden-copy rule:** ANY unreviewed, unrefused, non-deleted ID copy created after the newest verified copy holds the client PENDING. This replaces newest-only. TS (`lib/kyc/id-replacement.ts`) and SQL (migration `20261015130000_identical_id_reupload_not_replacement`) change together. Hein approved the migration.
  - **(a)** Staff hint plus a **Re-verify ID** button → `POST /api/clients/[id]/kyc-rederive`. It is **re-derive only**: it leaves the copy's `verifiedAt`/`verifiedById` alone, returns 409 under the evidence lock if the copy was refused or isn't the newest verified one, and writes the audit action `KYC_STATUS_REDERIVED`.
  - **(c)** Old writers return 500 during a deploy. Accepted.
  - Three review rounds (Opus reviewer + Opus breaker). Checked in a browser on a local stack: the status card updates without a reload.
- **#117 queued (mq):** tests only. They pin the sim env that the signing-OTP email needs (`UNSUB_TOKEN_SECRET` and `DEMO_MODE`). Passed blind review (SHIP) and CI.
- **Worktrees:** removed the 6 that Hein confirmed, plus the combo-80-88 scratch worktree.
- **Main checkout repaired:** something moved `refs/heads/main` to 350c93c8 without updating the index or files, so a commit there would have reverted ~10 PRs. Fixed by repointing it to b859d664 and then running `merge --ff-only`. Cause unknown.

## Deploys
- **Fairscore is live on `credaflow:fairscore-9165dbde`** (upgrade-stack.sh, 2026-10-15 20:27).
  - 45 migrations applied. Backup: `CredaFlow-fairscore/backups/pre-9165dbde-20261015T182727Z.dump`.
  - The first attempt was refused because the running app lacked `UNSUB_TOKEN_SECRET`, which is in the shared `secrets.env`. I recreated app and portal on b7b9fa9a, then upgraded.
  - KYC data steps: 0 clients demoted (no `migration@…` audit rows).
  - Staff TOTP: 0 enabled, `requireStaffTotp=false`.
- **Fairscore has no bake on the new image,** so the 02:45 restore fails with an image mismatch. Hein said "leave it". credaflow-52 (the Fairscore session) plans a watched bake on fairscore-9165dbde.
  - **Trap:** bake from a checkout that contains 362697d4 (#115) and f9573252. A 9165dbde checkout fails every persona at signing with `/api/signing-otp → 502`.
- **demo.credaflow.com now runs Tsela** (`credaflow:tsela-56c4863b`). Another session switched it around 19:55 on 2026-10-15. Hein: **keep Tsela**; no Acme switch.
  - The Acme image `credaflow:demo-bc4e9325` is built and kept, but has no bake. Its build worktree is `/home/hein/Workspace/CredaFlow-demo-build-bc4e9325`.
  - Hein chose not to pre-bake Acme.
- **Migration NOTICE counts:** only `20261014120000` raises a NOTICE, and Prisma `migrate deploy` doesn't print NOTICEs. On Fairscore, an audit-row count stands in for it: 0. A demo switch restores a snapshot, so data steps never run against live demo data.

## Follow-ups (not built)
- **Selfie after an identical re-upload:** the selfie binds to the unverified twin and fails (`lib/kyc/biometric-evidence.ts:533-564`).
- **Identical copy in the staff checklist:** it shows as Pending with Verify, and verifying it moves the evidence. Product decision needed.
- **Hidden ID copies:** a different ID uploaded before an identical copy is now held PENDING. The checklist already points at it.
- **ADMIN can't see the KYC checklist:** `lib/document-auth.ts` `STAFF_ROLES` omits ADMIN (predates this session).
- **Badge mismatch:** the top KYC badge reads "VERIFIED IN PERSON" while the stored status is PENDING. Confusing.
- **Manual PENDING:** a deliberate manual PENDING can be undone with the hint button (audited).
- **No DB CHECK against "verified and refused":** no app path writes that state.
- **Re-derive test gaps:** BIOMETRIC provenance, and the stored status not being PENDING.
- **`scripts/demo/restore.test.ts`:** timed out once at 5 s, a likely flake.
- **Bake preflight:** check `DEMO_MODE` and `UNSUB_TOKEN_SECRET` up front, so a bad env fails in seconds, not after 70 min.
- **Acme runner `.env.demo-sim`:** still on slug `tsela`. The 1 Nov monthly Acme bake will fail unless that's intended.
- **Cleanup when convenient:**
  - image `credaflow:demo-9165dbde` and worktree `/home/hein/Workspace/CredaFlow-demo-build-9165dbde`
  - this session's agent worktrees under `.claude/worktrees/` (agent-a52b8faa…, agent-a60a7b06…, agent-a085147e…, agent-a70b97dd…), all merged or empty
- **GitHub Actions billing** failed once more (~08:40 on 2026-10-15); it is intermittent.

## Where to resume
`mq status` — confirm #117 merged. Then the Fairscore bake (credaflow-52), or decide where the Acme demo lives now that Tsela holds demo.credaflow.com.
