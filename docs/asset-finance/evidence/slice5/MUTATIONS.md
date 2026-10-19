# Slice 5 mutation evidence

## Part A

Database: a throwaway PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5a-<random>`,
`npx prisma migrate deploy`. Suites: `lib/dealer/*.integration.test.ts`, run with
`RUN_ASSET_FINANCE_DEALER_IT=1 TENANT_RLS=on npx vitest run --no-file-parallelism lib/dealer/`.

### Before the fix (task 1: suites written first)

Against the database migrated to `20261018140100` (no dealer migrations):

```
 Test Files  8 failed (8)
      Tests  5 failed | 60 skipped (65)
ERROR:  42703: column "featureDealerPortal" of relation "TenantConfig" does not exist   (x10)
ERROR:  42P01: relation "DealerPayableRunLine" does not exist                          (x7, fixture cleanup)
ERROR:  42703: column "dealerCommissionClawbackMonths" of relation "TenantConfig" does not exist
```

Every suite's `beforeAll` (or its first test) failed on the missing schema, so
no rule could pass by accident. Two test-side fixes came after this run and
before the green run: the snapshot assertion's column count (`|||||f`) and the
booking fixture marking the application DISBURSED (the Loan commit invariant
requires it).

### After (task 2: schema, migrations, registries)

```
 Test Files  8 passed (8)
      Tests  65 passed (65)
```

The full gate (`bash scripts/run-integration-tests.sh`, which discovers
`RUN_ASSET_FINANCE_DEALER_IT` like every other gate) on the same database:
`Test Files 376 passed | 2 skipped (378)`, `Tests 3188 passed | 3 skipped`,
`integration gate OK`, which includes the existing asset-finance booking,
lease, recovery and NCA suites and the `RUN_TENANT_ISOLATION_IT` RLS catalog
test over the nine new models.

### Mutations

Each one is applied to the migrated throwaway database, the named suite is
run, then the object is restored exactly as the migration creates it. After
all three were restored the eight suites were 65/65 green again.

| # | Mutation | Suite | Result | Red test (assertion) |
|---|---|---|---|---|
| 1 | `ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_dealer_portal_demo_only"` | `lib/dealer/dealer-flag.integration.test.ts` | 2 failed, 3 passed | "refuses the flag on a lender that is not a demo lender" (line 48); "allows it on a demo lender, then refuses clearing isDemoLender while it is on" (line 56) |
| 2 | `ALTER TABLE "DealerPayableRun" DROP CONSTRAINT "DealerPayableRun_four_eyes"` | `lib/dealer/payable-runs.integration.test.ts` | 1 failed, 5 passed | "is approved by a second user, with totals equal to its live lines": the creator's self-approval went through (line 121) |
| 3 | `DROP INDEX "DealerPayableRunLine_one_live_run_per_line"` | `lib/dealer/payable-runs.integration.test.ts` | 1 failed, 5 passed | "holds a line in one live run only; cancelling a run frees its lines": the same line joined a second live run (line 105) |

The remaining mutations the spec lists (every other CHECK and trigger branch,
the `deal-view.ts` dealerId filter, the host-gate role check, the inverted
window comparison) belong to later tasks of PR A.

### Hardening (migration `20261019120200_dealer_portal_hardening`, deviations 20-22)

Suites `lib/dealer/dealer-provenance.integration.test.ts` and
`lib/dealer/payable-run-netting.integration.test.ts` were written first. Against
the database migrated to `20261019120100`:

```
 Test Files  2 failed | 1 passed (3)
      Tests  8 failed | 9 passed (17)
```

(every provenance test but the two that assert what stays allowed; every
netting test). `lib/dealer/payable-runs.integration.test.ts` was adjusted
first so its runs hold every line due by their period end (lines 2-3 dated
July; the July run holds both) and stayed green before and after.

After the migration: `lib/dealer/` 10 files, 76 tests passed.

Each mutation was applied to the migrated throwaway database, the suite run,
then the six triggers dropped and the migration file re-applied with `psql -f`.

| # | Mutation | Suite | Result | First red test |
|---|---|---|---|---|
| 4 | `DROP TRIGGER "Client_created_by_dealer_fixed"` | provenance | 2 failed, 3 passed | "refuses badging a staff-captured client, entity or asset as a dealer's"; "refuses moving a dealer's row to another dealer, or clearing it" |
| 5 | `DROP TRIGGER "BusinessEntity_created_by_dealer_fixed"` | provenance | 2 failed, 3 passed | same two |
| 6 | `DROP TRIGGER "FinancedAsset_created_by_dealer_fixed"` | provenance | 2 failed, 3 passed | same two |
| 7 | `DROP TRIGGER "AssetFinanceDeal_dealer_parties_fixed"` | provenance | 1 failed, 4 passed | "fixes a dealer deal's borrower and asset after insert" |
| 8 | `DROP TRIGGER "DealerPayableRunLine_netting"` | netting | 5 failed, 1 passed | "links an EARNED line only after its REVERSED line, in the same run" (later tests fail on its leftover lines) |
| 9 | `guardDealerPayableRunNetting` with the pairing RAISE replaced by `NULL` | netting | 5 failed, 1 passed | "refuses approving a run whose EARNED line was clawed back after it was linked" |
| 10 | `guardDealerPayableRunNetting` with the completeness RAISE replaced by `NULL` | netting | 1 failed, 5 passed | "refuses a run that leaves out a line of the dealer due by its period end" |
