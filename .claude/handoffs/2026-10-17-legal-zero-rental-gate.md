# Confirmation proposal: permit zero lease rentals after historical rate cuts

Goal §8 requires approval for “A destructive or non-additive migration.”
The earlier approval covers only the surrender index replacement.

An extreme historical downward rate correction can exhaust the remaining
rental consideration of an active operating or full-maintenance lease.
The existing LeaseRental_amounts CHECK requires rentalExclVatCents > 0,
so it refuses the resulting zero rental. Residual value remains the lessor's
asset; it must not become customer payoff debt. Maintenance remains payable
where applicable.

Proposed NEW transactional migration (not applied):

```sql
BEGIN;
ALTER TABLE "LeaseRental" DROP CONSTRAINT "LeaseRental_amounts";
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_amounts" CHECK (
  "periodNo" >= 1
  AND "rentalExclVatCents" >= 0
  AND "maintenanceExclVatCents" >= 0
  AND "vatCents" >= 0
  AND "totalCents" = "rentalExclVatCents" + "maintenanceExclVatCents" + "vatCents"
  AND "vatRate" >= 0 AND "vatRate" < 1
);
COMMIT;
```

Only rentalExclVatCents > 0 becomes >= 0. All other predicates are identical
to migration 20261014090000_asset_finance_lease_foundation, lines 376–383.
No rows, tables or columns are deleted. Negative rentals remain prohibited.

Approval authorizes this specific CHECK replacement and its associated code
and verification, without authorizing tenant flags, deployments or messages.
Before merge: real PostgreSQL tests for active operating and full-maintenance
large cuts, rejection of negative amounts and malformed totals, preservation
of maintenance/VAT/cash, zero-rental invoice behavior, retry idempotency,
fresh review and full CI. The active-lease cases remain unfinished.

Independent completed evidence in the rate worktree: commercial/NCA active
payoff tests, four closed operating/FML up/down cases, and 200 focused tests;
logs /tmp/cf-rate-payoff-nca3.log, /tmp/cf-rate-lease-tax7.log and
/tmp/cf-rate-tax-focused.log. These do not prove the pending active-lease path.
