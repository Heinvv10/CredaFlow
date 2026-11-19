# /goal — Learning loop: 3 open items from the follow-ups (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-24-learning-loop-open-items-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§6) or a genuine external blocker. Loop until every Success Criterion (§5) is proven with evidence, then publish the evidence, open the PR, write a handoff and stop.`

## 1. Mission

Close the three items that `.claude/handoffs/2026-10-24-learning-loop-followups-done.md` left open:

- **A.** Record the decision to keep the 24-month dashboard cut. This is docs only.
- **B.** Have the database and the app enforce a 60-month minimum on the decision-record retention period.
- **C.** Merge the merge-queue `classify` fix and restart the worker safely.

"Built" for B means four things:

- a migration;
- the API and the UI refusing values under 60;
- a real-Postgres test that goes red when the floor is removed;
- a logged-in browser screenshot of the card refusing 59.

## 2. What already exists — do NOT redo

- **origin/main** at `fe423478` (#247 merged) or later. The local `main` checkout is stale, so work in a new worktree under `/home/hein/Workspace/CredaFlow-wt/` from `origin/main`, and run `npm ci --legacy-peer-deps` in it.
- **Retention is built and off by default** (DESIGN.md §2.7):
  - migration `prisma/migrations/20261023200000_decision_record_retention/migration.sql`;
  - CHECK `TenantConfig_decisionRecordRetentionMonths_range`, currently `IS NULL OR (>= 1 AND <= 600)`;
  - `lib/learning-loop/retention/policy.ts`: `RETENTION_MONTHS_MIN = 1`, `RETENTION_MONTHS_MAX = 600` and `isRetentionMonths`;
  - `app/api/settings/decision-record-retention/route.ts` and `.../preview/route.ts`;
  - `components/settings/DecisionRetentionCard.tsx`, which has the label "1 to 600" and `min={1}`.
- **Static pin:** `lib/learning-loop/migration.test.ts:82` pins the CHECK text.
- **Tests below 60 that must move to ≥60:**
  - `app/api/settings/decision-record-retention/preview/route.test.ts` uses `months: 24`;
  - `lib/learning-loop/retention/job.test.ts` uses `retentionMonths: 36`;
  - check `lib/learning-loop/retention/retention.integration.test.ts` for small periods too.
- **The dashboard cut:**
  - `DECISION_LOOKBACK_MONTHS = 24` at `lib/learning-loop/dashboard/loader.ts:62`;
  - it is described in DESIGN.md (around line 845) and in `lib/learning-loop/.claude.md:64`.
- **Merge-queue fix** in repo `/home/hein/Workspace/merge-queue`:
  - branch `fix/skipped-draft-checks`, in worktree `/home/hein/Workspace/merge-queue-wt-skipped`, head `fdab4be`;
  - `master` is at `0353907`;
  - blind review APPROVED, and `bun test` was 127/127;
  - the worker is the **user** unit `systemctl --user … merge-queue.service`.

## 2a. Product decisions (already made by Hein, 2026-10-24)

1. **Dashboard:** keep the 24-month cut. Don't build a setting or full history.
2. **Retention floor:** a minimum of **60 months**, matching FICA's five years, which is longer than the NCA regulations' three. The maximum stays 600, and null (off) stays allowed. A lender's legal team may still choose longer.
3. **Merge-queue fix:** merge it and restart the worker, **only while the queue is idle**.

## 3. The items

### A. Dashboard cut: docs only

- In DESIGN.md, near the `DECISION_LOOKBACK_MONTHS` paragraph, state that it was decided to keep the 24-month cut (Hein, 2026-10-24) and give the reason: bounded reads.
- Remove the item from any open-decision list in DESIGN.md.
- If you touch the `.claude.md`, run `npm run claude-md:check && npm run agents:mirror && npm run agents:check`.

### B. 60-month floor

**Migration:**
- Add a new hand-written migration whose timestamp is later than every existing one (check with `ls prisma/migrations | tail`).
- It drops the CHECK and re-adds it as `IS NULL OR (>= 60 AND <= 600)`.
- It aborts with a clear message when any `TenantConfig` row is in 1–59. Don't silently clamp: a clamp would change a lender's legal setting without an audit row. No tenant on any stack has a period set today.
- Put the rollback in comments, like the earlier migration does.
- This migration adds enforcement, so it ships in the same PR as the code.

**Code:**
- Set `RETENTION_MONTHS_MIN = 60`. The PUT and preview routes already return 422 through `isRetentionMonths` with the min/max in the message; check that.
- In the card: set `min={60}`, change the label to "60 to 600", and make it show the server's 422 message.

**Tests:**
- Update the static pin.
- Move fixtures below 60 up to ≥60.
- Add unit cases: 59 is refused, 60 is accepted, null is accepted.
- In the IT, raw SQL `UPDATE "TenantConfig" SET "decisionRecordRetentionMonths" = 59` must fail with 23514, and 60 must pass.

**Mutation:** put the CHECK back to `>= 1` and the IT must go red. Then restore it.

**Docs:**
- In DESIGN.md §2.7, write "CHECK 60..600" and explain why (the FICA five years; the NCA regulations' three years is the lower figure).
- Leave the existing "needs lender legal sign-off" sentence in place; it is still true for anything above 60.
- Update the handoff's open-decision line.

**Browser acceptance:**
- Use your own IT DB from `scripts/it-db.sh`, seeded, with `npm run dev` on a free port.
- Log in as a SUPER_ADMIN, with `requireStaffTotp` off in the throwaway DB only.
- On Settings → Security & KYC policy, enter 59. The card must refuse it and show the error. Then 60 must save.
- Take full-page PNGs of both states.
- Kill the dev server by its exact PID, and tear down with `docker rm -fv`.

### C. Merge-queue fix

1. In `/home/hein/Workspace/merge-queue-wt-skipped`, rebase on `master` if it has moved, then run `bun test` and expect it all green. The repo has no remote and no CLAUDE.md, and `master` has linear history.
2. Fast-forward `master`: in `/home/hein/Workspace/merge-queue`, run `git merge --ff-only fix/skipped-draft-checks`. This is Hein's approved exception to "never commit to master", for this branch only. Run `bun test` on `master` again. The unit runs `bun run /home/hein/Workspace/merge-queue/src/daemon.ts` straight from this checkout, which is on `master` and clean. So the fast-forward changes nothing until the restart, and the restart picks it up.
3. **Idle check:** `mq status` must show no batch building or in CI, and `journalctl --user -u merge-queue.service -n 50` must show no merge in progress. If the queue is busy, wait for it to drain; use Monitor with an until-loop, not sleep polling.
4. Restart with `systemctl --user restart merge-queue.service`. Then check that `systemctl --user status` reports active and that the journal shows a clean start.
5. **Proof:** the next PR that goes through the queue, which is item B's PR, merges through the restarted worker. Quote its `mq log` lines.
6. Remove `merge-queue-wt-skipped` and its local branch after the merge.

## 4. Process

- Branch `feat/ll-retention-floor`; never commit to main.
- Run `npm run ci:full` locally before pushing.
- Open a PR, run a blind `/review`, and run a security review.
- Merge only through `mq add <pr>`.
- Integration DBs only through `scripts/it-db.sh` with a unique name and `check`, torn down with `docker rm -fv`.
- Use synthetic data only.
- Remove the worktree after the merge.

## 5. Success criteria

- [ ] **A:** the DESIGN.md decision text is merged; `claude-md:check` and `agents:check` are green if a `.claude.md` was touched.
- [ ] **B:** the migration applies on a fresh IT DB. The 59 → 23514 IT is green, and the mutation (`>= 1`) is red. Unit tests cover 59, 60 and null. `ci:full` is green, blind review approved, security review clean, and the PR is merged through mq.
- [ ] **B:** browser screenshots exist of 59 refused and 60 saved.
- [ ] **C:** `master` contains the fix, the worker restarted while idle and reports active, B's PR merged through it (with `mq log` quoted), and the worktree is removed.
- [ ] The evidence page is published (screenshots, mutation output, `mq log`), and the handoff `2026-10-24-learning-loop-open-items-done.md` is written. `LATEST.md` and memory are updated.

## 6. Confirmation gates (stop and ask Hein)

- Setting a retention period on any non-throwaway tenant, or running the pseudonymise job against a demo stack (Tsela, Fairscore).
- Any production deploy, or re-baking the demos.
- Restarting `merge-queue.service` while a batch is in flight. Never do it; wait instead.
- Any change to NCA wording or `lib/pdf/*`.
- A legal-floor value other than 60, if a reviewer argues for one. Report it; don't change it.
