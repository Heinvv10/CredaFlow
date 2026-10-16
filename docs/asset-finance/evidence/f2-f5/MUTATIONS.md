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

Only the card's heading, its description ("{asset}, recovered on {date}"),
"Notices issued" and "None yet" are translated. Every recovery status (the
legal state of the s127/s131 process, review round 1), and every line that
mirrors the notices or states what is owed, stays English (statutory and
collections text is never translated, `lib/i18n/.claude.md`). The list, and
why, is in the header of `lib/i18n/messages/en/portal-recovery.ts`.

Tests: `components/asset-finance/recovery/` (including
`PortalRecoveryCard.i18n.test.tsx` and the tester's
`PortalRecoveryCard.breaker.test.tsx`) and `app/(portal)/portal/loans/[id]/`
(including `page.recovery-locale.test.tsx`).

| Mutation | Result | Failing test |
|---|---|---|
| M1 the card ignores its locale (always `en`) | RED | af/zu/xh: the heading, the description and the notices label come from the catalogue |
| M3 the recovered-on date is not localised | RED | the same (description) |
| M4 an English value is edited (`None yet`) | RED | English is byte-identical to the card before translation |
| M6 the instalment-sale page passes `en` | RED | the borrower's language on an instalment-sale page |
| M7 the lease page passes the borrower's locale | RED | stays English on a lease page |
| M8 no English fallback for an unknown locale | RED | breaker F4-a (an unknown locale crashes) |

The English-kept lines: the test "af/zu/xh: the statuses, the notice,
final-account and owed lines stay English" renders each case under af, zu and
xh and expects each line, and every one of the 11 statuses, as a whole
element's text (`>…<`). Each mutation gives a line a catalogue key in all four
languages (as the types demand) and prints it through `t()`:

| Mutation | Result |
|---|---|
| E1 "Shortfall you owe" | RED (af, zu, xh) |
| E2 the freeze deadline date in the borrower's format | RED (af, zu, xh) |
| E3 the status "Shortfall open" | RED (af, zu, xh) |
| E4 the notice name "Final notice" | RED (af, zu, xh) |
| E5 the figure "Valuation" | RED (af, zu, xh) |
| E6 the "Recovery costs" heading | RED (af, zu, xh) |
| E7 the treatment "Charged to the account" | RED (af, zu, xh) |
| E8 the status "Listed for sale" | RED (af, zu, xh) |
| E9 the status "Proceeds applied" | RED (af, zu, xh) |

E5 first survived while the test matched substrings: "Valuation" was found
inside "Valuation notice". The assertions match whole element text, and E5 is
red.

## F5 — recovery deadline cron route

Test: `app/api/cron/asset-finance-recovery-deadlines/route.test.ts`.

| Mutation (`route.ts`) | Result | Failing test |
|---|---|---|
| M1 the CRON_SECRET check is removed | RED | refuses a wrong secret without running anything |
| M2 a failed run answers 200 | RED | answers 503 with the counts when any recovery failed |
| M3 the UTC date is used instead of SAST | RED | runs for today's SAST date and returns the counts |
