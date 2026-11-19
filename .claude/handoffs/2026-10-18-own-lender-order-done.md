# Own-lender debt order — DONE (2026-10-18)

Closes `2026-10-18-own-lender-order-goal.md`. PR #186, head 860d1400, queued via `mq add 186`.

## What shipped
- `loadOwnLenderDebts`: `orderBy [{startDate},{reference}]` (loans) and `[{approvedAt},{reference}]` (approved apps).
- Tiebreaker is `reference`, not `id`: the planner walks `Loan_tenantId_id_key`, so ties already came back in id
  order and an id tiebreaker could not be proven red. `reference` is @unique and no app code updates it.
- Two new RUN_DB_IT tests (loan tie, approved-application tie). Ids and write order both run opposite to the
  references. The app siblings are written with `SET LOCAL session_replication_role = replica`, because PASQ
  evidence binds one application. Line 112 fixture: PENDING_WRITE_OFF starts a month later.

## Evidence
- Red without the fix: 3/3 runs. Each tiebreaker removed on its own → only its own test red.
- Own-lender suites green 5× in a row. tsc 0; lint 0 errors (1 pre-existing warning on main); full npm test
  20058 passed.
- `ci:full` run 1 green on 860d1400 (369 IT suites, 0 fail). Only one run.
- Blind review rev-186: APPROVED, 3 LOW, all reconciled on the PR.

## Fingerprint answer (in PR body)
- Totals are order-invariant, so `inputFingerprint` and `ownLenderDebtIncreasedSinceApproval` were never affected.
- The debt fingerprint differed only when a by-name declaration partly covers tied loans. That could give a spurious
  409 between the approve request's two reads (fail-closed).
- No stored approval is re-fingerprinted: later gates use the recorded entries. So no §5 gate was triggered.

## Mentioned, not fixed
- `own-lender-debt-load.ts:34`: schedule `installmentNo` is not DB-unique, but it is unique by construction.
- `current-approval.ts:283`: the bureau check is picked by `createdAt desc`, which feeds the bureau fingerprint.

## Left to do
- #186 MERGED e62bb7d2; worktree + branch removed.

## 2026-10-19 — deployed to both demos
Tsela and Fair Score live on main 2d0370ef (includes #186), re-baked and restored; health commit, pages 200, 11 asset-finance templates each. Nightly 02:30/02:45 restores have new-image snapshots. The 17:03 switch planned in 2026-10-16-fairscore-audit-fixes-progress.md is superseded — do not run it.
