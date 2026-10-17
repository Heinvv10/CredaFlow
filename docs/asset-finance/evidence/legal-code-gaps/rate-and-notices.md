# Rate changes and written notices — items 24 and 26

2026-10-17, branch `fix/asset-finance-legal-rate`, based on `a740801a`.
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
ContractRate basis/result guards remain in force. The migration adds only a
new outbox table, indexes and its tenant/loan/contract-rate foreign key.

Email is the implemented delivery channel. NCA s104 notices use the statutory
email template; commercial contractual notices use the SERVICE lane and
respect service opt-outs. SMS is not used. Missing templates, blocked,
simulated, queued and uncertain delivery outcomes stay pending and are
reported by the cron; Message idempotency prevents duplicate provider calls.

## TDD and mutation proof

The durable queue, dispatch module and ZARONIA wording tests were run red
before their implementations. After restoring the final implementation, the
focused tests pass. Six independent temporary mutations were each caught by
a failing test, then restored:

| Reversed change | Result |
| --- | --- |
| Omit durable notice creation | caught |
| Replace the benchmark Period with polling day | caught |
| Reinstate the 25 bp ZARONIA threshold | caught |
| Treat pending/simulated outcomes as completed | caught |
| Allow statutory override for commercial notices | caught |
| Drop the explicit historical date range | caught |

## Documents

Both legal-wording sample renderers were rerun. Existing PDFs are unchanged;
a new synthetic ZARONIA instalment-sale sample exercises the changed clause.
Its extracted text includes "each published change applies from its benchmark
effective date" and contains no 0.25-point threshold. No consumer NCA pin was
changed.

Full quality/integration gate results are recorded below after completion.
