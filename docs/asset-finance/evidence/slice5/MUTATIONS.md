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

## Part A — staff admin & cost of credit

Tasks 7 (staff admin) and 9 (cost of credit + seed). Database: a throwaway
PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5a7-<random>`, checked with
`it-db.sh check` before every migrate, `npx prisma migrate deploy`.

### Before (tests written first)

- `app/api/settings/asset-finance/route.test.ts` with the dealer-portal cases
  added, against the route without them: `Tests 5 failed | 11 passed (16)`
  (portal switch and clawback audit, switching off, the demo-only 422, the
  demo-lender marker never written; the 400 cases held vacuously, the old
  parser refusing any body without its two fields).
- `components/accounting/AccountingChecks.test.tsx` "names every
  asset-finance control" with `DEALER_COMMISSION_PAYABLE` and a new
  not-the-fallback assertion: `1 failed | 18 passed (19)` (`expected 'dealer
  commission payable' not to be 'dealer commission payable'`).
- The other new suites were written beside their code; each is shown to bite
  by a mutation below instead.

### After

```
npx vitest run lib/dealer/payable-run-lines.test.ts lib/dealer/staff-input.test.ts lib/dealer/staff-routes.test.ts \
  lib/dealer/no-borrower-charge.test.ts app/api/settings/asset-finance/route.test.ts \
  components/accounting/AccountingChecks.test.tsx lib/__tests__/navigation.test.ts
 Test Files  7 passed (7)
      Tests  139 passed (139)
RUN_ASSET_FINANCE_DEALER_IT=1 npx vitest run --no-file-parallelism <every RUN_ASSET_FINANCE_DEALER_IT suite>
 Test Files  16 passed (16)
      Tests  117 passed (117)
   (new: staff-admin 7, payable-run-actions 8, cost-of-credit 5)
RUN_ACCOUNTING_IT=1 npx vitest run --no-file-parallelism lib/accounting
 Test Files  39 passed (39)
      Tests  312 passed (312)
RUN_SEED_DB_IT=1 npx vitest run --no-file-parallelism prisma/seed.integration.test.ts prisma/seed-asset-finance.integration.test.ts
 Test Files  2 passed (2)
      Tests  29 passed (29)
```

Seed: `npx prisma migrate reset --force` twice on a fresh database of the same
container (`EXPERIAN_DRY_RUN=true`, as the seed's own bureau step needs
outside vitest): both runs "Seed complete" and "Staging seed complete". A
third run on top (`npm run seed:base` with `SEED_DEALER_PASSWORD` set) left 2
dealers, 3 dealer users with a password, 3 rates (2 dealer + 1 default) and 2
APPROVED accounts; the reset path issued a fresh link and set the password
(audited `DEALER_USER_PASSWORD_LINK_ISSUED`, `DEALER_USER_PASSWORD_SET`). The
seed IT's rerun snapshot now includes the dealer rows.

### Mutations

Each one is applied to the source, the named suite is run, then the file is
restored byte for byte from a copy; the suites above were green afterwards.

| # | Mutation | Suite | Result | Red test (assertion) |
|---|---|---|---|---|
| 1 | Commission into the PASQ: `nca-quote-store.ts` selects `dealerCommissionFlatCents` and passes `initiationFeeCents: terms.financedFeesCents + flat` to `createAssetPasqEvidence` | cost-of-credit IT | 3 failed, 2 passed | "books both through the regulated NCA path": the book route answers 409 ("The database refused this step…"); "earned the dealer its commission…"; "leaves every borrower figure identical…" |
| 2 | Commission into the disclosed cost: `evidence.totalCostOfCreditCents += dealerCommissionFlatCents` after `createAssetPasqEvidence` | cost-of-credit IT | 3 failed, 2 passed | "books both…": the quote is refused by CHECK `LoanApplication_approved_status_requires_pasq` (23514); then the two tests after it |
| 3 | Commission spread into the Loan: `booking.ts` `monthlyServiceFee += round(flat / 60)` (flat selected in `booking-load.ts`) | cost-of-credit IT | 3 failed, 2 passed | "books both…": book 409 (the database ties the loan to the signed PASQ) |
| 4 | Commission loaded into the rate: `booking.ts` `interestRatePm += dealerCommissionBps / 1 200 000` | cost-of-credit IT | 1 failed, 4 passed | "leaves every borrower figure identical: PASQ cost of credit and schedule, signed terms, Loan and its schedule rows" (`expected { pasq, deal, … } to deeply equal …`; the database does not guard this column, the identity assertion does) |
| 5 | `lib/asset-finance/schedule-records.ts` gains `import "@/lib/dealer/actor"` (reached transitively from the five cost-of-credit modules) | `no-borrower-charge.test.ts` | 1 failed, 2 passed | "imports no dealer or commission module, directly or transitively" |
| 6 | `lib/asset-finance/booking-plan.ts` gains a function reading `deal.dealerCommissionFlatCents` | `no-borrower-charge.test.ts` | 1 failed, 2 passed | "reads no dealerCommission* column anywhere in that graph" |
| 7 | Run-create netting dropped: `selectRunLines` takes an EARNED line whenever its reversal is not live (`payable-run-lines.ts`) | unit | 1 failed, 4 passed | "leaves out a commission whose clawback falls after the period end" |
| 7 | same | payable-run-actions IT | 5 failed, 3 passed | "creates January…" (the clawed-back February commission is linked without its reversal: the database refuses the link) and the four tests after it |
| 8 | `dealer-runs/[runId]/approve` guarded by `manage_asset_finance` instead of `decide_asset_finance` | `staff-routes.test.ts` | 1 failed, 63 passed | "POST approve > holds a user awaiting TOTP enrolment, 404s with the module off, 403s below the permission" (a CREDIT_OFFICER got through) |
| 9 | The settings route no longer maps the demo-only CHECK (`if (false && …)`) | settings route unit | 1 failed, 15 passed | "answers the demo-only CHECK 422 with the reason, and audits nothing" |
| 9 | same | staff-admin IT | 1 failed, 6 passed | "the settings route answers the demo-only CHECK 422 on a lender that is not a demo…" (the real `TenantConfig_dealer_portal_demo_only` error reached the caller as a throw) |
| 10 | `approvePayableRun` no longer refuses its creator in TS (`return null`); CHECK `DealerPayableRun_four_eyes` still refuses | payable-run-actions IT | 2 failed, 6 passed | "is approved only by another user…" (no `{ kind: "self_approval" }`), "is released with the lender's EFT reference" |

## Part A — staff submit refuses a dealer deal

`POST /api/asset-finance/deals/[id]/submit` answers 409 for a deal with a
`dealerId`: the staff accept of the dealer's submission
(`…/dealer-submission/accept`, deviation 1) is the only way a dealer deal
reaches `submitDeal`. The check reads the deal's `dealerId` before the
submit's transaction; a deal's dealer is fixed at insert
(`guardAssetDealDealer`), so the read cannot race the submit. The existing
`app/api/asset-finance/deals/deal-routes.test.ts` submit cases (staff deals)
pass unchanged.

### Before (test written first)

`app/api/asset-finance/deals/[id]/submit/route.test.ts` with the two
dealer-deal cases added, against the route without the check:

```
 FAIL  … dealer deals (SLICE5.md deviation 1) > answers 409 for a dealer's deal: …
AssertionError: expected 200 to be 409 // Object.is equality
      Tests  1 failed | 3 passed (4)
```

### After

```
npx vitest run "app/api/asset-finance/deals/[id]/submit/route.test.ts"
      Tests  4 passed (4)
```

### Mutation

Applied to the source, the suite run, then the file restored byte for byte
from a copy; the suite was 4/4 green again.

| # | Mutation | Suite | Result | Red test (assertion) |
|---|---|---|---|---|
| 1 | `submit/route.ts`: `if (deal?.dealerId && false) {` | submit route unit | 1 failed, 3 passed | "answers 409 for a dealer's deal: …" (`expected 200 to be 409`) |

## Part A — review round 1

PR #216 review fixes (SLICE5.md deviations 29-38, migration
`20261019120300_dealer_portal_review_fixes`). Database: throwaway PostgreSQL
16 from `scripts/it-db.sh up cf-it-s5fx-<random>`. Every fix got its test
first; for the database rules the Prisma DDL alone was applied first (so the
suites could run), then the hand-written rules.

### Before (tests written first, against the code or database without the fix)

| Fix | Suite | Result | Red assertion |
|---|---|---|---|
| L1 reversal reason hidden | `deal-view-loan-performance.test.ts`, `commission-statement.test.ts` | 2 failed | "expected '{…}' not to contain 'WRITTEN_OFF'"; "reason: expected [ 'id', 'kind', 'reason', … ] to not include 'reason'" |
| L2 goods-advance base | commission-accrual IT, edge-commission IT | 6 + 10 failed | "expected 'NONE\|0\|0\|151000020\|t' to be 'NONE\|0\|0\|150000020\|t'" (the fixture's applied amount carries R10 000 financed fees) |
| L3 lender-added people (DB) | dealer-consent IT | 2 failed | the attestation for a lender-added person was accepted |
| L3 (TS) | dealer-submit IT | 1 failed | attest/submit with a lender-added person on the entity |
| L5 classification re-stamp | cost-of-credit IT | 1 failed | `ncaClassifiedById` was the dealer user, not the accepting officer |
| A5 hand-over CHECK | dealer-handover-contact IT | 1 failed | SUBMITTED before `dealerSubmittedAt` was accepted |
| S1 contact guard (DB) | dealer-handover-contact IT | 3 failed | a portal password set on an unverified dealer-captured client |
| S1 register + S3 audit | dealer-borrower-identity IT | 2 failed | "expected '1' to be '0'" (an activation code was issued to the dealer-typed email); "expected '0\|\|\|' to be '2\|dlu_…\|person\|t'" (no refusal audited) |
| S1 signing code | `lib/signing-otp/subject-dealer-contact.test.ts` | 1 failed | the subject resolved for an unverified dealer-captured client |
| S2 reset link | dealer-reset-link IT | 1 failed | "expected true to be false" (the old password signed straight back in) |
| C6 no link for a deactivated dealer | dealer-reset-link IT | 1 failed | "expected { kind: 'issued' } to deeply equal { kind: 'refused', status: 409 }" |
| S3 capture limit | `capture-limits.test.ts` | 2 failed | no audit; no 429 |
| S4 refusal audits | `staff-routes.test.ts` | 1 failed | `auditRefusal` not called |
| T2 tax invoice (DB) | payable-runs IT | 2 failed | a VAT run released without the dealer's tax invoice |
| T2 (TS) | payable-run-actions IT | 1 failed | release without the invoice was not 422 |
| E-F04 uploads after hand-over, C3 | `documents.test.ts`, edge F04 | 4 + 1 failed | "expected { kind: 'stored' } to match { kind: 'refused', status: 409 }"; "Error: The document request was answered concurrently" |
| E-U03 lower-case email | edge U03 | 1 failed | a mixed-case email was accepted |
| B1 portal switch on a demo lender | staff-admin IT | 1 failed | "expected 422 to be 200" (the upsert's INSERT row met `TenantConfig_dealer_portal_demo_only`) |
| B2 borrower address | `capture-address.test.ts`, dealer-submit IT | 2 + 2 failed (one cascading) | a business and a sole proprietor captured without an address; the accept submitted a deal whose borrower had none |
| B3 booking date | `deal-view-loan-performance.test.ts` | 1 failed | `bookedOn` "2026-10-29" for a 30 Oct SAST start |
| B5 inline-script warning | browser (next dev, dealer.localhost) | 1 console error | "Encountered a script tag while rendering React component" on a dealer deal 404; gone with the root layout's script removed (the cause), and with `ThemeInitScript`; `ThemeInitScript.test.tsx` red with its browser guard removed |
| C7 run unique conflicts | `payable-runs-unique.test.ts` | 2 failed | a line conflict answered as a period conflict; an unrelated P2002 swallowed |

### Mutations (database rules, applied to the migrated throwaway database, then restored)

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| 1 | `guardAssetDealDealer` base back to `COALESCE(approvedAmount, appliedAmount)` | commission-accrual IT | 6 failed, 8 passed | "takes the dealer's rate in force today and the goods advance …", "keeps the snapshot …", "falls back to the tenant default …" |
| 2 | `DROP CONSTRAINT "AssetFinanceDeal_dealer_handover"` | dealer-handover-contact IT | 1 failed, 6 passed | "refuses moving a dealer deal on from DRAFT before the dealer handed it over" |
| 3 | `DROP TRIGGER "DealerConsentAttestation_subject_captured"` | dealer-consent IT | 2 failed, 6 passed | "refuses a person the dealer did not capture …" |
| 4 | `DROP TRIGGER "Client_dealer_contact_guard"` | dealer-handover-contact IT | 3 failed, 4 passed | "refuses a portal password until staff verify …", "refuses a dealer-captured client inserted with a portal password or already verified", "verifies once, completely, and only a dealer-captured client" |
| 5 | `DROP CONSTRAINT "DealerPayableRun_tax_invoice_on_vat"` | payable-runs IT | 1 failed, 6 passed | "is released only after approval and only to a still-APPROVED account" |
| 6 | `DROP CONSTRAINT "DealerUser_email_lower_case"` | edge U03 | 1 failed | "U03 the database forces the email to lower case …" |

After restoring each: the three suites 22/22, commission-accrual 14/14.
The TypeScript fixes' mutation is the "Before" run above: each is the fix
reverted (the file restored from the parent commit), its test red, then the
fix put back and the test green.

## Part A — review round 2

Database: throwaway PostgreSQL 16 (`scripts/it-db.sh up cf-it-s5fx-<random>`,
`npx prisma migrate deploy` to `20261019120400`). Tests written first.

### Before

| Fix | Suite | Result | Red assertion |
|---|---|---|---|
| R2-L1 booking needs verified contacts | dealer-handover-contact IT | 1 failed, 7 passed | "expected [Function] to throw an error" (a dealer deal with an unverified dealer-captured director was BOOKED) |
| R2-C1 on-book audit row | `capture-limits.test.ts` | 1 failed | the audit named entity `BusinessEntity` with the dealer user's id |

### Mutations (applied to the migrated throwaway database or the source, then restored)

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| 1 | `DROP TRIGGER "AssetFinanceDeal_dealer_contacts_verified"` | dealer-handover-contact IT | 1 failed, 7 passed | "refuses to book a dealer deal until every dealer-captured person on it is verified" (`book()` did not throw) |
| 2 | `booking-load.ts`: the unverified-contacts check disabled (`if (false && …)`) | dealer-handover-contact IT | 1 failed, 7 passed | same test: refused with `application_not_ready`, not `dealer_contact_unverified` |
| 3 | `DROP CONSTRAINT "DealerCommissionLine_shape"` | dealer-row-shapes IT | 3 failed, 6 passed | EARNED, REVERSED and gross/VAT clause tests |
| 4 | `DealerCommissionLine_shape` without the sign pairing (`netCents > 0` / `< 0`) | dealer-row-shapes IT | 2 failed, 7 passed | "refuses an EARNED line … net that is not positive", "refuses a REVERSED line … net that is not negative" |
| 5 | `DealerCommissionLine_shape` without `grossCents = netCents + vatCents` | dealer-row-shapes IT | 1 failed, 8 passed | "refuses a gross that is not net plus VAT, and VAT for a dealer that is not a vendor" |
| 6 | `DealerCommissionLine_shape` without `dealerVatVendor OR vatCents = 0` | dealer-row-shapes IT | 1 failed, 8 passed | same test |
| 7 | `DROP CONSTRAINT "DealerPayableRun_status_shape"` | dealer-row-shapes IT | 4 failed, 5 passed | pending, approved, released and cancelled shape tests |
| 8 | `DealerPayableRun_status_shape` without the non-blank `releaseReference` clause | dealer-row-shapes IT | 1 failed, 8 passed | "refuses a released run without its approval, its release, or a non-blank release reference, or with a cancellation" |

After restoring each: dealer-handover-contact 8/8, dealer-row-shapes 9/9.

## Part A — review round 3

Security review round 2. Database: throwaway PostgreSQL 16, migrated to
`20261019120500`. Tests written first.

### Before

| Fix | Suite | Result | Red assertion |
|---|---|---|---|
| (1) booking gate on every deal | dealer-handover-contact IT, database migrated to `20261019120400` only | 1 failed, 8 passed | "expected [Function] to throw an error" (a staff deal on a dealer-captured borrower with an unverified director was BOOKED) |
| (2) portal reset to a dealer-typed email | dealer-contact-bypass IT | 1 failed, 1 passed | "expected { status: 200, issued: '1' } to deeply equal { status: 200, issued: '0' }" |
| (3) selfie link to a dealer-typed contact | selfie send-link route unit | 1 failed, 18 passed | the link was sent (no 409) |
| (4) servicing messages to an unverified dealer-typed person | dealer-handover-contact IT; `reprice-notice-dispatch.test.ts` | 1 failed each | the dealer-captured director was among the entity's recipients; the rate-notice re-check had no trust filter |
| (5) a person added after the hand-over | dealer-submit IT | 1 failed, 10 passed | "expected { kind: 'created' } to match object { kind: 'refused', status: 409 }" |
| (7) PASQ acknowledgement link to a dealer-typed contact | PASQ send-link route unit | 1 failed, 22 passed | "expected 200 to be 409" |
| (8) agreement email and link, signing-packet email, application status email | `lib/clients/dealer-contact-routes.test.ts` | 4 failed | each route answered another refusal or threw, not the dealer-contact 409 |
| (9) event notifications (`triggerNotification`) | `lib/notifications.test.ts` | 1 failed | the email and SMS legs were attempted |
| (10) website identity notice to a dealer-typed email | dealer-website-identity-notice IT | 1 failed | "expected [ Array(1) ] to deeply equal []" (the notice went to the dealer's inbox) |
| (11) consumer loan for an unverified dealer-typed client | disburse route unit; dealer-handover-contact IT | 1 failed each | the route went on to its other gates; the Loan INSERT met only the loan's other guards |
| (12) the capture pre-check with a staff deal (trigger refusal mapping off) | dealer-entity-people IT | 1 failed, 4 passed | "refuses it for a business with a staff deal on it" (the NOT on nullable dealerId skipped it) |
| (6) linking an unverified dealer-typed person to a business with a live deal (database) | dealer-entity-people IT | 4 failed, 1 passed | each link was accepted ("expected true to be false"): own deal handed over, staff deal, another dealer's draft, re-activation and re-pointing |

### Mutations (applied to the migrated database or the source, then restored)

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| 1 | trigger WHEN back to `NEW."dealerId" IS NOT NULL` (the `20261019120400` shape) | dealer-handover-contact IT | 1 failed, 8 passed | "gates a staff deal on a dealer-captured borrower the same way, and staff verify from that deal" |
| 2 | `booking-load.ts` unverified-contacts check disabled | dealer-handover-contact IT | 2 failed, 7 passed | both booking cases: refused with another reason |
| 3 | `forgot-password/route.ts` without `TRUSTED_CONTACT_WHERE` | dealer-contact-bypass IT | 1 failed, 1 passed | "issues no code … refuses it cleanly" (`issued: '1'`) |
| 4 | `reset-password/route.ts` without `TRUSTED_CONTACT_WHERE` | dealer-contact-bypass IT | 1 failed, 1 passed | same test: the reset threw `PrismaClientUnknownRequestError` (the database guard), not a refusal |

| 5 | `entity-contacts.ts` without `TRUSTED_CONTACT_WHERE` | dealer-handover-contact IT | 1 failed, 9 passed | "sends an entity's servicing messages to no dealer-captured person until staff verify them" |
| 6 | `reprice-notice-dispatch.ts` without `TRUSTED_CONTACT_WHERE` | `reprice-notice-dispatch.test.ts` | 1 failed, 16 passed | "never releases a notice to contact details a dealer typed that staff have not verified" |
| 7 | `captureDealerPerson`'s hand-over check disabled | dealer-submit IT | 1 failed, 10 passed | "adds no person to the business once its deal is handed over" |

| 8 | `DROP TRIGGER "EntityRelationship_dealer_contact_link"` | dealer-entity-people IT | 4 failed, 1 passed | the four refusal cases |
| 9 | `captureDealerPerson`'s in-transaction check off, the trigger's refusal still mapped | dealer-entity-people IT | 5 passed (survives by design: the database refuses and the route maps it to the same 409) | — |
| 10 | the in-transaction check and the refusal mapping both off | dealer-entity-people IT | 2 failed, 3 passed | "refuses it once the dealer's own deal is handed over", "refuses it for a business with a staff deal on it" (the capture threw) |
| 11 | agreement send-link guard off | dealer-contact-routes + PASQ + notifications units | 1 failed, 83 passed | "agreement link › refuses 409 and sends nothing …" |
| 12 | PASQ send-link guard off | same | 1 failed, 83 passed | "refuses with 409 to send the link to contact details a dealer typed …" |
| 13 | `triggerNotification` guard off | same | 1 failed, 83 passed | "sends nothing to a client whose dealer-typed contacts staff have not verified, and records why" |
| 14 | `entityContactRecipients` client filter without `TRUSTED_CONTACT_WHERE` | `lib/asset-finance/reprice-notice.test.ts` (pins the exact where clause) | 1 failed, 4 passed | "are the entity's servicing contacts: … no unverified dealer-typed contact, once each" |
| 15 | the booking refusal back to "(the Dealer panel)" | `lib/asset-finance/booking.test.ts` | 1 failed, 17 passed | "dealer_contact_unverified while a person on the deal …" (the message must name "Contacts a dealer captured") |
| 16 | website apply: the notice not withheld | dealer-website-identity-notice IT | 1 failed | the notice went to the dealer-typed address |
| 17 | `DROP TRIGGER "Loan_dealer_contact_verified"` | dealer-handover-contact IT | 1 failed, 10 passed | "refuses any Loan (a consumer loan included) …" |
| 18 | disburse route: the dealer-contact refusal off | disburse route unit | 1 failed, 77 passed | "refuses to pay out to a client whose dealer-typed contact details …" |

(3)'s mutation is its before run (the route without the check). After
restoring each: dealer-handover-contact 10/10, dealer-contact-bypass 2/2,
dealer-submit 11/11, reprice-notice-dispatch 17/17, dealer-entity-people 5/5.

## Part C

Database: a throwaway PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5c-<random>`,
`npx prisma migrate deploy`. Suites: `lib/valuation-guides/*.integration.test.ts`, run with
`RUN_ASSET_FINANCE_VALUATION_IT=1 npx vitest run --no-file-parallelism lib/valuation-guides/`.

### Before (suites written first)

The schema was generated, but none of the three part C migrations had been
applied (the database stopped at main's `20261020120000`):

```
 Test Files  9 failed (9)
      Tests  4 failed | 1 passed | 25 skipped (30)
The table `public.ValuationGuide` does not exist in the current database.   (x3, each IT's beforeAll)
Error: Cannot find package '@/app/api/asset-finance/valuation-guides/route'     (routes IT)
Error: Cannot find module './csv' | './ltv' | './revaluation' | '../registry'  (unit suites)
Error: trigger ValuationGuide_no_truncate: expected 1 statement in the migrations, found 0  (static test)
```

### After

With the migrations applied, `lib/valuation-guides/` gave `Tests 64 passed | 1
skipped (65)`; the skipped test is the browser seed, which needs its own
switch. Every asset-finance IT on the same database, run with
`TENANT_RLS=on` and every `RUN_ASSET_FINANCE_*_IT` switch, passed:
`Test Files 312 passed | 9 skipped (321)`, `Tests 2779 passed | 41 skipped`. That
run includes the existing recovery-sale and lease end-of-term suites, which now
read the replaced `guardRemarketingSale`.

Each database suite also proves its rules from inside: `refuses(rule, …)`
first shows the attack is refused, then takes out that one clause, CHECK,
index or trigger in a rolled-back transaction and shows the attack goes
through (`lib/asset-finance/recovery-rules.integration-fixture.ts`).

### Mutations (database: applied to the migrated database, then restored)

| # | Mutation | Suite | Result | Red tests |
|---|---|---|---|---|
| M1 | `DROP CONSTRAINT "ValuationGuide_four_eyes"` | guide-rules IT | 1 failed, 9 passed | "is published by someone other than its uploader (four-eyes)" |
| M2 | `DROP INDEX "ValuationGuide_one_current_per_name"` | guide-rules IT | 1 failed, 9 passed | "keeps one current guide per name, …" |
| M3 | `guardRemarketingSale` back to its `20261015400000` body (`<> 'INTERNAL'`) | not-independent IT | 3 failed, 4 passed | "refuses a sale that relies on a GUIDE valuation"; "never measures a sale against a GUIDE valuation above the independent ones"; "never makes a sale self-valued by its proposer's GUIDE valuation at the highest amount" |
| M4 | `DROP TRIGGER "AssetValuation_guide_guard"` | guide-valuation IT + routes IT | 8 failed, 10 passed | each GUIDE-valuation rule (snapshot, published guide in force, dated today, make/model/year, trade value, own guide's row, other lender's guide), and the routes IT's record (no snapshot: the CHECK refuses) |
| M5 | `DROP TRIGGER "ValuationGuideRow_guard"` | guide-rules IT | 1 failed, 9 passed | "writes rows only into a DRAFT and never changes or deletes them" |
| M6 | `DROP TRIGGER "ValuationGuide_successor_published"` | guide-rules IT | 1 failed, 9 passed | "keeps one current guide per name, superseded only by a newer one put live in the same transaction" |
| M7 | `guardValuationGuide` with `IF allowed IS NULL THEN` → `IF FALSE THEN` | guide-rules IT | 2 failed, 8 passed | "never changes once published: …"; "moves only DRAFT → PUBLISHED or DISCARDED and PUBLISHED → SUPERSEDED" |
| M8 | `DROP CONSTRAINT "AssetValuation_guide_shape"` | guide-valuation IT | 1 failed, 8 passed | "is a GUIDE row exactly when it names a guide, a row and a snapshot" |

After the restores, `lib/valuation-guides/` gave 64 passed and 1 skipped again.

### Mutations (source: the file edited, the suite run, the file restored; `git diff` clean after each)

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| T1 | `valuationFacts` refuses only `INTERNAL` | not-independent IT | 1 failed, 6 passed | "and the server's own checks agree: valuationFacts refuses it, the sale form never offers it" |
| T2 | `loadSaleValuations` back to `source: { not: "INTERNAL" }` | not-independent IT | 1 failed, 6 passed | same test (the GUIDE valuation was offered) |
| T3 | `valuationFacts`'s highest counts GUIDE | not-independent IT | 1 failed, 6 passed | same test (`highestCents` 130 000 000, not 100 000 000) |
| T4 | `publishGuide` without the self-publish check | routes IT | 4 failed, 5 passed | "refuses the uploader's own publish (audited), …": the CHECK refused it as a 500, unaudited. The later tests depend on that publish. |
| T5 | `guideCandidates` without `g."status" = 'PUBLISHED'` | routes IT | 1 failed, 8 passed | "offers the current guide's rows …": the superseded guide's rows were offered too |
| T6 | upload refusal not audited | routes IT | 1 failed, 8 passed | "refuses a malformed file with a reason per line, stores nothing, and audits the refusal …" |
| T7 | CSV duplicate check off | `csv.test.ts` | 2 failed, 9 passed | "refuses a duplicate key, …"; "reads the browser-acceptance files …" |
| T8 | `VALUATION_SOURCES` gains `GUIDE` | `asset-input.test.ts` | 1 failed, 58 passed | "rejects {"source":"GUIDE"} on source" |
| T9 | revaluation LTV for leases | `revaluation.test.ts` | 1 failed, 4 passed | "shows no LTV for a lease: …" |
| T10 | synthetic provider's read without the simulation guard | `providers.test.ts` | 1 failed, 3 passed | "refuses the synthetic guide on a deployed build …" |
| T11 | CSV formula check only for `=` | `csv.test.ts` | 1 failed, 10 passed | "refuses a cell a spreadsheet would run as a formula, …" (`@v`) |

### Review round 1 (PR #229): repros and new rule tests written first

The reviewers' repros (legal, arch, breaker, edge, tests) were inverted where
they documented a hole, and tests were added for every rule this round adds.
They were run against 5e251bdb on a migrated throwaway database:
`Test Files 8 failed | 12 passed | 1 skipped (21)`, `Tests 16 failed | 96 passed`.

Red cases:
- the s127 surrender and the s131 and non-NCA recovery VALUED on a GUIDE valuation;
- breaker B1–B4;
- the synthetic ⇒ simulated, move-time and successor rules;
- the İsuzu/Isuzu upload (a thrown 23505);
- the 6 MB body;
- both midnight cases;
- the purchase picker;
- the offset clamp.

After the fixes (migrations `20261021090200` edited in place and
`20261021090300`; the TS changes):
- `lib/valuation-guides/` plus the lease panel: 116 passed, 1 skipped (after the restores below too).
- Every `RUN_ASSET_FINANCE_*_IT` with `TENANT_RLS=on`: `Test Files 323 passed | 9 skipped (332)`, `Tests 2820 passed | 41 skipped`.

### Review round 1 mutations (database; applied to the migrated database, then restored)

| # | Mutation | Suite | Result | Red tests |
|---|---|---|---|---|
| R1-F1 | `guardValuationGuide` without `AND g."id" <> NEW."id"` (self-supersede) | gaps, breaker, rules ITs | 1 failed, 26 passed | "never supersedes a guide by itself". Note: a self-supersede is still refused by two other rules (the successor must be a DRAFT; the deferred check). The test proves the clause refuses on its own by taking those two out, and here it failed because the clause it removes was already gone. This clause is defence in depth, not a lone guard. |
| R1-F2 | GUIDE trigger: the make comparison → `FALSE` | gaps IT | 1 failed, 9 passed | "reads a row of the asset's own make and year, not only its model" |
| R1-F3 | GUIDE trigger: no year comparison | gaps IT | 1 failed, 9 passed | same test |
| R1-F4 | DRAFT>PUBLISHED allow-list + `uploadedById`, `simulated` | gaps IT | 1 failed, 9 passed | "lets a move change only its own columns …" |
| R1-F5 | DRAFT>DISCARDED allow-list + `name` | gaps IT | 1 failed, 9 passed | same test |
| R1-F6 | PUBLISHED>SUPERSEDED allow-list + `publishedById` | gaps IT | 1 failed, 9 passed | same test |
| R1-F15 | no `NEW."publishedAt" := now()` | gaps + breaker ITs | 6 failed, 11 passed | "dates every move itself …"; B3. Also every publish now passing no time ("lets a move change …", the cycle and self tests, B5): the status-shape CHECK refuses it. |
| R1-F16 | successor need not be a DRAFT | gaps + breaker ITs | 2 failed, 15 passed | "supersedes a guide only by a draft put live in the same transaction …"; "never supersedes a guide by itself" |
| R1-F19 | `guardSurrenderRequest`'s GUIDE refusal off | statutory IT | 1 failed, 2 passed | "refuses a GUIDE valuation as an s127 surrender's valuation …" |
| R1-F20 | `guardRecovery`'s GUIDE refusal off | statutory IT | 2 failed, 1 passed | NCA s131 and non-NCA recovery VALUED |
| R1-C | drop each of `ValuationGuide_name`, `_provider`, `_sha256`, `_row_count`, `_status_shape` | gaps + breaker ITs | 1 failed, 16 passed each | "holds a guide to its name, source, hash, row count and status shape (CHECKs)" |
| R1-C | drop `ValuationGuide_synthetic_simulated` | gaps + breaker ITs | 2 failed, 15 passed | "keeps a synthetic guide simulated …"; B2 |
| R1-C | drop `ValuationGuide_times` | gaps + breaker ITs | 2 failed, 15 passed | "keeps … the move times in order"; "dates every move itself …" |
| R1-I | drop `ValuationGuideRow_line_key` | gaps IT | 1 failed, 9 passed | "holds a row's line number to one row" |
| R1-T | disable both `_no_truncate` triggers | gaps IT | 1 failed, 9 passed | "refuses TRUNCATE on both guide tables …" |

### Review round 1 mutations (source; restored after each, `git diff` clean)

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| R1-T12 | `publishGuide` without its not-yet-effective check | gaps-routes IT | **survived** (4 passed) | Equivalent now: the database refuses the publish and `publishGuide` maps that refusal to the same `not_yet_effective` 409 (the midnight mapping, R1-T20). The TS check only spares the database a round trip. |
| R1-T13 | without the older-than-current check | gaps-routes IT | 1 failed, 3 passed | "refuses a guide dated before the current guide of its name with 409 …" |
| R1-T14 | without the simulated-guide check | gaps-routes IT | 1 failed, 3 passed | "refuses to take a simulated guide live on a deployed build" |
| R1-T15 | revaluation reads SUPERSEDED guides too | revaluation-store IT | 1 failed, 2 passed | "values on the current guide only, never the one it superseded" |
| R1-T16 | newest guide value ordered ascending | revaluation-store IT | 1 failed, 2 passed | "keeps the variant of the asset's newest guide value …" |
| R1-T17 | live loans = ACTIVE only | revaluation-store IT | 2 failed, 1 passed | "lists every live loan …"; "values on the current guide only …" |
| R1-T18 | upload without the `lower()` re-check | edge-unicode + breaker ITs | 2 failed, 7 passed | İsuzu/Isuzu; B4 (both now throw 23505) |
| R1-T19 | record: midnight refusal not mapped | midnight IT | 1 failed, 1 passed | "records nothing, with 409, when the day turns …" (500) |
| R1-T20 | publish: midnight refusal not mapped | midnight IT | 1 failed, 1 passed | "refuses the publish with 409 when the app's day …" (500) |
| R1-T21 | purchase picker without the source filter | lease panel unit | 1 failed, 10 passed | "offers only assessors' and dealers' valuations …" |
| R1-T22 | body cap off while streaming | gaps-routes IT + upload-body unit | 2 failed, 5 passed | "refuses a body over the cap …"; "stops a stream with no length …" |
| R1-T23 | `?offset` not clamped to the row count | guide-view unit | 1 failed | "reads a whole number within the guide's rows …" |

### Review round 1 addendum (items 6b–6d)

New: `lib/valuation-guides/loaders.integration.test.ts`, which runs the loaders
that `RecoveryPanel.test.tsx` and the panel test mock out, and a record-time
simulation gate test in `guide-gaps-routes.integration.test.ts`. The
`ValuationGuideRow_line_key` refusing test is R1-I above.

| # | Mutation | Suite | Result | Red tests |
|---|---|---|---|---|
| R1b-L-make | `guideCandidates` without the make match | loaders IT | 2 failed, 2 passed | "offers only rows of the asset's own make, model and year"; the panel's candidates |
| R1b-L-year | `guideCandidates` without the year match | loaders IT | 2 failed, 2 passed | same two |
| R1b-L-order | `latestGuideValuation` oldest first | loaders IT | 3 failed, 1 passed | the newest value, the panel, the recovery reference |
| R1b-L-tenant | `latestGuideValuation` without its tenant filter | loaders IT | 3 failed, 1 passed | same three (another lender's asset id answered) |
| R1b-GP-swap | `loadGuidePanel` trade LTV on the retail value | loaders IT | 1 failed, 3 passed | "gives the panel … LTV against its trade and retail values" |
| R1b-GP-tenant | `loadGuidePanel` without its tenant filter | loaders IT | 1 failed, 3 passed | same test |
| R1b-RP-sim | `loadGuideReference` without "(simulated)" | loaders IT | 1 failed, 3 passed | "gives the recovery its newest guide value as a labelled reference" |
| R1b-A-snapsim | GUIDE trigger snapshots `'simulated', false` (database) | gaps + loaders ITs | 3 failed, 11 passed | "snapshots whether the guide was simulated …"; the newest value; the recovery reference |
| R1b-L-sim | `recordGuideValuation` without its simulation gate | gaps-routes IT | 1 failed, 4 passed | "refuses to record a simulated guide's value on a deployed build …" (201, a valuation written) |

6d: no database backstop for the simulation gate, by design (SLICE5.md Part C,
known limitations): the database cannot read the deployment's environment.
The gate is tested at load, publish (R1-T14) and record (R1b-L-sim).


### Review round 2 (PR #229)

**Written first.** Against f88afc39, breaker R2-1 was red. The supersede was dated `now()`, the start of its transaction, which fell before a rival publish that had already committed, so `ValuationGuide_times` refused it.

**Fix.** The guard now dates moves with `clock_timestamp()` (`20261021090300`, edited in place before any shared database applied it). A residual times-CHECK refusal is mapped to the 409 `concurrent_publish`.

**The tests reviewer's `lookup-gaps` repro was not committed.** Each of its five cases is already covered on the head it did not review (f88afc39):

| Case | Covered by |
|---|---|
| Candidate make and year | `loaders` IT (R1b-L-make, R1b-L-year) |
| `recordGuideValuation`'s simulation branch | `guide-gaps-routes` IT (R1b-L-sim) |
| `latestGuideValuation` order | `loaders` IT (R1b-L-order) |
| `loadGuidePanel` | `loaders` IT (R1b-GP-swap, R1b-GP-tenant) |
| `loadGuideReference` | `loaders` IT (R1b-RP-sim) |

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| R2-F1 | the guard dates a supersede with `now()` again (database) | breaker-r2 IT | 1 failed, 1 passed | "R2-1: a publish whose transaction began before the current guide was published can still supersede it" |
| R2-T1 | the times-CHECK refusal not mapped | breaker-r2 IT | 1 failed, 1 passed | "R2-1b: a residual clock race with a rival publish is a 409 …" (500) |
| R2-T2 | revaluation's newest valuation of any source but INTERNAL | revaluation-store IT | 1 failed, 3 passed | "keeps the recorded guide's name and variant, … a newer non-guide valuation does not hide it" |
| R2-T3 | `recordedVariant` without the variant comparison | revaluation-store IT | 1 failed, 3 passed | same test |
| R2-T4 | `recordedVariant` without the guide-name comparison | revaluation-store IT | 1 failed, 3 passed | same test |
| R2-T5 | CSV year bound 1950 → 1951; 2100 → 2099; the after-close-quote check off | `csv.test.ts` | 1 failed, 11 passed each | the year-range test; "refuses text after a closing quote in the same field" |
| R2-T6 | record-form choices without "simulated" | GuideValuePanel unit | 1 failed, 2 passed | "labels … a simulated guide's rows among the choices" |
| R2-T7 | `GUIDE_DAY_REFUSAL` reworded on the TS side only | migration static + midnight IT | 2 failed, 7 passed | "keeps the sentences the store maps to a 409 in the guards that raise them"; the midnight record test (500) |
| R2-S | a later migration rewrites `guardRecovery` without the GUIDE clause (a temporary `20991231000000_zz_mutation` dir, then removed) | migration static | 1 failed, 6 passed | "refuses GUIDE in the statutory guards, and no later migration rewrites either guard without it" |
