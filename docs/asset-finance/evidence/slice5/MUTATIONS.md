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

### Principal, origination and dealer domain (tasks 3-5)

Each mutation is an edit to the TypeScript, the named suites run (unit, and
the `RUN_ASSET_FINANCE_DEALER_IT` suites on the migrated throwaway database),
then the file restored byte for byte.

| # | Mutation | Suites | First red tests |
|---|---|---|---|
| 11 | `dealer-host.ts`: drop `if (user.role !== "DEALER") return notFound(isApi)` | `lib/proxy/dealer-host.test.ts` | "refuses a staff or client session on the dealer paths (404)" (1 failed, 30 passed) |
| 12 | `deals.ts` `dealerDealWhere` without `dealerId` | `deal-view.test.ts`, `dealer-deal-access` IT | "filters every query on the caller's lender and dealer"; "answers not found to another dealer of the lender, for every read and write" (3 failed, 20 passed) |
| 12b | `deal-view.ts` `listDealerDeals` without `dealerId` | same | "filters every query..."; "shows the deal and its documents to its own dealer, and lists only its own deals" (2 failed) |
| 13 | `document-auth.ts`: drop the CLIENT-only client lookup | `staff-guards-refuse.test.ts` | "getDocumentCaller refuses it"; "never resolves a dealer as the client that shares its email" (2 failed, 27 passed) |
| 14 | `session-tenant.ts`: drop the DEALER refusal | `staff-guards-refuse.test.ts` | "getStaffTenantId refuses it" (1 failed, 28 passed) |
| 15 | `principal.ts`: drop the `tokenVersion` equality | `auth-dealer-jwt.test.ts`, `dealer-principal` IT | "signs out with the tokenVersion bumped"; "ends a session on a staff reset link"; "ends every session of a dealer that is deactivated" (3 failed) |
| 16 | `auth.ts`: drop the `onDealerHost` clause | `dealer/sign-in.test.ts` | "refuses a dealer sign-in off the dealer host"; "...while DEALER_APP_HOST is unset"; "refuses a staff, client or operator sign-in on the dealer host" (3 failed, 11 passed) |
| 17 | `users.ts` `deactivateDealer` without the `tokenVersion` bump | `dealer-principal` IT | "ends every session of a dealer that is deactivated, in one transaction" (1 failed, 6 passed) |
| 18 | `deals.ts`: drop the borrower provenance pre-check | `dealer-submit` IT | "refuses a duplicate borrower or asset without showing it, and a borrower or asset the dealer did not capture" (1 failed, 7 passed) |
| 19 | `submit.ts`: never refuse missing consent | `dealer-submit` IT | "refuses a submit without consent, then without a document..." (4 failed: the later steps depend on it) |
| 20 | `documents.ts`: dealer reads not limited to `uploadedByType 'dealer'` | `dealer-deal-access` IT | "never shows the dealer a staff upload on its own deal" (1 failed, 5 passed) |
| 21 | `auth.ts`: drop the jwt DEALER branch | `auth-dealer-jwt.test.ts` | every revalidation test (10 failed, 5 passed): the staff branch looks for a User row |

## Part A — accounting

Task 8 (journals, control, IsaFlow). Database: a throwaway PostgreSQL 16 from
`scripts/it-db.sh up cf-it-s5acct-<random>`, `npx prisma migrate deploy`.
Suites: `lib/accounting/sources-dealer-commission.test.ts` (unit) and
`lib/accounting/dealer-commission.integration.test.ts`
(`RUN_ACCOUNTING_IT=1`).

### Before (tests written first)

The unit suite against the code without the dealer commission source, roles
or event types: `Tests 10 failed | 2 passed (12)`. The two that passed hold
vacuously with no source at all: "every source sums to zero, and earned,
clawed back and both paid leaves nothing on the payable" and "a contract with
no commission lines … has no commission source"; mutation 1 below turns the
first of them red.

### After

```
npx vitest run lib/accounting/sources-dealer-commission.test.ts
 Tests  12 passed (12)
RUN_ACCOUNTING_IT=1 npx vitest run lib/accounting/dealer-commission.integration.test.ts
 Tests  5 passed (5)
RUN_ACCOUNTING_IT=1 npx vitest run --no-file-parallelism lib/accounting     (also with TENANT_RLS=on)
 Test Files  39 passed (39)
      Tests  312 passed (312)
```

### Mutations

Each one is applied to the source, the named suites are run, then the file is
restored byte for byte from a copy. After both were restored the suites above
were green again.

| # | Mutation | Suite | Result | Red test (assertion) |
|---|---|---|---|---|
| 1 | Drop the reversal source: `dealerCommissionSources` filters to `line.kind === "EARNED"` (`lib/accounting/sources-dealer-commission.ts`) | unit | 4 failed, 8 passed | "a REVERSED line (clawback) is its own source…"; "a clawback netted in a later run…"; "every source sums to zero…"; "posts each event once in its own month…" |
| 1 | same | IT | 2 failed, 3 passed | "closes August to December…": October refused, `AccountingPeriodError: 2 asset-finance control(s) do not tie: AF_INPUT_VAT jrn-is-1-dcx (journal 176250, books 150000); DEALER_COMMISSION_PAYABLE jrn-is-1-dcx (journal 0, books 201250)`; "holds the hand-worked vector…" |
| 2 | The payable control ignores released runs: the run predicate in `dealerPayableBooks` becomes `AND r."status" = 'RELEASED' AND false` (`lib/accounting/reconcile-controls.ts`) | IT | 3 failed, 2 passed | "ties the payable to the lines and runs in SQL…" (expected no mismatch, got one); "closes August to December…": September refused, `DEALER_COMMISSION_PAYABLE jrn-is-1-dcx (journal 0, books -201250)`; "holds the hand-worked vector…" |
