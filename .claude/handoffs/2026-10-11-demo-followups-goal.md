# /goal — CredaFlow demo follow-ups: 9 work items onto the PR stack (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-11-demo-followups-goal.md to completion. Work autonomously through Transplant -> Build (TDD) -> Review -> Fix loops for each item in section 4, in order. Do not stop to ask, except at a Confirmation Gate (section 6) or a genuine external blocker. Loop until every Success Criterion (section 5) is proven with evidence, then open the PRs, write a handoff and stop.`

Read first: `.claude/handoffs/2026-10-11-0518.md` (this session's handoff), `.claude/handoffs/2026-10-10-1900.md` (the PR stack), `CLAUDE.md`, and `docs/plans/2026-10-10-demo-simulator.md` on branch `demo/simulator`.

---

## 1. Mission

Land the work of 2026-10-09..11 on the pushed history and close what it exposed. Nine items: two transplants of finished, reviewed branches; one blocker bug in the borrower portal; a dedicated face-comparison model for the selfie check; three security bugs; a clean checkout for the demo's scheduled jobs; and a rebuild of the public demo on the result. "Done" for a code item means: real database behaviour proven by a test that fails when the code is wrong, a blind review and (for security and KYC) an adversarial breaker both returning SHIP on the final commit, CI green on its PR, and — where a screen changed — the screen loaded in a browser with a screenshot. Nothing is merged; Hein merges the stack.

## 2. What already exists — do NOT redo

- **Pushed history:** `origin/main` = one orphan commit `51c387e`. PRs #1-#5 and #8-#23 are stacked on it, none merged, each based on the previous one's branch. Top of the stack: branch `fix/credit-life-premium-rounding` (PR #23, `3fb0cdf`, CI green). Migrations on the top of the stack end at `20261010180000_attach_credit_life_guards`.
- **Two finished local branches on FORK history (base `7161f81`) — never push them:**
  - `fix/selfie-face-match` at `d1d1d38`, worktree `/home/hein/Workspace/CredaFlow-facematch` (5 commits). Blind reviewer + adversarial breaker SHIP after 4 rounds. Wording approved by Hein.
  - `demo/simulator` at `d20ba50`, worktree `/home/hein/Workspace/CredaFlow-demo-sim` (8 commits). Five-reviewer team SHIP on `0c362f0`; `4d9ea1e`, `de0d42f`, `d20ba50` came after and are unreviewed.
- **Live demo:** `https://demo.credaflow.com` + `https://demo-staff.credaflow.com`, image `credaflow:demo-0c362f0`, compose + env in `/home/hein/Workspace/CredaFlow-demo` (untracked), data in `/home/hein/credaflow-demo-data/` (`secrets.env`, `snapshots/`, `kits/`, `logs/`). State: `bash scripts/demo/status.sh` in the demo-sim worktree. Staff logins change per bake: `snapshots/latest/.sim-credentials.txt` (never print them).
- **Cron (user hein):** `30 2 * * *` restore, `0 2 1-7 * *` bake `--first-sunday`, both `scripts/demo/cron-run.sh` from the `CredaFlow-demo-sim` worktree.
- **Gates on the stack:** `npx tsc --noEmit`, `npm run lint` (zero on the stack), `npm test`, `npm run build`, `npm run claude-md:check && npm run agents:check`, `bash scripts/run-integration-tests.sh` against a throwaway Postgres 16 (the known-failures register `scripts/integration-baseline.txt` is EMPTY on the stack — keep it empty). Workflows: `.github/workflows/{quality-gate,integration-tests,agent-docs,date-boundaries}.yml`.
- **Guards that must keep holding:** `lib/kyc/face-match-v2-evidence.integration.test.ts`, `lib/kyc/face-match-v2-migration.integration.test.ts`, `lib/kyc/vlm-face-match.test.ts`, `app/api/documents/selfie/route.test.ts`, `lib/config/demo-mode.test.ts`, `app/api/settings/bank-sync/route{,.integration}.test.ts`, NCA render pins (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`).

## 2a. Product decisions (already made — Hein, 2026-10-11)

1. New branches are based on the **top of the stack** and continue it as PR #24 onward, in the order of section 4.
2. The signing-packet bug is fixed on its own branch with blind review.
3. The selfie fix's borrower-facing wording is approved as written on `d1d1d38`.
4. A **dedicated face-comparison model** makes the same-person decision. Hein supplies consented test photos in `/home/hein/credaflow-demo-data/private/faces/<person>/{id.jpg,selfie.jpg}` (3+ people). If that folder is empty when item 4.6 starts, build and wire the model anyway, prove it on the presenter pair plus the negatives available, and report the different-real-person proof as the single open item — do not block.
5. The demo's scheduled jobs move to a **dedicated clean checkout**.
6. The three security bugs are in scope, each on its own branch.
7. Returning-client demo story skips re-upload, selfie and KYC verify (already in `d20ba50`).
8. Clients demoted by the selfie migration go to PENDING, and the un-verify step covers every v1 selfie, not only demoted clients (as built).

## 3. Rules for this run

- **Never push fork history.** Before every `git push`, run `git merge-base --is-ancestor 51c387e <branch>` and `! git merge-base --is-ancestor 7161f81 <branch>`; both must hold. Never push `fork/main`, `whitelabel/*`, `demo/simulator` or `fix/selfie-face-match` as they are.
- One worktree per branch (`git worktree add`), `npm ci --legacy-peer-deps` in each. Never `git add -A`. Never amend or force-push a branch with an open PR; follow-ups are new commits.
- The author never reviews. Every item gets a fresh blind reviewer (diff + CLAUDE.md only); KYC, auth and tenant-scope items also get an adversarial breaker working in its own `git clone --local` copy with written repro tests. Fix, then re-confirm with the SAME reviewer on the fix commit. Stop iterating and report if round N+1 finds as many issues as round N.
- Migrations: new files only, timestamps after the stack's latest; apply only to throwaway Postgres containers you start and remove, and to the sim/demo databases through `bake.sh`/`restore.sh`. A migration that adds enforcement ships with its code.
- No real personal data in the repo. Test faces and the presenter photo stay under `/home/hein/credaflow-demo-data/private/` and `scripts/demo/.private/` (gitignored); send them only to local models; never print or commit them; delete `private/faces/` copies you made when done.
- Never touch `/home/velo`. No broad process kills. No `docker ... prune`. The vLLM on `:8100` is shared with FibreFlow production: one request at a time, and check `systemctl show vllm-qwen -p NRestarts` does not rise during a bake.
- Subagent reports are not evidence — re-run the check yourself before recording it.

## 4. The nine items — what "real" means for each

### 4.1 Transplant `fix/selfie-face-match` -> new branch `fix/kyc-face-match-v2` (PR #24, base PR #23's branch)
Cherry-pick the 5 commits onto the top of the stack; resolve conflicts against what is there. **Migration:** rename `20261010150000_face_match_v2_evidence` to a timestamp after `20261010180000` and update every test that names it. It redefines `subject_has_composite_kyc` and `subject_has_manual_kyc_exception`: as of `3fb0cdf` no stack migration redefines either function (checked 2026-10-11), but re-check at transplant time (`grep` every migration after the baseline) and, if one does, rebase the new bodies on the latest ones — dropping a condition the stack added is a HIGH. Real: full unit suite, the two face-match integration suites and the whole `run-integration-tests.sh` green with an empty baseline register; a fresh blind review of the transplanted diff (conflict resolution is new code).

### 4.2 Portal signing-packet 404 -> `fix/portal-signing-packet` (PR #25)
On the client host the signing page's frame, "Open PDF in a new tab" and "Download agreement" return `{"error":"Not found"}`: `lib/proxy/shared-client-api.ts` does not allow `app/api/applications/[id]/signing-packet/route.ts`. The borrower signs a packet they cannot see. Real: the allow-list admits exactly that route for a CLIENT session; the route itself must prove the application belongs to the signed-in client and tenant (add the check if it relies on the proxy) and must log document access the way `lib/document-auth.ts` does; staff-only siblings stay 404 on the client host. Tests: proxy unit tests (allowed for CLIENT, refused for other clients' applications, refused unauthenticated), route test for ownership, each failing under mutation. Breaker: IDOR across clients and tenants. Browser: sign in as a seeded portal client on a local stack, open the signing page, screenshot the rendered packet.

### 4.3 Any admin-level user can create a SUPER_ADMIN -> `fix/user-role-ceiling` (PR #26)
`app/api/settings/users/route.ts` (and any update route beside it) has no role ceiling. Real: a caller can only create or promote to roles strictly below or equal to a ceiling derived from their own role, never SUPER_ADMIN unless they are SUPER_ADMIN; role changes are audited; TOTP-verified session required as for other identity writes. Find every writer of `User.role` (grep) and gate them all. Tests + breaker (role escalation by create, by update, by self-edit, via tenant mismatch).

### 4.4 `BreachLog` has no tenant scope -> `fix/breach-log-tenant-scope` (PR #27)
`app/api/compliance/breach-log/route.ts` and `[id]/route.ts` work across tenants; the model has no `tenantId`. Real: additive migration adding `tenantId` with a backfill that is safe on existing databases [agent decides the backfill; a database with breach rows and more than one tenant must fail loudly rather than guess], model enrolled in `lib/tenant-scope.ts`, routes scoped, every write audited. Integration test proving tenant A cannot list or edit tenant B's entry.

### 4.5 Complaints and DSAR skip the client-tenant check -> `fix/complaint-dsar-tenant-check` (PR #28)
`app/api/complaints/route.ts` and `app/api/dsar/route.ts` accept a `clientId` without checking it belongs to the caller's tenant, and their create/update paths (plus branch writes) write no audit rows. Real: ownership check on every write path, audit via `lib/audit.ts`, tests + breaker (cross-tenant clientId, missing audit).

### 4.6 Dedicated face-comparison model -> `feat/face-comparison-model` (PR #29)
Today one vision-language model answers "same person" and is unreliable (it said "same" at 0.85-0.90 against placeholder cards in 7 of 12 runs). Real: a face detector + face-embedding model decides same-person by embedding distance with a threshold; the VLM photo-kind and real-photograph gates stay; the check **fails closed** when the model is unavailable, finds no face, or finds more than one. [agent decides] the model and runtime, with two hard constraints: a licence that permits commercial use (record model, source and licence in `docs/`; InsightFace's pretrained packs are research-only — do not use them), and it must run on a lender's own box without a GPU (for example OpenCV Zoo YuNet + SFace through `onnxruntime-node`). Model weights are downloaded at build or first run from a pinned URL with a checksum, not committed if large. Provider tag bumps (v3) with the same evidence discipline as v2: TS gate in `lib/kyc/biometric-evidence.ts`, SQL gate in a new migration, old evidence handled explicitly. Evaluation matrix, each cell run 3+ times, kept outside the repo: presenter ID vs presenter selfie PASS; every person in `private/faces/` own-pair PASS and every cross-pair FAIL; silhouette / cartoon / blank / obscured cards FAIL. Threshold chosen from that matrix and documented with the observed distances. Blind review + breaker.

### 4.7 Transplant `demo/simulator` -> `feat/demo-simulator` (PR #30)
Cherry-pick the 8 commits onto the stack after 4.1-4.6. Known conflict areas: `/portal/register` (PR #12), lint-to-zero (PR #10), `tsconfig.json`, `.dockerignore`, `package.json`. The simulator must run on the new base: PRs #19 and #21 add validated CHECKs and the lead-conversion fix is present, so remove the simulator's workarounds that those PRs make unnecessary (leads parked at PROPOSAL_SENT, the arrangement first-payment workaround only if fixed) and adapt to the face-match v2/v3 evidence rules. Real: `npm run demo:typecheck`, `npx vitest run scripts/demo`, a full throttled bake passing all its checks, and a fresh blind review of the transplanted diff including the three unreviewed commits.

### 4.8 Dedicated checkout for the scheduled jobs
A clean worktree used only by cron (for example `/home/hein/Workspace/CredaFlow-demo-runner`, detached at the reviewed demo commit), with its own `node_modules` and the env/state files the scripts need; `scripts/demo/update-runner.sh` moves it to a named commit on purpose. Back up the crontab to `/home/hein/credaflow-demo-data/env-backups/`, change only the two `cron-run.sh` lines, remove nothing else. Real: `env -i ... cron-run.sh restore` from the runner succeeds against the live demo and `status.sh` reports it.

### 4.9 Rebuild the public demo on the result
Build the image from the top of the new stack, run one throttled bake, restore, rebuild the kits for the day, and repeat the dress rehearsal (headless Chromium, real UI) for the three personas — this time the borrower must SEE the signing packet (4.2) and the selfie must pass through the new model. Update the cheat sheets where the screens changed.

## 5. Success criteria

- [ ] 4.1: PR #24 open on the stack, CI green; integration register empty; blind review SHIP on its head.
- [ ] 4.2: PR #25; mutation-proven tests; breaker SHIP; screenshot of the packet rendered in the portal.
- [ ] 4.3: PR #26; every `User.role` writer gated; breaker SHIP.
- [ ] 4.4: PR #27; integration test for cross-tenant refusal; migration applies to a fresh DB and to a DB holding breach rows.
- [ ] 4.5: PR #28; ownership + audit proven; breaker SHIP.
- [ ] 4.6: PR #29; evaluation matrix recorded (verdicts and distances only, no personal fields); licence documented; fails closed proven by test; breaker SHIP. If `private/faces/` was empty: stated plainly as the one open item.
- [ ] 4.7: PR #30; full throttled bake green on the new base; vLLM `NRestarts` unchanged; blind review SHIP.
- [ ] 4.8: crontab points at the runner; one restore from it succeeded.
- [ ] 4.9: live demo on the new image; `/api/health` commit matches; three personas PASS with screenshots under `/home/hein/credaflow-demo-data/rehearsal/<timestamp>/`; kits rebuilt.
- [ ] No branch containing `7161f81` was pushed. Handoff written; `LATEST.md` updated with a pointer to any other open handoff.

## 6. Confirmation gates — STOP and ask Hein

- Merging any PR, or changing the base of PRs #1-#23.
- Any push where the fork-history check in section 3 does not hold.
- A migration that must drop or rewrite existing data beyond the demotion already built into the face-match migration.
- Choosing a face model whose licence is not clearly commercial-use, or one that needs a paid service.
- Anything touching Cloudflare (DNS, tunnel routes, tokens) — the permission classifier blocks it; ask Hein to do it.
- Deleting old demo snapshots, images or the `demo/simulator` / `fix/selfie-face-match` branches and worktrees.
- A conflict with the stack that cannot be resolved without changing what an earlier PR decided (for example PR #21's credit-life guards or PR #22's NCA layout).
