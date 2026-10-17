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

