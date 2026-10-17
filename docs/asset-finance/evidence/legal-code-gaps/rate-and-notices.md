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
