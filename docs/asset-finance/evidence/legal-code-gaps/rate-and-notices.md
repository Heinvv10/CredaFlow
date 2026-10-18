# Rate changes and written notices — items 24 and 26

2026-10-17, branch `fix/asset-finance-legal-rate`, merged with main `0acd1bdf` (integration merge `0996b08c`).
All database fixtures are synthetic and run on disposable PostgreSQL 16.
No real message, deployment, tenant flag, demo/Fairscore stack or paid service
was changed.

## Source and effective-date proof

SARB's [published API contract](https://custom.resbank.co.za/SarbWebApi/swagger/index.html)
exposes `Shared/GetTimeseriesObservations/{code}/{startDate}/{endDate}`.
The change-date series are `MRDPRIME` and `MRDREPOR`; the ZARONIA benchmark
series is `MMRD855A`. Each supplies `Period` and `Value`. HomePageRates supplies
observation dates and is no longer the repricing feed source.

A read-only call through the new parser on 2026-10-17 returned:

```json
{"ok":true,"count":1308,"latest":[{"basis":"PRIME","count":186,"date":"2026-09-25","rate":"0.1075"},{"basis":"REPO","count":70,"date":"2026-09-25","rate":"0.0725"},{"basis":"ZARONIA","count":1052,"date":"2026-10-15","rate":"0.07097"}]}
```

The explicit date range avoids the endpoint's default last-25-observation
window. Existing bases process dated events in order; a new basis starts with
its latest value. No ZARONIA move-size threshold remains, and an older pending
or rejected equal value cannot hide a later dated return to that value.
Feed values remain PENDING until the existing approval flow accepts them.

[NCA s104](https://www.justice.gov.za/mc/vnbp/act2005-034.pdf) permits a variable-rate
notice within 30 business days after the rate takes effect. The final
[Regulation 36](https://www.gov.za/sites/default/files/gcis_document/201409/28864.pdf)
also requires the effective date and ascertainable total/monthly interest in
Rand. The NCA notice snapshots the repriced schedule's total interest and the
first changed monthly period's payable interest, expressly assuming no further
rate change and timely scheduled payments.

## Transaction, delivery and tenant proof

`reprice-notice-db.integration.test.ts`, `reprice-loan.integration.test.ts`
and `rate-feed.integration.test.ts`: **33 tests passed** against a fresh,
fully migrated PostgreSQL 16 database. The provider dispatch function alone
was stubbed in the send acceptance test; Message creation, conversations,
consent evaluation, tenant scope, audit writes and idempotency were real.

The tests prove:

- A rollback leaves neither the repricing nor its written notice.
- A committed repricing creates exactly one notice, with the annual rate, ascertainable Rand interest figures,
  effective date, first changed due date, actual scheduled payment and
  recipient IDs. Re-running repricing creates no duplicate.
- The composite foreign key rejects attaching the notice to another tenant.
- Missing email contacts and former entity representatives remain blocked
  with durable outcomes; they are not reported as contacted.
- A committed notice goes through `sendMessage` after commit. A second sweep
  sends nothing new. The actual Message has a conversation and provider
  acceptance status. No real provider was called.
- The feed stores a September effective date when fetched in October and
  preserves small daily ZARONIA changes and later returns to old values.

Both Postgres catalogs were inspected: `pg_trigger` and CHECK constraints in
`pg_constraint`. Existing ReferenceRate lifecycle/four-eyes/source guards and
ContractRate basis/result guards remain in force. The changes add tenant-scoped outbox/correction ledgers and narrowly revise the NCA asset PASQ validator. Ordinary consumer LOAN validation and signed PASQ evidence are unchanged.

Email is the implemented delivery channel. NCA s104 notices use the statutory
email template; commercial contractual notices use the SERVICE lane and
respect service opt-outs. SMS is not used. Missing templates, blocked,
simulated, queued and uncertain delivery outcomes stay pending and are
reported by the cron; Message idempotency prevents duplicate provider calls.

## TDD and mutation proof

The durable queue, dispatch module and ZARONIA wording tests were run red
before their implementations. After restoring the final implementation, the
focused tests pass. Seven independent temporary mutations were each caught by
a failing test, then restored:

| Reversed change | Result |
| --- | --- |
| Omit durable notice creation | caught |
| Replace the benchmark Period with polling day | caught |
| Reinstate the 25 bp ZARONIA threshold | caught |
| Treat pending/simulated outcomes as completed | caught |
| Allow statutory override for commercial notices | caught |
| Drop the explicit historical date range | caught |
| Omit proposed-lawful-interest projection before restating a paid capped row | caught by real PostgreSQL regression |

## Documents

Both legal-wording sample renderers were rerun. Existing PDFs are unchanged;
a new synthetic ZARONIA instalment-sale sample exercises the changed clause.
Its extracted text includes "each published change applies from its benchmark
effective date" and contains no 0.25-point threshold. No consumer NCA pin was
changed.

## Historical cash and legal-cap acceptance

A late effective date restates already-paid principal/interest allocations without
changing the cash, payment dates, fees or premiums. Future capital starts from
the corrected closing balance. A genuine acknowledged NCA asset PASQ with service
fees, deferred initiation fee and credit-life premiums is repriced under migrated
guards; its original PASQ stays intact. `applyManualReceipt` settles at the revised
s125 amount and the real reversal route restores the revised contractual rows.
Arbitrary schedule/Loan monetary changes still fail the database guard.

On a fully paid book the correction is an append-only signed ledger liability,
not an invented receipt. It is visible to staff and in the borrower notice as
pending manual execution. No bank action is performed. Effective-dated actual
cash replay determines the NCA credit/debit; independent daily arithmetic checks
the exact signed amount. A retry adds no second correction. Reversing the settling
receipt appends the new difference immediately; a repeated reversal adds nothing.
Normal repricing of a reopened account consumes that pending adjustment and
incorporates its true historical rate path once.

Common-law cap projection uses the proposed contractual interest separately from
collectible cash and interest. The real-booked 120-month commercial regression
ages the account nine years, applies the cap with default charges OFF, receives
actual cash, and reprices a paid capped period. Zero lawful interest stays zero,
principal does not acquire a phantom residual, and the new full contractual
interest survives separately. A late increase on the completed account cannot
revive a debit for the already-blocked period. Closed commercial corrections use
the same chronological combined cap, including actual receipts.

Recent local evidence (all PostgreSQL 16 containers removed after the checks):

- `/tmp/cf-rate-candidate-pg.log`: 40 tests passed on one fresh migrated PostgreSQL 16 database, including actual NCA revision/settlement, exact independent signed arithmetic, reversal/retry, reopened repricing, paid-capped and closed-capped acceptance.
- `/tmp/cf-rate-law-mutation-red.log`: removing the proposed-lawful-interest projection creates the phantom-principal failure in the real booked commercial regression; the implementation was restored and all 40 checks passed.
- `/tmp/cf-rate-units-final.log`: 1,374 domain/replay tests passed (integration skipped).
- `/tmp/cf-rate-final-tsc.log`: regenerated-client TypeScript check passed.
- `/tmp/cf-rate-final-focused.log`: 25 latest focused checks passed.
- `/tmp/cf-rate-doc-check.log`: canonical-path and generated-agent mirrors passed.

These focused checks are not a claim that the final full gate or independent
review has passed. Root owns the final exact-candidate `ci:full`, review and fixes.


## Large-cut payoff and closed lease checkpoint

A real signed and booked commercial instalment sale with 59 actual receipt
applications now accepts a large historical rate cut: capital and future debt
end at zero. The independent daily oracle proves the refund amount. Reallocation
conserves every cash cent and value date; excess is classified UNAPPLIED, with an
append-only pending-refund correction. No refund is executed. The corresponding
59-paid-period genuine NCA PASQ regression preserves its original signed PASQ,
fees and premium history while waiving charges after the corrected payoff.

Closed operating and full-maintenance leases use the original ex-VAT capital,
rental-only consideration and lessor's retained residual. Maintenance and VAT
are excluded from capital replay. Four real-route signed/booked/paid cases
(up and down for both lease types) prove the signed amount against independent
daily arithmetic, unchanged receipts and maintenance funds, original-invoice VAT,
rental-only accounting credits and retry idempotency. Credit and debit notes
identify the original transaction; debit posting occurs in the adjustment period.
Rendered tax-document access is logged. The queued written notice contains the
complete immutable supplier, recipient, original invoice, reason and value/tax
particulars. VAT Act s21 guidance checked against [SARS Interpretation Note 83,
Issue 3](https://www.sars.gov.za/wp-content/uploads/Legal/Notes/Legal-IntR-IN-83-Application-of-sections-207-and-215.pdf).

Checkpoint evidence:

- `/tmp/cf-rate-payoff-pg1.log`: real booked commercial payoff with 59 receipts passed.
- `/tmp/cf-rate-payoff-nca3.log`: both genuine PASQ repricing/payoff cases passed.
- `/tmp/cf-rate-lease-tax7.log`: all four closed lease up/down cases passed.
- `/tmp/cf-rate-tax-focused.log`: 200 focused schema/notice/PDF checks passed.
- `/tmp/cf-rate-tax-tsc2.log` and `/tmp/cf-rate-new-lint.log`: TypeScript and focused lint passed.

### Pending confirmation: active lease zero-rental floor

Active operating/full-maintenance leases can require a zero future rental after
a sufficiently large late cut. Existing `LeaseRental_amounts` requires a strictly
positive rental. The narrow proposed replacement changes only
`rentalExclVatCents > 0` to `rentalExclVatCents >= 0`, preserving every maintenance,
VAT, total and identity condition. This is a non-additive constraint replacement
under goal §8. It has **not** been implemented or applied; user confirmation is
pending through root. Active lease floor acceptance remains unfinished and this
checkpoint does not close item 26 or authorize PR queueing. No full gate has been
launched for this changing source.

## Active lease final-notice-window correction

An ACTIVE lease whose final unpaid rental is inside the notice window now uses
the same ex-VAT rental-only capital and retained-residual correction as a closed
lease. It cannot enter the generic gross-loan/receipt correction. The final
scheduled payment remains fixed; each affected already-issued rental supply
receives its own original-rate credit/debit note. The share of an uninvoiced
rental is durably deferred until its actual original supply and invoice. No zero-rental CHECK is changed by this fix.

Four new real signed/booked cases (operating/FML, each +/-2 percentage points,
11 actual paid periods and a final uninvoiced rental due in seven days) failed
before the fix and pass afterward against an independent daily oracle. They
verify the unchanged pending schedule, maintenance fund and actual cash, signed
ex-VAT/gross correction, linked tax documents, auditable PDF access, written
notice and retry. `/tmp/cf-rate-final-window-red.log` records the four failures;
`/tmp/cf-rate-final-window-green1.log` records all eight closed/active cases
passing. `/tmp/cf-rate-final-window-unit.log` records 23 focused checks passing.

The future-supply boundary is now implemented. Each rental's independent
capital-prefix difference assigns its own share of the rate correction; the
shares telescope to the independent full-term oracle. An issued supply receives
its own s21 note. An unmade supply records its ex-VAT share and provisional booked
VAT without inventing an invoice. The actual original invoice event consumes the
pending share once, at that original invoice's actual VAT rate; an append-only
event reconciles the provisional gross liability. The outbox queues revised
written particulars with a new revision idempotency key. Cancelling the unmade
rental cancels only its pending share; no rental tax supply or adjustment note is
invented and prior issued-supply documents survive.

`/tmp/cf-rate-deferred-pg2.log` proves all 14 real PostgreSQL cases: four closed,
four active mixed issued/future, four active future-only, and two actual
cancellations before supply. A real receipt, the earlier supply event under
s9(3)(a), triggers the invoice and document delivery outbox; no database clock is
changed. `/tmp/cf-rate-deferred-mutation-red.log` proves that removing this actual
invoice hook makes eight cases fail; source was restored. The 206 focused
schema/notice/unit checks pass (`/tmp/cf-rate-deferred-units.log`). The existing
zero-rental CHECK remains unchanged and its separate confirmation remains pending.

After merging frozen commercial cancellation implementation `c7f23c60`, a fresh
migrated PostgreSQL run passed all 56 rate/source/notice/NCA/cap/payoff/lease
checks across eight suites (`/tmp/cf-rate-combined-c-pg.log`). The expanded lease
suite passed all 16 cases (`/tmp/cf-rate-deferred-c-final16.log`), including mixed
issued/unmade cancellations that retain prior issued-supply notes. All temporary
containers were removed. The latest 215 focused schema, dispatch, repricing and
charge-replay checks pass (`/tmp/cf-rate-combined-c-focused.log`). These remain
focused checks; the final full gate and independent reviews belong to root.

## Integrated A/B/C/D checkpoint

The D worktree includes frozen A `f2f43937`, B `5c123847` and C `646007b5`.
The invoice and cancellation functions preserve both B's supply-date VAT/cash
replay and D's per-supply deferred rate-tax hooks. The staff surrender and
commercial cancellation panels and all scope sign-offs are retained.

`/tmp/cf-rate-abcd-vat-pg1.log` records 18 passing real lease cases, including an
operating-lease rate cut and FML increase where booked VAT is 16% and the actual
supply is 15%. A real receipt triggers the original invoice, B's corrected bill
and cash replay, then D's own-supply CN/DN and immutable actual-VAT difference.
`/tmp/cf-rate-abcd-combined-pg.log` records 98 passing tests across 13 migrated
PostgreSQL suites spanning the four scopes. `/tmp/cf-rate-abcd-tsc-final.log`
records passing TypeScript and `/tmp/cf-rate-abcd-lint.log` passing focused lint.
Temporary PostgreSQL containers are removed. Catalog evidence in
`/tmp/cf-rate-abcd-zero-check.txt` confirms `LeaseRental_amounts` still requires
`rentalExclVatCents > 0`. No nonnegative-rental replacement is applied.

This is an integration checkpoint, not the final full gate or whole-goal
acceptance. The zero-rental confirmation/implementation remains outstanding.

## Cancellation after an issued rental rate adjustment

A combined B/D reproduction exposed two failures when a prepaid future rental
had already received its own reference-rate credit/debit note: damages still
used the nominal rental price, and cancellation left a rate debit note's supply
uncredited. The four real-booked cases cover an operating-lease cut and an FML
increase, with prepayment both before and after the rate correction.
`/tmp/cf-rate-cancel-supply-red4.log` records the failing independent money/VAT
oracles; `/tmp/cf-rate-cancel-supply-green2.log` records all four passing after
the correction.

Termination, recovery and total-loss valuation now read immutable contractual
per-period rental amendments, excluding maintenance. Cancellation replaces only
future rental claims with the amended PV damages claim: issued documents remain,
remaining debit-note supplies receive their own linked credit notes, and an
append-only causal correction neutralises the prior future rental face claim.
Unmade supplies continue through their separate deferred consumer; past supplies
and cash amounts/value dates remain intact. Accounting credits the remaining
rental and full maintenance consideration without assigning a rental-only rate
credit to maintenance. Retry assertions prove no duplicate correction or note.

`/tmp/cf-rate-abcd-cancel-proof.log` records all 102 passing real-PostgreSQL tests
across 14 combined A/B/C/D suites, including the new retry and maintenance
accounting assertions. `/tmp/cf-rate-abcd-schema-diff.log` reports no difference
between a fresh migrated database and `prisma/schema`; the existing tax-invoice
adjustment FK is explicitly mapped. TypeScript, focused lint and 66 valuation /
accounting unit tests pass (`/tmp/cf-rate-cancel-fix-tsc3.log`,
`/tmp/cf-rate-cancel-fix-lint-final.log`, `/tmp/cf-rate-cancel-fix-unit.log`). The
throwaway database was removed. The positive-rental CHECK is unchanged; this
checkpoint does not assert full CI or resolution of the zero-rental gate.

## Fresh review: notice revision race and paid-lease cash basis

The independent security race is retained as a deterministic regression: a
provider result from revision 0 cannot complete or overwrite revision 1. Every
snapshot outcome/completion write uses a revision-and-pending compare-and-set;
a stale result remains pending and creates no misleading completion audit.
The new revision sends with its own idempotency key. Lease funding rows now
explicitly replace the gross collectible snapshot with ex-VAT rental cash.
The reviewers' repro tests were converted to required safe-behaviour assertions
and failed before the fixes (`/tmp/cf-rate-review-red2.log`); all 15 pass after
(`/tmp/cf-rate-review-green.log`). Two real booked paid-lease tests independently
replay daily rental-only capital and preserve receipts, issued invoices, paid
bills, maintenance and correct per-line VAT (`/tmp/cf-rate-paid-lease-green2.log`).

## NCA s104(3) written notice deadline and escalation

The statutory due date is 30 South African business days after the actual rate
change's effective day, not its discovery, approval or outbox creation date.
Primary source: [National Credit Act, s104(3), Government Gazette](https://www.gov.za/sites/default/files/gcis_document/201409/a34-050.pdf).
The existing SA public-holiday calendar is used in TypeScript and PostgreSQL.
`statutoryDueOn` is immutable; `firstDispatchedAt` retains the last required
recipient's actual provider acceptance timestamp on first fully accepted dispatch.
Per-recipient accepted timestamps and Message IDs remain in outcomes/audits.
Dispatch completion and timely compliance are separate facts. Missing contacts,
missing templates, blocked, failed, simulated and uncertain provider outcomes
leave delivery pending. Reconciliation preserves an earlier actual acceptance
time instead of substituting the retry date.

An independent authenticated `asset-finance-rate-notices` worker is registered
for every 15 minutes with a one-hour freshness budget. It scans durable NCA
obligations regardless of the feature flag, loan eligibility or repricing queue,
then retries pending tenant notices. The repricing worker also scans before
calculation and dispatches each new notice after its financial commit. This is
source configuration only; no deployed scheduler or real provider is activated.
The deadline scan writes transactional staff bell/audit escalation once at two
business days before due, on the due day, and after the deadline. A late-created
notice already past due escalates directly to an unverified deadline exception.
Later authentic provider timestamps distinguish timely dispatch from actual late
dispatch; the immutable exception/escalation record remains. Provider acceptance
proves dispatch, not reader receipt or agreed-channel delivery.

`/tmp/cf-rate-deadline-red.log` records the missing deadline-control test before
implementation. `/tmp/cf-rate-deadline-pg3.log` records 10 passing actual-PG tests
across deadline/outbox/paid-lease suites: Easter/weekend/public-holiday counting,
a late-created already-overdue notice, deadline immutability, partial-recipient
pending state, idempotent staff escalation and later completion retaining the
earlier exception. The final source renames these new fields to
`firstDispatchedAt` and `deadlineExceptionAt`, refuses to invent missing provider
timestamps, and binds the obligation to the actual ContractRate date; that exact
migration/extra tamper regression awaits SQL gate approval before rerunning
PostgreSQL.
`/tmp/cf-rate-deadline-schema-diff.log` records no migrated-schema difference at
the preceding field-name checkpoint.
The disposable database was removed before the parent's later gate audit.
Further migration runs are held for that approval; no full CI or whole-goal
acceptance is claimed, and the positive-rental CHECK remains unchanged.

Latest source checks: 43 focused unit/route/registry tests pass in
`/tmp/cf-rate-deadline-final-unit.log`; TypeScript and focused lint pass in
`/tmp/cf-rate-deadline-final-typecheck.log` and
`/tmp/cf-rate-deadline-final-lint.log`. The staff panel distinguishes timely
dispatch, late dispatch and overdue-unverified evidence without claiming reader
receipt.

Fresh security correction: the migration no longer copies legacy `completedAt`
into `firstDispatchedAt`. Application completion alone proves no provider
acceptance. Existing records remain unknown until authentic Message timestamp
provenance is available. The prepared PostgreSQL regression executes the actual
migration data backfill against a completed legacy notice with a `SENT` outcome
but no linked provider timestamp, then requires unknown dispatch and escalation.
This new regression is explicitly **not run** while migration approval is held.
Affected unit checks (19), TypeScript and lint pass in
`/tmp/cf-rate-legacy-unit.log`, `/tmp/cf-rate-legacy-typecheck.log`, and
`/tmp/cf-rate-legacy-lint.log`.

## Zero-rental source candidate — PostgreSQL acceptance held

The source candidate now handles a sufficiently large late cut for an active
operating/full-maintenance lease by replaying rental-only funding, flooring the
changeable future rental at zero and retaining the lessor's residual outside the
borrower's bills. Historical excess is attributed to the affected supplied
rentals, with their own original-invoice VAT credit/debit documents and a durable
pending reconciliation/execution liability. It does not report a bank refund or
change cash amounts/value dates. Earlier valid tax documents remain immutable;
source evidence records any face reconciliation separately from funding cash.
Integer rounding belongs to the lessor. A larger residual funding difference
where no affected historical payment can be credited is recorded separately and
never becomes a borrower top-up or invented refund.

Maintenance remains outside the funding calculation and remains chargeable at
actual supply-date VAT. Superseded unmade rental adjustments are consumed once
without inventing a supply, so a later zero-rental/maintenance-only supply cannot
receive an obsolete rental CN. A completely zero supply produces no tax invoice;
maintenance-only supplies continue through the ordinary invoice path. Signed
weights permit reconstruction of a zero-rental tail; generic consumer schedule
validation remains strict. Previously applied floor corrections are excluded
from the later closed-book ledger-only correction subtraction.

`/tmp/cf-rate-floor-red.log` records the pure plan regression before the new
implementation. `/tmp/cf-rate-floor-focused4.log` records 64 passing focused
checks; `/tmp/cf-rate-floor-broad-unit.log` records 141 passing checks across 14
unit suites. The tests cover rental-only capital, affected-supply attribution,
conservative lessor rounding, no refund for payments before effectiveness,
notice-kept rentals, deferred-tax consumption/retry, zero-value invoice
suppression and zero-tail signed-weight reconstruction.

`lease-rental-floor.integration.test.ts` prepares four real-booked acceptance
cases: operating/FML, booked VAT 15% and synthetic booked VAT 16% with actual
supply VAT 15%. They exercise 59 actual paid rentals, independent daily funding
and per-supply tax oracles, original cash/ownership/residual preservation,
maintenance-only supply, no zero invoice and repricing retry. **These four tests
have not run.** The final legacy-notice/timestamp migration regression also
remains unrun under the consolidated SQL gate. The existing strictly-positive
`LeaseRental_amounts` CHECK has not been edited or applied. No new migration
or PostgreSQL run was executed after root's hold instruction; no full CI or
whole-goal acceptance is claimed for this candidate.

Final source checkpoint verification: TypeScript completed successfully in
`/tmp/cf-rate-floor-exact-typecheck.log`; touched-source lint and the final
zero-status write lint passed (`/tmp/cf-rate-floor-exact-lint.log`,
`/tmp/cf-rate-floor-zero-status-lint.log`). After the final status guard change,
`/tmp/cf-rate-floor-freeze-unit.log` records 12 passing tests in four affected
suites. `git diff --check` passed. No migration source was changed by this
zero-floor checkpoint. All PostgreSQL cases named above remain explicitly
unrun pending approval.

Zero-rental end-of-term follow-up: the pending-invoice query also needed to
exclude rows with neither rental nor maintenance consideration. The new
`lease-floor-billing.test.ts` failed first, then all four affected suites passed
(13 tests); TypeScript and touched-source lint passed. Positive rental and
maintenance-only supplies still require invoices. The prepared OL PostgreSQL
floor cases now assert this same billing boundary, but remain unrun under §8.
Logs: `/tmp/cf-rate-floor-billing-{red,green,types,lint}.log`.

### Approved zero-rental constraint and actual funding acceptance (2026-10-18)

After the consolidated §8 approval, migration
`20261018120000_lease_zero_rental_floor` replaces the rental amount CHECK with
nonnegative rental consideration, preserving its other amount/VAT invariants.
The foundation regression accepts zero and still rejects negative consideration
and malformed totals. Catalog snapshots are recorded in
`/tmp/cf-rate-approved-triggers.txt` and `/tmp/cf-rate-approved-checks.txt`.

The first approved-database run exposed a real date boundary error: extracting
the UTC date from SAST-midnight schedule timestamps shifted rental accrual one
day. The independent rental DATE oracle ended at 30,004,779 cents while the
stored plan reported 30,000,000 (`/tmp/cf-rate-approved-floor-green.log`). The
floor planner, writer and supply-eligibility checks now use SAST calendar dates
for those timestamps. The oracle remains unchanged.

The next run exposed a maintenance-only invoice failure: the invoice included a
zero-priced rental line, which the tax writer correctly refuses. Rental lines
are now omitted when their consideration is zero; maintenance retains its own
positive line, supply-date VAT and fund contribution. The intermediate red is
`/tmp/cf-rate-approved-floor-datefix.log`; all four actual-booked OL/FML cases
then pass in `/tmp/cf-rate-approved-floor-maintenancefix.log`. This supersedes
the preceding unrun label for these four cases. Cash, issued invoices, residual
and ownership remain unchanged, and historical credits remain pending execution.

TypeScript and touched-source lint pass (`/tmp/cf-rate-approved-final-types.log`,
`/tmp/cf-rate-approved-final-lint.log`). The migrated database matches Prisma
with no difference (`/tmp/cf-rate-approved-final-schema-diff.log`). This is a
focused acceptance checkpoint; root owns subsequent union and full CI.

The broader migrated rate/lease run executed 138 tests across 14 suites
(`/tmp/cf-rate-approved-broad-pg.log`): 136 passed, with two fixture failures.
The deadline recipient fixture reused a globally fixed ID across reruns; it
now uses a tenant-unique missing-recipient ID. The ContractRate TRUNCATE probe
was intercepted by the new notice FK; transactional TRUNCATE CASCADE now reaches
the exact insert-only trigger, and a before/after row-count sentinel proves
rollback safety. Both affected suites then passed all 22 tests in
`/tmp/cf-rate-approved-fixture-repair.log`. The other 12 suites were not repeated
after these test-only repairs. This also proves the final legacy completedAt
without provider timestamp regression, so its preceding unrun label is
superseded. All 31 focused units pass in
`/tmp/cf-rate-approved-final-unit.log`. Final changed-test TypeScript/lint logs:
`/tmp/cf-rate-approved-checkpoint-types.log`,
`/tmp/cf-rate-approved-checkpoint-lint.log`.

The final live zero-rental CHECK definition is recorded in
`/tmp/cf-rate-approved-final-zero-check.txt`. After ownership verification,
`bash scripts/it-db.sh down cf-it-rate-approved-20261018` removed the owned
disposable container and its volume. The old environment file is no longer a
live database. Root will create a fresh database for the integrated union.
No real messages, payments, deployment, flags, push or full CI were performed by
this checkpoint.
