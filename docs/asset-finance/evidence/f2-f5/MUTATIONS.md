# F2, F4, F5 — mutation results

Each mutation was applied to the production code alone, the named tests run,
and the file restored. RED means at least one test failed, as it should.
F1's red-first proof is in [`../f1-s127-address/README.md`](../f1-s127-address/README.md).

## F2 — NCA final-notice reminder

Test: `lib/asset-finance/recovery-final-notice-reminder.integration.test.ts`
(`RUN_ASSET_FINANCE_RECOVERY_IT=1`, real migrated Postgres 16, clock injected
with `vi.useFakeTimers({ toFake: ["Date"] })` through the cron route). It takes
an s131 and an s127 NCA recovery to PROCEEDS_APPLIED, plus two controls (a
NON_NCA recovery at PROCEEDS_APPLIED and an NCA one at FINAL_NOTICE_ISSUED),
and runs the cron at 4 business days, the calendar day before the 5th, the 5th,
and twice on the day after. Then it compares every recovery and loan row with
its state before the runs.

| Mutation (`lib/asset-finance/recovery-freeze-deadline.ts`) | Result | First failure |
|---|---|---|
| M1 the 5 business days become 4 | RED | a bell at 4 business days (`expected length 0 but got 1`) |
| M2 the audit-marker check is dropped | RED | the rerun reports `alreadyReminded` 0 |
| M3 the audit marker is never written | RED | `expected 0 to be 1` (marker count) |
| M4 `<= day` becomes `< day` | RED | nothing reminded on the 5th business day |
| M5 the NCA route filter is dropped | RED | the NON_NCA control is belled |
| M6 FINAL_NOTICE_ISSUED is also selected | RED | the noticed control is belled |
| M7 the reminder moves the loan's collections stage (update without `tenantId`) | RED | the update throws, so the run answers 503 |
| M7b the same, tenant-scoped so it commits | RED | the loan rows no longer equal their state before the runs |
| M8 the title carries the borrower's name | RED | `not to match /TEST\|Debtor/` |

The unmutated test passed before and after the mutation runs (1/1).

An earlier version also filtered on `finalNoticeIssuedOn: null`. Dropping that
filter alone left the test green: an NCA recovery cannot be at PROCEEDS_APPLIED
with a final-notice date, because issuing the notice sets the date and moves
the status together (`20261015400000_asset_finance_recovery`). The filter was
redundant and was removed, so the status filter is the one under test (M6).

## F4 — portal recovery card in the borrower's language

Tests: `components/asset-finance/recovery/` (including
`PortalRecoveryCard.i18n.test.tsx`) and `app/(portal)/portal/loans/[id]/`
(including `page.recovery-locale.test.tsx`).

| Mutation | Result | Failing test |
|---|---|---|
| M1 the card ignores its locale (always `en`) | RED | af/zu/xh: every line comes from the catalogue |
| M2 statuses and treatments are always English | RED | af/zu/xh: every line comes from the catalogue |
| M3 dates are not localised | RED | af/zu/xh (the description and freeze dates) |
| M4 an English value is edited (`Shortfall you owe`) | RED | English is byte-identical to the card before translation |
| M5 no fallback for a status missing from the catalogue | RED | prints the English label for an unknown status |
| M6 the instalment-sale page passes `en` | RED | the borrower's language on an instalment-sale page |
| M7 the lease page passes the borrower's locale | RED | stays English on a lease page |

## F5 — recovery deadline cron route

Test: `app/api/cron/asset-finance-recovery-deadlines/route.test.ts`.

| Mutation (`route.ts`) | Result | Failing test |
|---|---|---|
| M1 the CRON_SECRET check is removed | RED | refuses a wrong secret without running anything |
| M2 a failed run answers 200 | RED | answers 503 with the counts when any recovery failed |
| M3 the UTC date is used instead of SAST | RED | runs for today's SAST date and returns the counts |
