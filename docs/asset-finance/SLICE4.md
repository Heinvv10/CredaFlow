# Asset finance slice 4a — recovery, remarketing, legal matter

Build spec for slice 4a. The goal file is
`.claude/handoffs/2026-10-15-asset-finance-slice4-goal.md` (in the main
checkout); the product decisions there (§2a) are fixed. 4b (journals, IsaFlow)
waits for PR #89. Every legal or tax rule below is `// UNTESTED:` until the
lender's legal team and tax adviser sign it off.

## Data (one additive migration)

All new tables are tenant-scoped: `tenantId`, `@@unique([tenantId, id])`,
composite FKs `(tenantId, x)` like `SurrenderRequest`, added to
`TENANT_SCOPED_MODELS` (`lib/tenant-scope.ts` + its snapshot test) and given the
RLS policy of `20261015130000_tenant_rls_new_scoped_models`. Every guard
trigger has a `_no_truncate` statement trigger. Errors use
`RAISE EXCEPTION USING ERRCODE = '23514'`. "Today" is
`(now() AT TIME ZONE 'Africa/Johannesburg')::date`. Business days use the
existing SQL `"isSaBusinessDate"(date)`.

### LegalMatter / LegalMatterStep

- `LegalMatter`: `loanId`, `attorneySupplierId` (→ `Supplier`, nullable until
  appointed), `attorneyAppointedOn` date?, `caseNumber?`, `court?`,
  `status OPEN | CLOSED`, `closedAt?`, `createdById`. One OPEN matter per loan
  (partial unique index).
- `LegalMatterStepKind`: `LETTER_OF_DEMAND, S129_SENT, SUMMONS_ISSUED,
  SUMMONS_SERVED, JUDGMENT, ATTACHMENT_ORDER, SHERIFF_RETURN, ASSET_RECOVERED,
  SETTLED, WITHDRAWN`.
- `LegalMatterStep`: `matterId`, `kind`, `stepDate` date, `note?`,
  `section129RecordId?` (→ `ComplianceRecord`, S129_SENT only),
  `correctsStepId?` (→ a step on the same matter), `evidenceDocumentId?`
  (→ `EntityDocument`, new `EntityDocumentType.LEGAL_DOCUMENT`), `recordedById`,
  `createdAt`. Append-only: UPDATE/DELETE/TRUNCATE refused.
- DB rules (`guardLegalMatterStep`, BEFORE INSERT):
  - Matter must be OPEN. `stepDate` not in the future.
  - S129_SENT: loan regime NCA; `section129RecordId` names a
    `ComplianceRecord` of the same tenant and loan with
    `type = 'SECTION_129_NOTICE'` and `status = 'COMPLETED'`.
  - SUMMONS_ISSUED, NCA loan: an S129_SENT step exists on the matter whose
    `stepDate` plus 10 SA business days is ≤ the summons `stepDate`
    (s129(1)/s130(1)(a)).
  - SUMMONS_ISSUED, NON_NCA loan: a LETTER_OF_DEMAND step exists with an
    earlier-or-same `stepDate`.
  - S129_SENT on a NON_NCA loan is refused.
  - ATTACHMENT_ORDER needs a JUDGMENT step on the matter.
  - `correctsStepId` names a step on the same matter.
- `LegalMatter` guard: tenant/loan immutable; CLOSED is terminal; once set,
  `attorneySupplierId` changes only by a new appointment (audited) — keep it
  simple: settable while OPEN.

### Recovery

- `RecoveryRoute`: `NCA_S127_SURRENDER, NCA_S131_ATTACHMENT, NON_NCA_VOLUNTARY,
  NON_NCA_COURT_ORDER`.
- `RecoveryStatus`: `RECOVERED, VALUED, VALUATION_NOTICE_ISSUED, LISTED, SOLD,
  PROCEEDS_APPLIED, FINAL_NOTICE_ISSUED, SHORTFALL_OPEN, SURPLUS_HELD, CLOSED,
  WITHDRAWN`.
- `Recovery`: `loanId`, `assetId`, `route`, `status`, `surrenderRequestId?`
  (unique), `legalMatterId?`, `recoveredOn` date, `location`, `condition`,
  `meterReadingId?` (→ `AssetMeterReading`), `valuationId?`
  (→ `AssetValuation`), valuation/final notice `path` + `sha256` (s131 only —
  s127 keeps its notices on `SurrenderRequest`), `settlementDueCents?`,
  `grossProceedsCents?`, `deductedCostsCents?`, `chargedCostsCents?`,
  `netProceedsCents?`, `shortfallCents?`, `surplusCents?`,
  `proceedsPaymentId?` (unique → `Payment`), `finalNoticeIssuedOn?`,
  `chargesFrozenFrom?` / `chargesFrozenUntil?` dates, `withdrawnReason?`,
  `closedAt?`, `createdById`.
- One open recovery per loan: partial unique index on `(tenantId, loanId)`
  where status not in (CLOSED, WITHDRAWN).
- `guardRecovery` (BEFORE INSERT/UPDATE/DELETE):
  - Insert status RECOVERED only; DELETE refused; loan/asset/route/tenant
    immutable; asset is the loan's asset; `contractType <> 'LOAN'`.
  - Route ↔ regime: `NCA_*` needs `Loan.ncaRegime = 'NCA'`, `NON_NCA_*` needs
    `NON_NCA`.
  - `NCA_S127_SURRENDER` needs `surrenderRequestId` (same loan); other routes
    must not set it.
  - `NCA_S131_ATTACHMENT` needs a `legalMatterId` whose matter has an
    ATTACHMENT_ORDER step. `NON_NCA_COURT_ORDER` needs a matter with a
    JUDGMENT step.
  - Transition matrix (anything else refused):
    - RECOVERED → VALUED (needs `valuationId`, valuation of this asset)
    - VALUED → VALUATION_NOTICE_ISSUED (NCA routes only; s127: the linked
      surrender is VALUATION_NOTICE_ISSUED; s131: notice path + sha set)
    - VALUATION_NOTICE_ISSUED → LISTED (NCA); VALUED → LISTED (NON_NCA only)
    - LISTED → SOLD (needs a COMPLETED `RemarketingSale`)
    - SOLD → PROCEEDS_APPLIED (needs `proceedsPaymentId` and the figure
      columns; `netProceeds = gross − deducted`, shortfall/surplus not both > 0)
    - PROCEEDS_APPLIED → FINAL_NOTICE_ISSUED (NCA only)
    - FINAL_NOTICE_ISSUED (NCA) / PROCEEDS_APPLIED (NON_NCA) →
      SHORTFALL_OPEN (shortfall > 0, `chargesFrozenUntil` set) |
      SURPLUS_HELD (surplus > 0) | CLOSED (both 0)
    - SHORTFALL_OPEN → CLOSED (loan settled or written off)
    - SURPLUS_HELD → CLOSED (the refund is RELEASED)
    - RECOVERED / VALUED / VALUATION_NOTICE_ISSUED / LISTED → WITHDRAWN
      (needs `withdrawnReason`)
  - NON_NCA routes never set notice columns.
  - Figure columns, `proceedsPaymentId` and freeze dates are write-once.
- The s127 route keeps today's surrender behaviour exactly: the existing
  surrender routes and tests are unchanged. Linking: staff create the recovery
  from a surrender once the asset is in the yard; the recovery's VALUED /
  VALUATION_NOTICE_ISSUED steps reuse the surrender's valuation and notice.
  Applying sale proceeds through the recovery moves the surrender to
  PROCEEDS_CREDITED with the same figures; its final notice is the existing
  `issueSurrenderNotice(…, "final")`, extended with the cost table. The
  standalone `creditSurrenderProceeds` refuses (409) once a recovery is linked
  (the sale is the only proceeds path then).

### Asset status

Add `RECOVERED` and `SOLD_IN_REMARKETING` to `AssetLessorStatus` (additive).
Creating a recovery sets the asset RECOVERED; a completed sale sets
SOLD_IN_REMARKETING; WITHDRAWN clears it back to null. A RECOVERED asset can't
go on a new deal (extend `guardAssetDealUnreleasedAsset` and `deal-create.ts`).

### RecoveryCost (immutable)

- `RecoveryCostType`: `TOWING, STORAGE, VALUATION, REPAIRS, ADVERTISING,
  AUCTION_COMMISSION, SHERIFF, INSURANCE, LEGAL_TAXED, LEGAL_CONTRACTUAL,
  OTHER`.
- Fields: `recoveryId`, `type`, `netCents`, `vatCents`, `grossCents`
  (CHECK = net + vat, all ≥ 0, gross > 0), `supplierId?`, `supplierInvoiceRef`,
  `incurredOn`, `treatment DEDUCT_FROM_PROCEEDS | CHARGE_TO_ACCOUNT`,
  `legalStepId?` (→ LegalMatterStep), `note?`, `recordedById`,
  `status PENDING | APPROVED | REJECTED`, `approvedById?`, `approvedAt?`,
  `createdAt`.
- Two people: inserted PENDING by the recorder; one UPDATE by a different
  user decides it (APPROVED or REJECTED). Only APPROVED costs count; proceeds
  are refused while any cost is PENDING.
- DB: a decided cost is immutable; DELETE/TRUNCATE refused; insert refused once the recovery is
  PROCEEDS_APPLIED or later. NCA recovery: `DEDUCT_FROM_PROCEEDS` only for
  types in `TenantConfig.recoveryNcaDeductibleCostTypes`; `CHARGE_TO_ACCOUNT`
  only for `LEGAL_TAXED`, and `LEGAL_TAXED` needs `legalStepId` naming a
  JUDGMENT or SETTLED step on the loan's matter. NON_NCA: either treatment for
  types in `TenantConfig.recoveryNonNcaChargeableCostTypes`. Allow-lists are
  `RecoveryCostType[]` columns with defaults (NCA deductible: TOWING, STORAGE,
  VALUATION, REPAIRS, ADVERTISING, AUCTION_COMMISSION, SHERIFF, INSURANCE;
  NON_NCA: all), `// UNTESTED:` legal sign-off.

### RemarketingSale

- `SaleChannel`: `AUCTION, DEALER, PRIVATE_TENDER, DEBTOR_OR_SURETY`.
- `RemarketingSaleStatus`: `PENDING_APPROVAL, COMPLETED, CANCELLED`.
- Fields: `recoveryId`, `channel`, `buyerType PERSON | ENTITY`, `buyerName`,
  `buyerIdentifier` (ID / registration number), `buyerAddress`,
  `buyerVatNumber?`, `priceInclVatCents`, `valuationId` (the independent
  valuation relied on), `highestValuationCents` (snapshot),
  `belowValuation` bool, `belowValuationReason?`, `relatedPartyMatch` bool,
  `screeningResult` Json (which lists matched — kinds and counts only, no
  names or ID numbers), `createdById`, `approvedById?`, `approvedAt?`,
  `completedAt?`, `taxInvoiceId?` (unique → TaxInvoice),
  `proceedsPaymentId?`, `createdAt`.
- One COMPLETED sale per recovery (partial unique index).
- `guardRemarketingSale`:
  - Recovery must be LISTED for insert and completion.
  - `valuationId`: this asset, source not INTERNAL, valued within
    `leasePurchaseValuationMaxAgeDays` of the sale date (the same age
    setting as `purchaseValuationOk`; any non-INTERNAL source, AUCTIONEER
    included).
  - `belowValuation` must equal `price < highest current independent
    valuation` (the trigger recomputes it); if true,
    `belowValuationReason` length ≥ 10.
  - If `belowValuation OR relatedPartyMatch`: COMPLETED needs
    `approvedById` not null and ≠ `createdById`.
  - COMPLETED / CANCELLED rows are immutable; completion needs
    `taxInvoiceId`.
- Related-party screening (TS, `lib/asset-finance/recovery-screening.ts`):
  normalise names (`normaliseName`) and identifiers (strip non-alnum, upper);
  compare against the borrower (client ID / entity registration and names),
  the deal's `EntityRelationship` clients (all roles, incl. sureties), active
  staff users of the tenant (name), and current-year `CoiDeclaration` rows
  with `hasConflict` whose `details` contain the buyer's normalised name or
  identifier. Store kinds/counts only. Audit flag
  `ASSET_REMARKETING_RELATED_PARTY_FLAGGED` on a match. The DB can't see
  hidden relationships, so the trigger also re-checks the borrower and
  `EntityRelationship` ID/registration match itself: a buyer identifier equal
  to the borrower's or any related client's `idNumber` forces
  `relatedPartyMatch = true`.

### RecoveryVatEvent (immutable)

- `kind`: `REPOSSESSION_DEEMED_SUPPLY` (instalment sale, finance lease) |
  `LESSOR_RESALE` (operating / FML lease asset resale).
- Fields: `recoveryId` (unique per kind), `eventDate`, `dealContractType`,
  `debtorVatVendor` bool, `debtorVatNumber?`, `deemedSupplyValueCents`,
  `inputTaxClaimCents`, `outputTaxCents`, `vatRateTenThousandths`, `basis`
  text, `recordedById`. UPDATE/DELETE/TRUNCATE refused.
- Pure function `lib/asset-finance/recovery-vat.ts`, `// UNTESTED:` tax memo:
  - Instalment sale / finance lease: s8(10) deemed supply by the debtor to the
    lender at repossession; value per s10(10) = the unpaid balance of the
    cash price (excl. finance charges) at repossession, capped at the
    VAT-inclusive cash price. Lender input tax = value × rate / (10000 +
    rate), half-up. Vendor debtor: the debtor accounts for output tax and
    issues the lender a tax invoice; non-vendor debtor: the lender claims
    notional input tax on the same value (s16(3)). Both paths record
    `inputTaxClaimCents`; `debtorVatVendor` records which.
  - Lessor resale: no deemed supply (the lessor owns the asset); output tax on
    the resale price only.
  - Resale to the buyer: output tax on the price, issued through
    `issueTaxInvoice` (`loanId` null, buyer as recipient).
  - Worked examples per deal type × vendor/non-vendor, derived by hand.

### RecoveryRefund (surplus payout)

`Payout` is deal-and-supplier-bound, so the surplus refund gets its own
table with the same controls:
`recoveryId` (unique), `amountCents` (= recovery surplus, trigger),
`accountHolder`, `bankName`, `branchCode`, `accountNumber`,
`bankVerifiedById` + `bankVerificationDocumentId` (→ EntityDocument; the
verification evidence), `status PENDING_APPROVAL | APPROVED | RELEASED`,
`createdById`, `approvedById?` (CHECK ≠ createdById), `releasedById?`,
`releasedAt?`. Releasing moves the recovery SURPLUS_HELD → CLOSED.

## Post-sale

- `applySaleProceeds`: loads `loanSettlementFigures` at the sale date;
  `net = gross − deducted`; `owed = settlement + charged`;
  shortfall = max(0, owed − net); surplus = max(0, net − owed). A real
  `Payment` via `applyManualReceipt` for `min(net, settlement)`, idempotency
  key `asset-recovery:<id>:proceeds`. Charged costs stay on the recovery (the
  shortfall figure includes them).
- Deadline: NCA = final notice date + 10 SA business days (s127(8));
  NON_NCA = proceeds date + `TenantConfig.nonNcaDemandPeriodDays` calendar
  days (default 10). Pure function `recoveryChargeFreeze()` in
  `lib/asset-finance/recovery-deadline.ts` using
  `addSouthAfricanBusinessDays`.
- Charges are frozen from the proceeds date through the deadline inclusive:
  `charges-replay.ts` gains a pause window from the loan's recovery
  (`chargesFrozenFrom..chargesFrozenUntil`); the charge engines accrue
  nothing on paused days and resume after. Existing NCA caps still apply.
- After the deadline the nightly job (or the next replay) accrues normally;
  the shortfall loan moves to collections (`collectionsStage` not regressed)
  and gets a bell item on the legal matter. Write-off is never automatic.
- Surplus → SURPLUS_HELD → RecoveryRefund (two people) → CLOSED.

## Legal matter behaviour

- Appointing the attorney: sets `attorneySupplierId`, upserts the loan's
  `AttorneyReferral` (firm name from the supplier), sets
  `collectionsStage = ATTORNEY_REFERRED` (no regression), audits. That stage
  is what makes the bureau staff view list an L as awaiting confirmation —
  nothing is sent; `lib/bureau-submission/*` is untouched.
- ASSET_RECOVERED step: creates (or links) the `Recovery` in the same
  transaction; route from regime + matter (NCA → S131 needs ATTACHMENT_ORDER;
  NON_NCA → COURT_ORDER needs JUDGMENT).
- Bell: new `NotificationType` `LEGAL_MATTER_NEXT_STEP`; after each step, the
  matter's creator and the attorney-appointer get the next-step reminder
  (e.g. "Summons may issue from <date>"). No names or ID numbers in the bell.
- Step evidence upload: `EntityDocument` (`LEGAL_DOCUMENT`) via
  `storeDealEvidenceDocument`, served via `serveEntityDocument` (logs
  `DocumentAccessLog`).

## API (all under `app/api/asset-finance/`, house route pattern)

`requireApiRole` → `withTenantContext` → `requireAssetFinanceEnabled` →
`canDo`. Writes `manage_asset_finance` (CREDIT_OFFICER) except: sale
approval, refund approval/release and cost approval → `decide_asset_finance`
(LOAN_ADMIN); proceeds → `record_payment`. Every write goes through
`logAuditStrict` in the same transaction. Lib returns `{kind}`; not_found →
404, not_ready → 409.

- `loans/[loanId]/legal-matter` POST (open), GET
- `legal-matters/[id]/attorney` POST, `legal-matters/[id]/steps` POST
  (multipart optional evidence), `legal-matters/[id]/steps/[stepId]/document` GET
- `loans/[loanId]/recoveries` POST (NON_NCA voluntary, or from a surrender)
- `recoveries/[id]` GET, `…/valuation` POST, `…/valuation-notice` POST (s131),
  `…/list` POST, `…/costs` POST, `…/sales` POST, `…/sales/[saleId]/approve`
  POST, `…/sales/[saleId]/complete` POST, `…/proceeds` POST,
  `…/final-notice` POST, `…/withdraw` POST, `…/documents/[kind]` GET,
  `…/refund` POST, `…/refund/approve` POST, `…/refund/release` POST,
  `…/close` POST
- Portal: `app/api/portal/asset-finance/loans/[loanId]/recovery` GET —
  status, notices issued, final shortfall/surplus and cost lines; never buyer
  details.

## Documents

- s127 final notice (`surrender-pdf.ts`): add a "RECOVERY COSTS" table after
  the existing lines when costs exist — new lines only, existing wording
  untouched, DRAFT watermark kept, marked for legal sign-off. Re-pin the
  render hash with a before/after proof.
- s131 valuation and final notices: new renderers in `recovery-pdf.ts`
  sharing the layout, titled "REPOSSESSED GOODS VALUATION NOTICE" and
  "REPOSSESSED GOODS FINAL ACCOUNT NOTICE", placeholder clauses only, DRAFT
  watermark.
- NON_NCA: a plain "post-sale account statement" (not an NCA document).

## Screens

- Staff loan view (`StaffAssetLoanView`): a Legal matter panel (steps
  timeline, add step, attorney, evidence) and a Recovery panel (status
  stepper, valuation, costs ledger, sale with screening result and approval,
  proceeds, notices, refund).
- Portal contract page: recovery status, notices, final account with cost
  lines.
- Tokens only (`--cf-*`), light/dark, 390 px.

## Seed

One recovered NCA instalment-sale deal (the sole-proprietor TLB) taken
through s131 to SHORTFALL_OPEN, and one NON_NCA lease recovery (the company
FML) at LISTED. Idempotent (runs twice cleanly).
