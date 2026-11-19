# /goal — Learning loop follow-ups: 6 open items after #225/#226/#228 (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-23-learning-loop-followups-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§10) or a genuine external blocker. Loop until every Success Criterion (§9) is proven with evidence, then publish the evidence, open the PRs, write a handoff and stop.`

## 1. Mission

Close the follow-ups the blind reviews of the learning loop (decision log A #225, outcomes B #226,
dashboard C #228, all merged 2026-10-23) left open. "Built" means: real Postgres enforcement where
the rule is a database rule, a `RUN_*_IT` integration test that goes red when the code is reverted
(mutation-verified), RBAC and audit on every new route, UI where a person needs to act, and a
logged-in browser check with screenshots on an evidence page. No mock data, no stand-ins. Each
part lands as its own PR through `mq add`, after a blind `/review`.

## 2. What already exists — do NOT redo

- `main` at `f4869741` (Merge #228). Learning loop code: `lib/learning-loop/` (read its `.claude.md` first),
  design `docs/learning-loop/DESIGN.md` (§2.3 stored free text, §2.7 retention proposal, §9 legal).
- Table `CreditDecisionRecord`: append-only (trigger refuses UPDATE/DELETE/TRUNCATE), RLS forced, CHECKs
  incl. "overrideReason present exactly when overridden" — migrations
  `prisma/migrations/20261021090000_credit_decision_record/`, `20261021100000_decision_record_automated_refusal/`,
  `20261023090000_decision_record_purge_link/`. Static pins: `lib/learning-loop/migration.test.ts`;
  real-DB: `lib/learning-loop/decision-log.integration.test.ts` (`RUN_DECISION_LOG_IT`).
- Outcomes: `DecisionOutcome`, nightly job `lib/learning-loop/outcomes/job.ts` via `app/api/cron/decision-outcomes/route.ts`
  (registry `lib/registry/cron-jobs/140-decision-outcomes.ts`), reader `outcomes/credaflow-adapter.ts`, writer `outcomes/writer.ts`
  (orphan sweep now skips a run that attributes nothing). IT: `outcomes/outcomes.integration.test.ts` (`RUN_DECISION_OUTCOMES_IT`).
- Dashboard: `app/(dashboard)/reports/decision-performance/{page,tables}.tsx`, loader `lib/learning-loop/dashboard/loader.ts`,
  IT `lib/learning-loop/dashboard/dashboard.integration.test.ts` (`RUN_DECISION_DASHBOARD_IT`). Permission
  `view_decision_performance` (`lib/registry/permissions/070-learning-loop.ts`), ADMIN/SUPER_ADMIN.
- Automated refusals: `lib/learning-loop/submission-refusal.ts` (`recordSubmissionRefusal`; non-strict path
  catches, `console.error`s and writes the audit row alone). Callers: `app/api/portal/applications/route.ts`,
  `app/api/website/apply/route.ts`.
- DSAR: requests only, no data export. `app/api/dsar/route.ts`, `app/api/dsar/[id]/route.ts` (ADMIN, PATCH status),
  page `app/(dashboard)/compliance/dsar/page.tsx`, client `components/compliance/DsarClient.tsx`, model
  `DataSubjectRequest` (has `clientId`). Audit actions `lib/registry/audit-actions/250-complaints-dsar-branches.ts`.
- Dealer draft purge already treats `CreditDecisionRecord.clientId` as a link (keeps the person); don't undo it.
  Test teardown of tables holding decision records deletes under `session_replication_role = replica`.
- No logger module exists (`console.error` is the repo's precedent in `lib/audit.ts`, `lib/ops/tenant-sweep.ts`).
  Don't build a logging framework for this goal.
- Merge queue: `/home/hein/Workspace/merge-queue` (bun/TS, local git, branch `master`, no remote), live as
  user unit `merge-queue.service`, config `~/.config/merge-queue/config.json` (required checks `quality`, `integration`).

### 2a. Product decisions (made by Hein, 2026-10-23)

1. **Retention: build it, off by default.** A per-lender retention setting with **no default**: nothing is
   pseudonymised until a lender sets a period. The pseudonymise job exists and is tested. DSAR export of
   decision records ships now.
2. **Refusal-record failure: durable trace, not fail-closed.** The applicant is still refused normally; the
   failure writes an audit row (new audit action) and the dashboard's POPIA s71 panel shows a count.
3. **Subject consistency: insert-time database trigger.** On INSERT, every non-null subject id must exist
   under the same `tenantId`. Insert-only, so later erasure of a parent is not blocked.

## 3. Part 1 — DSAR export of decision records (PR 1)

"Real": an ADMIN on a DSAR detail can download every `CreditDecisionRecord` whose subject is that request's
client (by `clientId`, and by `applicationId`/`loanId` of that client's applications/loans), including
`overrideReason`, as JSON (and CSV if cheap) [agent decides format].
- Route `GET /api/dsar/[id]/decision-records`: `requireApiRole("ADMIN")` like the sibling route, tenant from
  the session, the DSAR must belong to the tenant (404 otherwise), audited via `lib/audit.ts` (new action in a
  new `lib/registry/audit-actions/` file, not a line in a shared list), and the export written as an access event.
- UI: a button on the DSAR detail in `DsarClient.tsx` that downloads it. The page must not crash on a client
  with zero records.
- DESIGN.md §2.3: replace "neither … a DSAR export covers this table" with what now exists.
- Tests: route unit test (RBAC, cross-tenant 404, audit called); `RUN_DECISION_LOG_IT` case: two tenants, the
  export holds only the DSAR's client's rows from its own tenant.

## 4. Part 2 — Retention: per-lender period + pseudonymise job (PR 2)

- Setting: `TenantConfig.decisionRecordRetentionMonths Int?` (null = off). Editable only by SUPER_ADMIN in a
  TOTP-verified session (follow the `requireStaffTotp` pattern, `lib/security/staff-totp-policy.ts`), audited.
  Settings UI next to the lender's other compliance settings [agent finds the page].
- Clock [agent verifies against the schema and states it in DESIGN.md]: a declined/refused decision ages from
  `decidedAt`; a decision on an application that became a loan ages from the loan's termination
  (settled/written off/cancelled timestamp — check which fields exist); open loans never age.
- Job: nightly cron (new registry file in `lib/registry/cron-jobs/`, `CRON_SECRET`, `sweepActiveTenants`).
  Pseudonymise = set `applicationId`, `loanId`, `clientId`, `leadId`, `actorUserId`, `overrideReason` to NULL
  and stamp a new `pseudonymisedAt`. Aggregate columns (bands, recommendation, ruleVersion, outcomes) stay.
- Database: the append-only trigger must keep refusing every other UPDATE. Allow exactly this transition and
  nothing else, e.g. a `SECURITY DEFINER` function the job calls that sets a transaction-local flag the trigger
  checks, and the trigger also verifies only those columns change, only to NULL, and only once
  (`pseudonymisedAt` null → set) [agent decides mechanism; the IT proves the rest is still refused]. The CHECK
  "reason present exactly when overridden" must allow a pseudonymised overridden row with no reason.
  Hand-written SQL, new migration, update `migration.test.ts` / `lib/db-baseline.test-helpers.ts` as needed.
- Outcomes and dashboard must keep working on pseudonymised rows (they join by decision id, not subject).
- Tests (`RUN_DECISION_LOG_IT`): off by default (nothing changes); with a period set, an aged decline and an
  aged terminated-loan decision are pseudonymised, an open loan's and a young one's are not; a direct UPDATE of
  any other column, or of these columns outside the function, is still refused; a second run is a no-op.

## 5. Part 3 — Refusal-record failure leaves a durable trace (PR 3)

- In `recordSubmissionRefusal`'s non-strict catch: still `logAudit` the original refusal, and also write an
  audit row with a new action (e.g. `DECISION_RECORD_WRITE_FAILED`, new registry file) carrying tenant,
  channel, refusal reason and subject id — never the error's personal data.
- Dashboard s71 panel (`AutomatedRefusalList` area): "N refusals could not be recorded in the decision log"
  when N > 0, linking to the audit log filtered by that action if such a filter exists [agent checks].
- Tests: unit test that forces `recordDecisions` to throw and asserts both audit rows; dashboard loader IT
  counts the failures per tenant only.

## 6. Part 4 — Subject consistency trigger (PR 4)

- New migration: `BEFORE INSERT` trigger on `CreditDecisionRecord` refusing a row whose non-null
  `applicationId` (LoanApplication), `loanId` (Loan), `clientId` (Client), `leadId` (Lead) does not exist with
  the same `tenantId`. Clear error message naming the column. Insert-only: no FK, so DSAR erasure of a parent
  is unaffected.
- Before writing it, enumerate every writer (`grep -rn "recordDecisions\|creditDecisionRecord.create" app lib`)
  and confirm each passes ids that exist in-tenant at insert time (e.g. the website-apply lead/client rollback
  path, asset-finance deals). A writer that would now be refused is fixed in the same PR (CLAUDE.md: an
  enforcement migration ships with its code).
- IT: each of the four columns, other-tenant id refused, unknown id refused, own-tenant id accepted; every
  existing `RUN_*_IT` suite that writes decision records still passes (`npm run ci:full`).

## 7. Part 5 — Bound the nightly outcome read and the dashboard loader (PR 5)

[agent decides the design; these are the constraints]
- `credaflow-adapter.ts`: don't re-derive a loan whose every window is final and whose rows carry the current
  `OUTCOME_DEFINITION_VERSION`; read arrears snapshots per chunk bounded below by the earliest window start
  still needed; page the decision-record read. Idempotency and the existing ITs must still hold.
- `dashboard/loader.ts`: no unbounded all-time read per request. Either bound by the selected window or read
  a nightly rollup [agent decides]; numbers must equal today's for the existing IT fixtures.
- Prove it: an IT or benchmark script with a synthetic book (≥ 2,000 loans, 400 days of snapshots) showing
  query count/time before and after; record the numbers in the PR.
- Minor, same PR: the cohort "Not yet computed" column assertion should target the header cell
  (`page.test.tsx`), and the arrangements line gets the visible "(few loans)" marker like the tables.

## 8. Part 6 — Docs and tooling (PR 6, plus a merge-queue branch)

- `lib/learning-loop/.claude.md` (keep it short) + DESIGN.md: tenant offboarding — a tenant with decision
  records can't be deleted (RESTRICT FK + append-only); the only path is a deliberate operator step under
  `session_replication_role = replica`, audited. Write the runbook step; no code path.
- Merge queue (`/home/hein/Workspace/merge-queue`, branch from `master`): `classify` (`src/gh.ts`) counts
  `skipped` as failure and reads the latest run per required check, so a PR pushed while draft is ejected when
  queued before its post-ready aggregate `integration` job runs (seen 3× on #225, 2026-10-23). Fix: ignore a
  `skipped` run when a later run of the same check exists or is queued for that head, or treat the head as
  pending while any workflow run for it is in progress [agent decides]; a test in `test/` reproducing the #225
  sequence that is red before the fix. `bun test` green. **Do not restart the service or merge to master** (§10).

## 9. Success criteria

For each of Parts 1–5:
- [ ] Real-PG `RUN_*_IT` test(s) pass and go red when the production change is reverted (state the mutation)
- [ ] `npm run ci:full` green on the branch (re-run once on a timeout under load; report both)
- [ ] Blind `/review` (fresh agent, diff + CLAUDE.md only); every HIGH fixed and reconfirmed; MEDIUMs fixed or
      disputed with evidence in a PR comment
- [ ] Parts 1, 2, 3: logged-in browser check against a seeded local DB (ADMIN; SUPER_ADMIN for the retention
      setting), screenshots of: DSAR export downloaded and its content; retention setting saved + job result;
      s71 panel showing a failure count
- [ ] PR marked ready **before** pushing (draft pushes leave skipped checks that eject in mq), GitHub CI green,
      then `mq add`, merged
Part 6: docs merged via mq; merge-queue branch with a red-then-green test, `bun test` green, left unmerged.
Final: one evidence page (Artifact) with the screenshots and mutation results; handoff written.

## 10. Confirmation gates — STOP and ask Hein

- Restarting `merge-queue.service` or merging the merge-queue branch to `master`.
- Setting a retention period on any non-throwaway tenant, or running the pseudonymise job against the demo
  stacks (Tsela, Fairscore on velo-server). Throwaway IT/local DBs are fine.
- Any change to NCA document wording or `lib/pdf/*`.
- Any production deploy (none exists; don't create one).
- Re-pinning NCA render hashes.

## 11. Working rules

- One worktree per PR under `/home/hein/Workspace/CredaFlow-wt/`, `npm ci --legacy-peer-deps` in each; remove
  the worktree after merge. PRs touching `CreditDecisionRecord` migrations (2, 4) land sequentially (rebase on
  the first); the rest can run in parallel.
- Integration DBs only via `scripts/it-db.sh up cf-it-<unique>` + `check`; tear down with `docker rm -fv`.
- After merging main into a branch, re-run the whole unit suite: main's schema tests (e.g.
  `lib/dealer/purge-schema.test.ts`, `lib/__tests__/tenant-scope.test.ts`) catch new columns and models.
- Audit every state change through `lib/audit.ts`; new registry entries as new files, never a line in a shared list.
- Synthetic data only.
