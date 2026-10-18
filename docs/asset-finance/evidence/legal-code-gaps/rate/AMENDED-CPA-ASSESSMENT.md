# Amended rental assessment guard acceptance, 2026-10-18

Candidate parent: D union `88dea40e`. All tests use fresh synthetic booked CPA
operating leases and an owned PostgreSQL16 database; no shared database, bank
transfer, message, deployment or legal-approval flag is involved.

A genuine late PRIME rate change retains the original rental and records the
period amendment in immutable AssetFinanceRateCorrection evidence. The application
already projects that amendment for the present value and undiscounted remaining
rentals. Both CPA assessment guards still read the original rental consideration.
Real sale/proceeds therefore returned `cpa_lessor_assessment` financial mismatch;
real consumer acceptance returned `cpa_reasonable_assessment` ceiling mismatch.
The unchanged baseline produced 2 failed,1 passed (loss):
`/tmp/cf-d-amended-red-final.log`.

New migration 20261018120000 adds the same period projection as
amendedLeaseRentals, including cumulative period amendments and rental-floor
reversals. It patches only the installed lessor rental SELECT and consumer rental
SUM, requiring each exact anchor once. All other factor, ownership, VAT, financial,
expense/concession, staff approval and immutable-history checks remain unchanged.
It writes no historical rentals, invoices, accepted quotes, receipts or corrections.

The actual migrated database passes all three paths (lessor, consumer, total
loss). Lessor PV and consumer ceiling mutations of one cent are rejected before
acceptance; legitimate values then succeed. Independent future-rental PV and
remaining-value assertions verify the stored basis. Original rate-correction
records, rental prices, invoice history, cash amounts, payment dates and methods
are retained; consumer credit legitimately reallocates prepaid cash to UNAPPLIED.

Regression run: 15 passed across four suites (new assessment, existing lessor
assessment/permanent stop, rate-adjusted cancellation, and total-loss proof races):
`/tmp/cf-d-amended-regressions-final.log`. Both trigger and CHECK catalogs were captured
before the repair in `/tmp/cf-d-amended-catalog.log`; resulting guard/function
SQL is in `/tmp/cf-d-amended-functions.log`. Full CI and browser acceptance of the
final combined candidate remain root-owned.

TypeScript, scoped ESLint and both documentation/mirror gates passed. The owned
database and anonymous volume were removed after the run.
