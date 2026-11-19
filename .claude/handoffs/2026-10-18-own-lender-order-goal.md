# /goal — Own-lender debts: make the load order total (1 small fix, run autonomously until DONE)

> **How to use:** start a fresh session in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-18-own-lender-order-goal.md to completion. Work autonomously through Spec → Build (TDD) → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§5). Loop until every Success Criterion (§4) is proven with evidence, then queue the PR with mq, write a handoff and stop.`

## 1. Mission

`loadOwnLenderDebts` (`lib/affordability/own-lender-debt-load.ts`) does not return loans in a fixed order, so the
integration test is flaky. Make the order total and deterministic, prove it with a real-Postgres test that fails
without the fix, and ship one small PR.

## 2. What already exists — do NOT redo

- **The flake:** `ci:full` run 1 on PR #180 (2026-10-18) failed at
  `lib/affordability/own-lender-debt.integration.test.ts:112`. The test expected `[activeRef, pendingRef]` and got
  them swapped. Run 2 was green.
- **Root cause:** the two queries in `loadOwnLenderDebts` order by a column that is not unique:
  - `db.loan.findMany(... orderBy: { startDate: "asc" })`
  - `db.loanApplication.findMany(... orderBy: { approvedAt: "asc" })`

  The test's `bookLoan` gives every loan the same `startDate` (2026-04-17), so Postgres may return tied rows in any
  order.
- **Why it matters beyond the test:**
  - `withOwnLenderDebts` (`lib/affordability/own-lender-debt.ts`) says it is pure "so a fingerprint over them is
    reproducible".
  - Its output feeds the affordability inputs, and `affordabilityInputFingerprint` is in
    `lib/affordability/snapshot.ts`.
  - Two real loans or approvals with the same start or approval time could therefore order differently between reads.
  - Verify whether that can change a stored or recomputed fingerprint or `ownLenderDebtIncreasedSinceApproval`, and
    state the answer in the PR. Do not assume either way.
- **#180 merged** (b2513a27); it is unrelated, so don't touch model-labels.

## 3. The work

- **Fix:** add a unique tiebreaker to both queries, e.g. `orderBy: [{ startDate: "asc" }, { id: "asc" }]` and
  `[{ approvedAt: "asc" }, { id: "asc" }]` `[agent decides the exact key; it must be unique and stable]`.
  Comment why in one line.
- **Test (real PG, `RUN_DB_IT`):**
  - Write the failing test first. Two loans with the same `startDate` must come back in the tiebreaker's order. Make
    the test order-independent of insertion (for example, assert against the references sorted by the tiebreaker),
    so it fails reliably without the fix rather than 50% of the time. If reliable red is impossible on Postgres for
    a tie, say so and show the mutation evidence you do have.
  - Fix line 112's expectation so it no longer depends on tie order. Either give the fixture's loans distinct
    `startDate`s or assert the tiebreaker order.
  - Cover the approved-applications tie the same way.
- **Mocked unit test:** if a suite asserts the `orderBy` argument, update it, and check its mutation: drop the
  tiebreaker and the suite must go red.
- **Siblings, read-only:** grep `lib/affordability/` for other `findMany` whose order feeds a fingerprint with a
  non-unique `orderBy`. List them in the PR body. Fix only the ones that feed the same fingerprint; mention the rest.

## 4. Success criteria

- [ ] The new test(s) are red without the tiebreaker and green with it, and the mutation is verified.
- [ ] `npx tsc --noEmit`, `npm run lint` and the full `npm test` pass.
- [ ] Integration via `scripts/it-db.sh`: own-lender-debt suite green **5× in a row**.
- [ ] `npm run ci:full` is green on the final head. Report every run honestly.
- [ ] A blind `/review` returns APPROVED or SHIP, with every finding fixed or reconciled on the PR.
- [ ] The PR body answers the fingerprint question (§2).
- [ ] The PR is queued with `mq add <pr>`, `.claude/handoffs/2026-10-18-own-lender-order-done.md` is written, a pointer
  is prepended to `LATEST.md`, and the worktree is removed after merge.

## 5. Confirmation gates (ask Hein)

- Any schema migration (none expected).
- Any change to affordability **figures or policy**, as opposed to ordering. If the fingerprint check shows that
  stored approvals would now mismatch (for example, existing snapshots recorded in the old order), stop and ask
  before shipping.
