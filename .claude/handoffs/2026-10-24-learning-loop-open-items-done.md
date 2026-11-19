# Learning loop open items: DONE (2026-10-24)

Closes `2026-10-24-learning-loop-open-items-goal.md`. Evidence page: https://claude.ai/artifact/VYU3t6gwC7mc74P7um5Bho (private).

## Shipped
- **PR #250 MERGED** (main `6f38668a`, through `mq`).
- **A.** DESIGN.md records that the 24-month dashboard cut (`DECISION_LOOKBACK_MONTHS = 24`) is kept (Hein, 2026-10-24, for bounded reads). §11 no longer lists it as open.
- **B. 60-month floor on `TenantConfig.decisionRecordRetentionMonths`.**
  - Migration `20261024150000_decision_record_retention_floor`: CHECK is NULL or 60..600. A preflight **aborts** on rows set to 1–59 (no clamp). The rollback SQL is in the header.
  - `RETENTION_MONTHS_MIN = 60` (`lib/learning-loop/retention/policy.ts`).
  - Both routes return **400** for 59 (the goal said 422; the routes already used 400).
  - The card shows "(months, 60 to 600)", an inline error, and Save disabled under 60.
  - The IT asserts that raw UPDATEs to 1, 59 and 601 fail with 23514 and that 60, 600 and NULL pass.
  - DESIGN §2.7 is updated.
- **C. Merge queue.**
  - `fix/skipped-draft-checks` fast-forwarded to merge-queue master `fdab4be`; bun test 127/127 before and after.
  - `merge-queue.service` restarted 15:07 SAST while idle.
  - #250 merged through the restarted worker:
    ```
    2026-10-24T14:14:49.844Z  queued   #250  by hein
    2026-10-24T14:15:16.358Z  started  #250  testing 355988d3
    2026-10-24T14:32:02.366Z  merged   #250  merge commit of 355988d3
    ```
  - Worktree `merge-queue-wt-skipped`, the branch, and the `ll-floor` worktree are all removed.

## Evidence
- **Mutation:** with CHECK `>= 1`, the IT is red (1 failed / 13 passed). Restored, it is 14/14 green.
- **Migration:** a row at 30 aborts the migration.
- **Browser:** SUPER_ADMIN with real TOTP, on a throwaway DB. 59 is refused; 60 is saved and persists after a reload.
- **Reviews:** blind review APPROVED (4 LOWs, posted on the PR); security review CLEAN.
- **`ci:full`:** quality is green.
  - Integration: 4 tests in 5 suites timed out at load average 81–99 (retention plus four asset-finance template suites).
  - Re-run on a fresh DB with longer timeouts: 38/38. GitHub CI was green, since mq merged it.

## Open / notes
- **Flaky under load: FIXED** by #251 (dac5491f): the integration runner now gives tests 60 s and hooks 120 s.
- **LOWs not acted on:**
  - The literal 60 is duplicated in the client card (it can't import `policy.ts`, which imports prisma).
  - The floor is not mentioned in `lib/learning-loop/.claude.md`.
  - The migration preflight would block a demo snapshot restore if a demo set a period under 60. None does.
- **Still open from the follow-ups:** the other accepted limits (owner/superuser can set the pseudonymise flag; the period has no audit beyond the route).
