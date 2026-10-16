# F2, F4, F5 — mutation results

Each mutation was applied to the production code alone, the named tests run,
and the file restored. RED means at least one test failed, as it should.
F1's red-first proof is in [`../f1-s127-address/README.md`](../f1-s127-address/README.md).

## F2 — NCA final-notice reminder

Tests (`RUN_ASSET_FINANCE_RECOVERY_IT=1`, `TENANT_RLS=on`, real migrated
Postgres 16), run together for every mutation (14 tests):

- `recovery-final-notice-reminder.integration.test.ts`: the cron route with an
  injected clock. Freeze dates are pinned and due days written out by hand:
  Fri 2027-01-08 → due Fri 2027-01-15 (weekend), Thu 2027-03-18 → due Tue
  2027-03-30 (Human Rights Day observed Mon 22 Mar, Good Friday 26 Mar, Family
  Day 29 Mar). It checks for no bell the day before, one bell on the due day,
  still one after repeat runs, never a bell for a NON_NCA or noticed control,
  no name or ID number, and every recovery and loan row unchanged.
- `recovery-final-notice-reminder-rules.integration.test.ts`: a final notice
  issued while the sweep waits on the loan lock; an inactive creator (active
  ADMIN and SUPER_ADMIN belled, an inactive ADMIN not); no active admin (no
  marker, the next run bells); a COMPLETED or WRITTEN_OFF loan still belled.
- `recovery-final-notice-reminder.breaker.integration.test.ts`: the tester's
  repros (concurrent sweeps, weekend and Easter boundaries, notice before due,
  feature flag off, inactive creator F2-f, FK on the creator, future freeze).

| Mutation | Result | Failing tests (first few) |
|---|---|---|
| M1 the 5 business days become 4 | RED | clock IT; breaker F2-b, F2-c, F2-d |
| M2 the marker check is dropped | RED | clock IT; breaker F2-a (concurrent sweeps) |
| M3 the marker is never written | RED | clock IT; rules (admins, closed loans); breaker F2-a |
| M4 `<= day` becomes `< day` | RED | 11 of 14 |
| M5 the NCA route filter is dropped | RED | clock IT (NON_NCA control belled) |
| M6 FINAL_NOTICE_ISSUED also selected by the query | survived alone | see below |
| M6 + R1 together | RED | clock IT; rules race; breaker F2-d |
| M7 the reminder moves the loan's collections stage | RED | clock IT (rows changed) |
| M8 the title names the borrower | RED | clock IT |
| R1 no re-read of the recovery under the lock | RED | rules: the final notice issued while the sweep waits |
| R2 always the creator, active or not | RED | rules (admins; no admin); breaker F2-f |
| R3 inactive admins belled too | RED | rules: never an inactive admin |
| R4 marker written with no recipient | RED | rules: no marker, the next run bells |
| R5 a COMPLETED or WRITTEN_OFF loan is skipped (tenant-scoped count) | RED | rules: still bells when the loan is COMPLETED / WRITTEN_OFF (2 of 14) |
| H1 holiday list without Good Friday (`lib/compliance/sa-business-days.ts`) | RED | clock IT; breaker F2-c |
| H2 holiday list without Family Day | RED | clock IT; breaker F2-c |
| H3 no Sunday-to-Monday rule (Human Rights Day 2027) | RED | clock IT; breaker F2-c |
| H4 Saturday counted as a business day | RED | clock IT; breaker F2-b, F2-c |

M6 alone survives because the status is checked twice: by the sweep's query
and by the re-read under the lock (R1, added in review round 1). A recovery
the widened query lets through is refused by the re-read. Removing both goes
red. The unmutated suite passed after the runs (14/14).

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
