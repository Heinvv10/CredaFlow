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

### PR B carry-overs (website identity notice)

`dealer-website-identity-notice` IT now asserts the audit row's `noticeWithheld`
and has a positive control (a verified dealer-captured client is notified).

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| 19 | `app/api/website/apply/route.ts`: `if (notifyClient && !noticeWithheld)` → `if (notifyClient)` | dealer-website-identity-notice IT | 1 failed, 1 passed | "sends no identity notice to the dealer-typed address …" (`expected [ Array(1) ] to deeply equal []`) |
| 20 | same file: `noticeWithheld = notifyClient !== null` (withhold from everyone) | dealer-website-identity-notice IT | 1 failed, 1 passed | "sends the notice to the address on file once staff verified … (positive control)" |

Restored: 2/2.

## Part B

Tracker/telematics (SLICE5.md part B, "Mutation evidence"). Database: a
throwaway PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5b-<random>`, checked
with `it-db.sh check`, `npx prisma migrate deploy`. Suites run with
`RUN_ASSET_FINANCE_TELEMATICS_IT=1 npx vitest run --no-file-parallelism <suite>`.

How each mutation was applied and undone:

- **Database** (rows C, D, E, P, M, H, A, X): applied to the migrated
  database, the named suite run, then restored. A CHECK is re-added from the
  migration's own text, an index from its definition, a function from its
  `pg_get_functiondef` copy. A trigger branch is dropped by replacing its
  `RAISE` statement with `NULL;`, or by narrowing its `TG_OP` test where one
  `IF` serves several operations. After every restore, the catalog (function
  bodies, constraint and index definitions, trigger states of the eight
  tables) was compared with its state before the run: identical each time.
- **TypeScript** (rows T): the file edited, the suites run, the file copied
  back, then `git diff --quiet -- <file>` confirmed it equals HEAD.

### A harness gap the mutations found

The first run left four mutations alive: D1, H1, A1 and X2, the DELETE branch
of the device, held-reading, alert and access-log guards. The DELETE then
fell through to another branch, which still refused, with another message.
`ruleRefuses` should have caught the wrong message, and did not. Prisma's
default error format quotes the lines of source around the failing call, and
the regex is written in the same call as its attack (`ruleRefuses(db, G,
/never deleted/, (tx) => tx.trackerDevice.delete(...))`), so the refusal text
contained the regex's own source and matched. Every telematics suite now builds its client with
`errorFormat: "minimal"` (`telematicsTestClient()` in
`telematics.integration-fixture.ts`), so the regex sees only the database's
message. With that change all 15 telematics suites were still green, so no
assertion had depended on the quoted source. All four mutations then went red
(rows D1, H1, A1, X2 below are the re-run).

`ruleRefuses` and `attempt` in `lib/asset-finance/lease-servicing.integration-fixture.ts`
are shared, and other suites build `new PrismaClient()` the same way.
Their message checks can pass vacuously in the same manner. This PR does not
change them.

### Results

Every mutation turned a named test red. "Output line" is the first line of the
first failure; for a wrong refusal, the database's message is appended after
"…".

| # | Mutation | File | Suite: result | Test that went red | Output line |
|---|---|---|---|---|---|
| C1 | DROP CONSTRAINT "TenantConfig_telematics_retention_range" | migration `…160100` | purge IT: 1 failed, 2 passed | "refuses a stale position, deleting a business or a young event, truncating positions, and a retention outside 1 to 365 days" | `Error: expected a refusal matching /TenantConfig_telematics_retention_range/, got: ok` |
| C2 | DROP CONSTRAINT "TrackerDevice_provider_key" | migration `…160100` | devices IT: 1 failed, 4 passed | "checks the provider key, the device id and the removal shape" | `Error: expected a refusal matching /TrackerDevice_provider_key/, got: ok` |
| C3 | DROP CONSTRAINT "TrackerDevice_external_id" | migration `…160100` | devices IT: 1 failed, 4 passed | "checks the provider key, the device id and the removal shape" | `Error: expected a refusal matching /TrackerDevice_external_id/, got: ok` |
| C4 | DROP CONSTRAINT "TrackerDevice_status_shape" | migration `…160100` | devices IT: 1 failed, 4 passed | "checks the provider key, the device id and the removal shape" | `Error: expected a refusal matching /TrackerDevice_status_shape/, got: ok` |
| C5 | DROP INDEX "TrackerDevice_one_active_per_asset" | migration `…160100` | devices IT: 2 failed, 3 passed | "registers a registered provider's well-formed device, installed by today, audited; refuses the rest with reasons" | `AssertionError: expected { kind: 'ok', …(1) } to match object { kind: 'refused', status: 409 }` |
| C6 | DROP INDEX "TrackerDevice_one_active_per_external_id" | migration `…160100` | devices IT: 5 failed, 0 passed | "registers a registered provider's well-formed device, installed by today, audited; refuses the rest with reasons" | `AssertionError: expected { kind: 'ok', …(1) } to match object { kind: 'refused', status: 409 }` |
| C7 | DROP CONSTRAINT "TelematicsEvent_kind_shape" | migration `…160100` | devices IT: 1 failed, 4 passed | "stores no event for a removed device, nor under another provider, nor before its installation" | `Error: expected a refusal matching /TelematicsEvent_kind_shape/, got: ok` |
| C8 | DROP CONSTRAINT "TelematicsEvent_provider_event_id" | migration `…160100` | guards IT: 1 failed, 5 passed | "keeps an event immutable but for its meter outcome, set once and true to what was written" | `Error: expected a refusal matching /TelematicsEvent_provider_event_id/, got: ok` |
| C9 | DROP CONSTRAINT "TelematicsPosition_range" | migration `…160100` | guards IT: 1 failed, 5 passed | "binds a position to its position or alert event, within range, and never changes it" | `Error: expected a refusal matching /TelematicsPosition_range/, got: ok` |
| C10 | DROP CONSTRAINT "TelematicsHeldReading_decision_shape" | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /TelematicsHeldReading_decision_shape/, got: ok` |
| C11 | DROP CONSTRAINT "TelematicsAlert_status_shape" | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /TelematicsAlert_status_shape/, got: ok` |
| C12 | DROP INDEX "TelematicsAlert_one_unresolved" | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /Unique constraint failed/, got: ok` |
| C13 | DROP CONSTRAINT "AssetMeterReading_telematics_shape" | migration `…160100` | meter-route IT: 1 failed, 4 passed | "binds a TELEMATICS reading to its meter event's value, date and asset, with no client, and a staff one to a held reading" | `Error: expected a refusal matching /AssetMeterReading_telematics_shape/, got: ok` |
| C14 | DROP INDEX "AssetMeterReading_telematics_one_per_day" | migration `…160100` | meter-route IT: 1 failed, 4 passed | "writes a lease's days as TELEMATICS readings, holds the days above a later reading, one reading a day" | `Error: expected a refusal matching /Unique constraint failed\|AssetMeterReading_telematics_one_per_day/, got: ok` |
| C15 | DROP INDEX "TelematicsEvent_tenantId_provider_providerEventId_key" | migration `…160100` | ingest IT: 2 failed, 4 passed | "stores a poll once: the same events again, and two sweeps at once, add nothing" | `AssertionError: expected 372 to be +0 // Object.is equality` |
| D1 | `guardTrackerDevice`: the DELETE branch dropped (TRUNCATE only) | migration `…160100` | devices IT: 2 failed, 3 passed | "fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted" | `Error: expected a refusal matching /never deleted/, got: PrismaClientUnknownRequestError: … A tracker device's asset, provider, device id, installation date and creator are fixed` |
| D2 | `guardTrackerDevice`: the TRUNCATE branch dropped (DELETE only) | migration `…160100` | guards IT: 1 failed, 5 passed | "refuses TRUNCATE of the device, event, held-reading and alert tables by each one's own trigger" | `AssertionError: TrackerDevice: expected 'PrismaClientKnownRequestError: \nInva…' to match /never deleted; it is removed/` |
| D3 | `guardTrackerDevice`: the RAISE "registered ACTIVE…" becomes `NULL;` | migration `…160100` | devices IT: 2 failed, 3 passed | "fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted" | `Error: expected a refusal matching /installed no later than today/, got: ok` |
| D4 | `guardTrackerDevice`: the RAISE "creator are fixed…" becomes `NULL;` | migration `…160100` | devices IT: 2 failed, 3 passed | "fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted" | `Error: expected a refusal matching /device id, installation date and creator are fixed/, got: ok` |
| D5 | `guardTrackerDevice`: the RAISE "A removed tracker device is final…" becomes `NULL;` | migration `…160100` | devices IT: 2 failed, 3 passed | "fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted" | `Error: expected a refusal matching /A removed tracker device is final/, got: ok` |
| D6 | `guardTrackerDevice`: the RAISE "removed on a day between…" becomes `NULL;` | migration `…160100` | devices IT: 2 failed, 3 passed | "fixes a device's identity; is registered ACTIVE by today; removed once, between installation and today; final; never deleted" | `Error: expected a refusal matching /between its installation and today/, got: ok` |
| E1 | `guardTelematicsEvent`: the RAISE "Telematics events are deleted only by the purge…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "refuses TRUNCATE of the device, event, held-reading and alert tables by each one's own trigger" | `AssertionError: TelematicsEvent: expected 'PrismaClientKnownRequestError: \nInva…' to match /deleted only by the purge/` |
| E2 | `guardTelematicsEvent`: the RAISE "Only a heartbeat, ignition or position event…" becomes `NULL;` | migration `…160100` | purge IT: 1 failed, 2 passed | "refuses a stale position, deleting a business or a young event, truncating positions, and a retention outside 1 to 365 days" | `Error: expected a refusal matching /deleted \(the purge\)/, got: ok` |
| E3 | `guardTelematicsEvent`: the RAISE "of an active device of the tenant…" becomes `NULL;` | migration `…160100` | devices IT: 1 failed, 4 passed | "stores no event for a removed device, nor under another provider, nor before its installation" | `Error: expected a refusal matching /of an active device of the tenant/, got: ok` |
| E4 | `guardTelematicsEvent`: the RAISE "occurs between the device…" becomes `NULL;` | migration `…160100` | devices IT: 1 failed, 4 passed | "stores no event for a removed device, nor under another provider, nor before its installation" | `Error: expected a refusal matching /between the device's installation and now/, got: ok` |
| E5 | `guardTelematicsEvent`: the RAISE "outcome is set after the event is stored…" becomes `NULL;` | migration `…160100` | devices IT: 1 failed, 4 passed | "stores no event for a removed device, nor under another provider, nor before its installation" | `Error: expected a refusal matching /outcome is set after the event is stored/, got: ok` |
| E6 | `guardTelematicsEvent`: the RAISE "immutable but for…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "keeps an event immutable but for its meter outcome, set once and true to what was written" | `Error: expected a refusal matching /immutable but for a meter event's outcome, set once/, got: ok` |
| E7 | `guardTelematicsEvent`: the RAISE "RECORDED exactly…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "keeps an event immutable but for its meter outcome, set once and true to what was written" | `Error: expected a refusal matching /RECORDED exactly when its reading is written/, got: ok` |
| P1 | `guardTelematicsPosition`: the RAISE "never truncated…" becomes `NULL;` | migration `…160100` | purge IT: 1 failed, 2 passed | "refuses a stale position, deleting a business or a young event, truncating positions, and a retention outside 1 to 365 days" | `Error: expected a refusal matching /never truncated/, got: PrismaClientKnownRequestError: … A telematics position is its position or alert event's, on that event's device` |
| P2 | `guardTelematicsPosition`: the RAISE "position is never changed…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "binds a position to its position or alert event, within range, and never changes it" | `Error: expected a refusal matching /never changed/, got: ok` |
| P3 | `guardTelematicsPosition`: the RAISE "its position or alert event…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "binds a position to its position or alert event, within range, and never changes it" | `Error: expected a refusal matching /its position or alert event's, on that event's device` |
| P4 | `guardTelematicsPosition`: the RAISE "older than the tenant''s retention is not stored…" becomes `NULL;` | migration `…160100` | purge IT: 1 failed, 2 passed | "refuses a stale position, deleting a business or a young event, truncating positions, and a retention outside 1 to 365 days" | `Error: expected a refusal matching /older than the tenant's retention is not stored/, got: ok` |
| M1 | `guardTelematicsMeterReading`: the RAISE "A telematics reading is its meter event…" becomes `NULL;` | migration `…160100` | meter-route IT: 1 failed, 4 passed | "binds a TELEMATICS reading to its meter event's value, date and asset, with no client, and a staff one to a held reading" | `Error: expected a refusal matching /its meter event's value, unit, SAST date and asset/, got: ok` |
| M2 | `guardTelematicsMeterReading`: the RAISE "operating or full-maintenance lease of its asset…" becomes `NULL;` | migration `…160100` | meter-route IT: 1 failed, 4 passed | "keeps an instalment sale's (and a finance lease's) meter as a device reading, and the database refuses writing it" | `Error: expected a refusal matching /of an operating or full-maintenance lease of its asset/, got: ok` |
| M3 | `guardTelematicsMeterReading`: the RAISE "written only while the lease runs…" becomes `NULL;` | migration `…160100` | meter-route IT: 1 failed, 4 passed | "writes nothing from the end of the term, after an end of term or an accepted termination; the staff final reading still goes in" | `Error: expected a refusal matching /written only while the lease runs/, got: ok` |
| M4 | `guardTelematicsMeterReading`: the RAISE "written only by the staff member…" becomes `NULL;` | migration `…160100` | ingest IT: 1 failed, 5 passed | "holds the SPIKE reading as implausible; the pace rule refuses it unattended; a staff accept writes it, vouched" | `Error: expected a refusal matching /written only by the staff member who accepts it/, got: ok` |
| M5 | `guardTelematicsMeterReading`: the RAISE "ahead of three times…" becomes `NULL;` | migration `…160100` | ingest IT: 1 failed, 5 passed | "holds the SPIKE reading as implausible; the pace rule refuses it unattended; a staff accept writes it, vouched" | `Error: expected a refusal matching /may not run ahead of three times the contracted pace/, got: ok` |
| M6 | `guardTelematicsMeterReading`: the RAISE "acceptance of a held reading…" becomes `NULL;` | migration `…160100` | meter-route IT: 1 failed, 4 passed | "binds a TELEMATICS reading to its meter event's value, date and asset, with no client, and a staff one to a held reading" | `Error: expected a refusal matching /is the acceptance of a held reading/, got: ok` |
| M7 | `telematicsPaceCeiling`: the SQL ceiling at four times the pace, not three | migration `…160100` | meter-route IT: 1 failed, 4 passed | "telematicsPaceCeiling is paceCeiling, value for value" | `Error: expected the database to admit it, got: Error: {"start":50,"startDate":"2026-12-01","on":"2027-03-01","allowance":1000,"ceiling":1045}: SQL says 1377 {"message":"{\"start\":50,\"startDate\":\"2026-12-01\",\"on\":\"2027-03-0` |
| H1 | `guardTelematicsHeldReading`: the DELETE branch dropped (TRUNCATE only) | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /never deleted/, got: PrismaClientUnknownRequestError: … A held reading's event, lease, date, value and reason are fixed` |
| H2 | `guardTelematicsHeldReading`: the TRUNCATE branch dropped (DELETE only) | migration `…160100` | guards IT: 1 failed, 5 passed | "refuses TRUNCATE of the device, event, held-reading and alert tables by each one's own trigger" | `AssertionError: TelematicsHeldReading: expected 'ok' to match /held telematics reading is never dele…/` |
| H3 | `guardTelematicsHeldReading`: the RAISE "A held reading is its meter event…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /its meter event's value, unit, SAST date and asset/, got: ok` |
| H4 | `guardTelematicsHeldReading`: the RAISE "created HELD…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /created HELD/, got: ok` |
| H5 | `guardTelematicsHeldReading`: the RAISE "decided held reading is final…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /A decided held reading is final/, got: ok` |
| H6 | `guardTelematicsHeldReading`: the RAISE "reason are fixed…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /event, lease, date, value and reason are fixed/, got: ok` |
| H7 | `guardTelematicsHeldReading`: the RAISE "decider recorded…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "creates a held reading HELD from its meter event, decides it once, with a note to reject and the decider's own reading to accept" | `Error: expected a refusal matching /the reading its decider recorded from its event/, got: ok` |
| A1 | `guardTelematicsAlert`: the DELETE branch dropped (TRUNCATE only) | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /never deleted/, got: PrismaClientUnknownRequestError: … A telematics alert's event, device, asset, loan, kind, queue and first occurrence are fixed` |
| A2 | `guardTelematicsAlert`: the TRUNCATE branch dropped (DELETE only) | migration `…160100` | guards IT: 1 failed, 5 passed | "refuses TRUNCATE of the device, event, held-reading and alert tables by each one's own trigger" | `AssertionError: TelematicsAlert: expected 'ok' to match /alert is never deleted; it is resolved/` |
| A3 | `guardTelematicsAlert`: the RAISE "alert event of its kind…" becomes `NULL;` | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /raised by an alert event of its kind/, got: ok` |
| A4 | `guardTelematicsAlert`: the RAISE "loan is on its asset…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "raises an alert OPEN once on its asset's loan, and never changes an acknowledgement" | `Error: expected a refusal matching /alert's loan is on its asset/, got: ok` |
| A5 | `guardTelematicsAlert`: the RAISE "raised OPEN, once…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "raises an alert OPEN once on its asset's loan, and never changes an acknowledgement" | `Error: expected a refusal matching /raised OPEN, once,` |
| A6 | `guardTelematicsAlert`: the RAISE "first occurrence are fixed…" becomes `NULL;` | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /queue and first occurrence are fixed/, got: ok` |
| A7 | `guardTelematicsAlert`: the RAISE "resolved telematics alert is final…" becomes `NULL;` | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /A resolved telematics alert is final/, got: PrismaClientUnknownRequestError: … A telematics alert cannot move from RESOLVED to ACKNOWLEDGED` |
| A8 | `guardTelematicsAlert`: the RAISE "adds one occurrence…" becomes `NULL;` | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /adds one occurrence/, got: ok` |
| A9 | `guardTelematicsAlert`: the RAISE "cannot move from…" becomes `NULL;` | migration `…160100` | alerts IT: 1 failed, 3 passed | "the database keeps the lifecycle: a note to resolve, resolved is final, the queue is fixed, never deleted, one open item per kind" | `Error: expected a refusal matching /cannot move from OPEN to OPEN\|cannot move from ACKNOWLEDGED to OPEN/, got: PrismaClientUnknownRequestError: … An acknowledgement is not changed` |
| A10 | `guardTelematicsAlert`: the RAISE "acknowledgement is not changed…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "raises an alert OPEN once on its asset's loan, and never changes an acknowledgement" | `Error: expected a refusal matching /An acknowledgement is not changed/, got: ok` |
| X1 | `guardTelematicsPositionAccess`: UPDATE no longer refused | migration `…160100` | position-view IT: 1 failed, 4 passed | "keeps the access log append-only: no update, delete or truncate" | `Error: expected a refusal matching /append-only/, got: ok` |
| X2 | `guardTelematicsPositionAccess`: DELETE no longer refused | migration `…160100` | position-view IT: 1 failed, 4 passed | "keeps the access log append-only: no update, delete or truncate" | `Error: expected a refusal matching /append-only/, got: PrismaClientUnknownRequestError: … A position access names a loan on its asset and a device of that asset` |
| X3 | `guardTelematicsPositionAccess`: TRUNCATE no longer refused | migration `…160100` | position-view IT: 1 failed, 4 passed | "keeps the access log append-only: no update, delete or truncate" | `Error: expected a refusal matching /append-only/, got: PrismaClientKnownRequestError: … A position access names a loan on its asset and a device of that asset` |
| X4 | `guardTelematicsPositionAccess`: the RAISE "names a loan on its asset…" becomes `NULL;` | migration `…160100` | guards IT: 1 failed, 5 passed | "logs a position view only for a loan on its asset and a device of that asset" | `Error: expected a refusal matching /names a loan on its asset and a device of that asset/, got: ok` |
| T1 | no ON CONFLICT DO NOTHING (`skipDuplicates: false`) | `lib/telematics/ingest.ts` | ingest IT: 2 failed, 4 passed | "stores a poll once: the same events again, and two sweeps at once, add nothing" | `AssertionError: expected 4 to be +0 // Object.is equality` |
| T2 | `view_asset_position` a minimum role `"COLLECTIONS_OFFICER"`, not the list | `lib/registry/permissions/070-asset-finance-telematics.ts` | position-view IT, telematics/routes.test.ts: 3 failed, 7 passed | "refuses READONLY and INSURANCE_OFFICER with 403 and logs nothing" | `AssertionError: expected { kind: 'ok', position: { …(5) } } to match object { kind: 'refused', status: 403 }` |
| T3 | the access-log insert skipped | `lib/telematics/position-view.ts` | position-view IT: 4 failed, 1 passed | "shows a collections officer the latest position with its time, and logs who, when, which loan and which position" | `AssertionError: expected undefined to match object { …(6) }` |
| T4 | no tenure filter (retention only) | `lib/telematics/position-view.ts` | position-view IT: 1 failed, 4 passed | "never shows a position from outside this loan's tenure or older than retention, and logs a 'none' too" | `AssertionError: expected false to be true // Object.is equality` |
| T5 | no retention filter in the view | `lib/telematics/position-view.ts` | position-view IT, purge IT: 1 failed, 7 passed | "never shows a position from outside this loan's tenure or older than retention, and logs a 'none' too" | `AssertionError: expected { kind: 'ok', position: { …(5) } } to deeply equal { kind: 'ok', none: true }` |
| T6 | `assertSimulationAllowed` removed | `lib/telematics/providers/simulated.ts` | providers/simulated.test.ts, poll.test.ts, devices IT: 7 failed, 8 passed | "registers a registered provider's well-formed device, installed by today, audited; refuses the rest with reasons" | `AssertionError: expected { kind: 'ok', …(1) } to match object { kind: 'refused', status: 422, …(1) }` |
