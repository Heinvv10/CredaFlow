# Asset Finance — Design

Status: **design approved 2026-10-13 (grill-me).** Slices 1 and 2 built and
merged; slice 3 (operating and full-maintenance leases) built (C1–C12), legal and
tax wording to confirm, see "Slice 3" below. Slice 1 goal: `.claude/handoffs/2026-10-13-asset-finance-slice1-goal.md`.

WesBank-type instalment sale and leasing of vehicles, tractors, TLBs and
yellow machinery. Borrowers are mostly companies and trusts, some sole
proprietors. Every product below is in scope; it ships in five slices.

## Products

| Product | Ownership | NCA? | VAT | Engine |
|---|---|---|---|---|
| Instalment sale (HP) | passes on final payment | if the borrower is NCA | full cash price at inception | amortising, balloon |
| Finance lease | passes at end | if the borrower is NCA | full cash price at inception (tax memo to confirm) | amortising, residual |
| Operating lease | never passes | no (rental, CPA) | per rental | rental pattern, lender owns asset |
| Full-maintenance lease | never passes | no | per rental (rental + maintenance lines) | rental + maintenance fund |

Out of scope everywhere: GL, depreciation runs and VAT201 (they live in the
accounting system; CredaFlow exports journals — decision D3).

## Locked decisions

- **D1 Borrower.** `Client` stays natural-person only (keyed on SA ID). New
  `BusinessEntity` (COMPANY, CC, TRUST, PARTNERSHIP; registration number;
  turnover and asset value with evidence document ids) and
  `EntityRelationship` (entity ↔ `Client`, role DIRECTOR / MEMBER / TRUSTEE /
  SURETY / AUTHORISED_SIGNATORY, flags `isNaturalPerson`-style trustee type
  for the classifier). Applications and loans carry exactly one of
  `clientId` / `entityId`, enforced by a CHECK. A sole proprietor is a
  `Client` borrower.
- **D2 Scope.** All four products.
- **D3 Sub-ledger.** CredaFlow owns contracts, schedules, tax invoices, the
  asset register (cost, residual) and maintenance-fund balances, and emits a
  dated, reconcilable journal export per period. IsaFlow integration first,
  CSV for other systems.
- **D4 Rates.** Fixed, or `reference + margin` where the reference is PRIME,
  REPO, JIBAR/ZARONIA or the lender's own base rate. Reference values are a
  dated table per tenant; each contract keeps its rate history. Interest
  accrues daily (actual/365) on the reducing balance. When the reference
  moves, recompute the instalment and keep the term and balloon unchanged;
  NCA contracts re-check the cap on every repricing.
- **D5 NCA classifier.** A pure function
  `classifyNcaRegime(input) → { regime: NCA | NON_NCA, rule, evidence }`.
  Decided once, at application, on documents (AFS or management accounts;
  Letters of Authority). Unproven input → NCA. A trust with fewer than three
  trustees, all natural persons, → NCA. Juristic person with turnover or
  asset value ≥ threshold → NON_NCA; below threshold and principal debt ≥
  large-agreement threshold → NON_NCA; otherwise NCA. Thresholds (R1m,
  R250k) live in config with their Government Gazette citation. The result
  and evidence ids are snapshotted on the application; an override is
  audited and every move to NON_NCA, a classifier result included, needs a
  second approver (the application stays NCA until then). A restructure or new
  agreement re-runs it. **Legal must confirm these rules.**
- **D6 Structure.** A deal's structure is `deposit`, `balloon/residual`,
  optional `vatDeferral { periods }` and an ordered list of period weights
  (1 normal, 0 skip, n seasonal). A solver finds the base instalment B so
  that the scheduled payments `B × weight` plus the balloon repay the
  financed amount at the contract rate. Presets (MONTHLY, ANNUAL_SEASONAL,
  BIANNUAL, SKIP_N, STEP_UP) are saved weight patterns. Later, a
  fixed-amount-per-period mode sits beside weights if bespoke cashflows are
  needed. NCA deals run the same solver, then the cap and disclosure checks.
- **D7 VAT.** One `lib/vat/` module with a per-tenant vendor number and a
  date-effective rate table. Instalment sale / finance lease: one tax invoice
  for the full cash price + VAT at inception. Operating lease: a tax invoice
  per rental. Interest is exempt; fees and maintenance are standard-rated.
  `TaxInvoice` / `TaxInvoiceLine` / `CreditNote` rows hold the copied-in
  amounts and are immutable (DB trigger), sequentially numbered per tenant.
  **A tax-advisor memo on supply timing must be signed before slices 1 and 3
  ship.**
- **D8 Payout.** Payout goes to the supplier, never the borrower (except a
  refinance or sale-and-leaseback, which settles the existing financier
  first). It is DB-gated on a per-product checklist: signed agreement,
  suretyships and resolution; supplier invoice in the lender's name with the
  serial/VIN matching the asset; supplier bank AVS; insurance noting the
  lender; tracker confirmed; delivery and acceptance; eNaTIS titleholder
  where registered. Each item records who and when (audited). Book-wide
  duplicate serial/VIN check. A `Supplier` register separate from clients;
  supplier bank changes need a second approver. Two approvers above a
  tenant-set amount.
- **D9 Slices.** See below. Each is feature-flagged per tenant
  (`TenantConfig.featureAssetFinance`).

## How it fits the existing code

- **Ledger reuse.** A booked deal is a `Loan` plus `RepaymentSchedule` rows,
  so receipts (`lib/loan/apply-payment.ts`, `receipt-allocation.ts`), bank
  sync, balances and statements keep working. New columns on `Loan`:
  `entityId`, `ncaRegime`, `contractType`, `balloonAmount`, `rateBasis`.
  `Loan.clientId` and `LoanApplication.clientId` become nullable under the
  D1 CHECK; `tsc` lists every reader that must handle an entity borrower.
- **New origination path.** Asset deals do not go through
  `app/api/applications/[id]/disburse/route.ts`. That route is built around
  consumer PASQ, affordability and credit-life evidence. Asset finance gets
  its own approve, contract and payout routes under
  `app/api/asset-finance/`, which book the `Loan` in one transaction.
- **Calculator.** `lib/loan-calculator.ts` produces only equal instalments
  with terms in days. The solver is a new pure module
  `lib/asset-finance/structure.ts` (months, weights, deposit, balloon, daily
  accrual). `calculateLoan` is not changed.
- **Regime gates.** Today nothing keys on NCA applicability:
  `lib/collections/section129-eligibility.ts` would send s129 notices on a
  NON_NCA loan, and the s126 allocation, Reg 42 fee cap and default-charge
  caps are applied unconditionally. Every one of those reads `ncaRegime`
  (NON_NCA → no s129, product-configured default interest, no NCA caps).
  Consumer bureau submission (`lib/bureau-submission/`) excludes
  entity-borrower loans.
- **Portal.** Portal auth is per `Client`. A `Client` with an
  `EntityRelationship` that grants authority (director, trustee, authorised
  signatory) sees and acts on that entity's applications and contracts.
- **Documents.** Agreements, suretyships, resolutions and tax invoices are
  rendered with `pdf-lib` like `lib/pdf/`. Signing supports the existing
  per-signer e-sign and wet-ink upload confirmed by staff. Agreement text is
  supplied by the client's legal team; until then it renders with a DRAFT
  watermark and can't be executed.

## New data (outline; slice goals hold the exact shapes)

`BusinessEntity`, `EntityRelationship`, `EntityFinancials` (credit-memo
inputs), `FinancedAsset` (class, make/model/year, serial/PIN, VIN, engine no,
reg no, hours/odometer, cost ex-VAT, VAT, residual, eNaTIS titleholder,
tracker id, insurer + policy + noted-interest flag), `AssetValuation`
(dated, source, valuer), `Supplier` + `SupplierBankAccount`,
`ReferenceRate` (tenant, basis, effective date, value), `ContractRate`
history, `DealStructure` (deposit, balloon, weights, VAT deferral),
`PayoutChecklistItem`, `Payout`, `TaxInvoice` / `TaxInvoiceLine` /
`CreditNote`, `VatConfig`. Later slices: `MaintenanceFund` and its
movements, `LeaseRental`, `Repossession`, `RemarketingSale`, `JournalExport`,
`Dealer`.

## Slices

1. **Non-NCA instalment sale for companies and trusts, end to end.** Entity
   model and onboarding (CIPC data, trust deed, Letters of Authority,
   resolutions, beneficial owners); the classifier; the credit memo (AFS and
   bank-statement figures → DSCR and gearing, a decision with reasons;
   directors and trustees get the existing consumer bureau check); the asset
   register and manual valuations; the structure solver and reference
   rates; the VAT module and inception tax invoice; suretyships; e-sign and
   wet-ink signing; the supplier register and payout gate; booking to
   `Loan`; receipts; arrears with product-configured default interest and
   reminders; portal access for authorised parties. A deal classified NCA is
   refused in slice 1 with a clear message, not booked.
2. **Finance lease and the NCA path** (sole proprietors, small trusts,
   small juristic deals): caps on interest, initiation fee and service fee;
   cost-of-credit disclosure; NCA affordability using business income;
   s129; s127 voluntary surrender; existing NCA documents adapted.
3. **Operating and full-maintenance leases:** rentals and per-rental tax
   invoices, maintenance fund and claims, end-of-term inspection,
   excess-hours and wear billing, asset return.
4. **Repossession and remarketing; journal export and IsaFlow integration.**
5. **Dealer/broker portal, tracker/telematics integration, valuation
   feeds.**

## Slice 3: operating and full-maintenance leases (built; legal and tax to confirm)

Code: `lib/asset-finance/lease-*.ts`, `cpa-scope.ts`, `documents/lease/`;
migration `20261014090000_asset_finance_lease_foundation`.

- **Regime.** A lease is written NON_NCA with rule `LEASE_NOT_CREDIT_AGREEMENT`
  at creation, for an entity or a sole proprietor (`Client`): ownership never
  passes, so the NCA "lease" definition is not met. No classifier run, no
  override: the rule is bound in the database to the deal's contract type
  (both ways, at commit) and can never be set or dropped by an update.
  // UNTESTED: legal. Consumer bureau files exclude every lease.
- **CPA scope** (`classifyCpaScope`): natural person → applies; juristic
  person with verified turnover or asset value ≥ R2m → does not; anything
  unproven → applies. Snapshotted on the deal (re-run at submit, frozen at
  approval) and copied to the loan.
- **Pricing** (`lease-pricing.ts`, on the structure engine). Capital = cash
  price ex VAT (the lessor claims the input VAT); no deposit, trade-in, fee
  or VAT deferral (a rental in advance is the ADVANCE timing). The residual is
  the balloon: the balance after the LAST rental (on an ADVANCE lease one
  month before the term ends, not discounted for that month). ADVANCE: the
  first rental falls due on the commencement date, which is the deal's first
  due date (the planned start must equal it). Escalation is a weight per
  year, (1 + e)^year to 6 decimals. Maintenance (FML) has its own escalation
  and is not capital. VAT per line, half-up, at the rate on the commencement
  date.
- **Ledger mapping** (`lease-ledger.ts`). A lessee owes rentals, not capital
  and interest. Each schedule row: `principalDue = totalDue` = rental +
  maintenance + VAT; `interestDue = feesDue = 0`. `Loan.principal =
  totalRepayable` = Σ rentals incl. VAT; `totalInterest = 0`;
  `balloonAmount = null`. So receipts, bank sync, arrears (unpaid rentals),
  reminders and NON_NCA default interest work unchanged. The capital pricing
  survives in `assetFinanceOpeningBalanceCents` (repricing re-solves it) and
  each row's `LeaseRental` holds the rental / maintenance / VAT split.
  For a lease the ledger's "settlement" figure is the rentals outstanding
  (incl. charges): what the lessee would pay to prepay every rental, which
  invoices each rental at receipt. It is not an early termination: ending a
  lease early is by quotation only (C8), and the asset still comes back.
  Screens label it as rentals outstanding; the NCA certificate of balance is
  refused for a lease. Leases have their own statement
  (`documents/lease/statement-pdf.ts`), not the credit statement.
- **Tax invoices** (`lease-invoices.ts`): one per rental, supply date = the
  earlier of the due date (daily cron) and a receipt that reaches it (all
  three receipt paths). Exactly once: row lock + unique `taxInvoiceId`. No
  inception invoice. // UNTESTED: tax memo pending. // PARTIAL: a VAT-rate
  change after booking is refused (`vat_rate_changed`), not re-priced.
- **Repricing** (`lease-reprice.ts`): term and residual unchanged; the
  uninvoiced rentals outside the notice window take the new rental, their
  VAT and total; maintenance never changes. The `LeaseRental` amounts change
  only inside the repricing flag, never once invoiced.
- **Payout checklist**: the same items; a leased vehicle's eNaTIS **owner**,
  not only the titleholder, must be the lender (`FinancedAsset.natisOwner`).

### Servicing (C5–C8)

Migration `20261014100000_asset_finance_lease_servicing`; staff routes under
`app/api/asset-finance/leases/[loanId]/`, portal routes under
`app/api/portal/asset-finance/leases/[loanId]/`. Every rule below is also a
trigger or CHECK, each proven by an IT that removes it
(`lease-servicing-rules-*.integration.test.ts`).

- **Maintenance fund** (FML, `maintenance-fund.ts`, `maintenance-claims.ts`).
  Opened at booking with the deal's risk model; each invoiced rental adds its
  maintenance (ex VAT). Claims name an approved supplier and the provider's
  invoice filed on the deal; no one approves their own claim, and a claim at
  or above `TenantConfig.maintenanceClaimDualApprovalCents` (default R50 000)
  needs two approvers. A claim is recorded as paid with a reference; nothing
  is paid out from here. No claim after the lease ends. At the end of term a
  LESSEE_SETTLED fund's deficit is billed on the end-of-term invoice and a
  surplus is recorded as a refund owed; a LENDER_RISK fund's balance stays
  with the lessor.
- **Meter readings** (`meter-readings.ts`): staff, or the lessee in the
  portal (today's reading, a running lease); never below an earlier reading
  nor above a later one. The booking records the start reading. Excess usage
  (`lease-usage.ts`) is billed at the end of term against the pro-rata
  allowance, and fails closed without a final reading.
- **End of term** (`lease-end-of-term.ts`, `lease-end-invoice.ts`), elected
  in the six months before expiry, one outcome, final:
  RETURN → inspection (damage items) → invoice (excess, damage, fund
  deficit) → paid → completed, asset back in stock.
  EXTEND → month to month: the daily cron appends one rental at a time at
  the last rental, until a month's notice ends it; then a return.
  PURCHASE → at least a valuation of the asset dated within
  `TenantConfig.leasePurchaseValuationMaxAgeDays` (30); a sale invoice;
  completes once paid and, for a registered asset, the eNaTIS change of
  ownership is confirmed. // UNTESTED: tax/legal.
- **Early termination** (`lease-termination*.ts`): a quote (staff, or the
  lessee in the portal), valid `TenantConfig.leaseTerminationQuoteValidDays`
  (10): PV of the remaining rentals ex VAT and maintenance at the contract
  rate + the deal's penalty % + arrears; a CPA lessee's on 20 business days'
  notice, its basis naming the Reg 5(2) factors. Accepting cancels the
  uninvoiced rentals after the termination date (their rows go to 0),
  invoices PV and penalty, and opens a RETURN end of term. // UNTESTED: legal.
- **Charges** (end of term, purchase, termination) are schedule rows of their
  own: the row's total is its tax invoice's total, never a rental's row or
  invoice, and a closed loan is reopened for it. Receipts settle them like
  rentals.
- **CPA expiry notice** (`lease-expiry.ts`, `lease-daily.ts`): for a CPA
  lessee, 40–80 business days before expiry, queued once as a staff bell
  item. // PARTIAL: nothing is sent to the lessee (no real messages without
  approval; the notice PDF is C9).

### Documents, screens, collections, seed (C9–C12)

- **Documents** (`documents/lease/`): the operating-lease and FML agreements
  (with the maintenance-and-usage annexure), the lease statement, and the CPA
  expiry notice, early-termination quote and inspection report. Real figures,
  placeholder legal text, the DRAFT watermark while
  `TenantConfig.assetFinanceLegalWordingApproved` is false; deterministic, so
  the sha256 binds what was signed. Staff and portal routes
  `.../leases/[loanId]/documents/[kind]`; every read is logged.
- **Staff**: lease fields and preview on the deal form (an ADVANCE lease
  sends its first due date as the start); `natisOwner` on the asset; a lease
  panel on the loan page (rentals and invoices, fund and claims, readings,
  end of term, quotes). **Portal** (the lessee, or the entity lessee's
  authorised people): rentals and invoices, fund and claims (FML), today's
  meter reading, quote and accept, the end-of-term choice in its window.
  Evidence: `docs/asset-finance/evidence/slice3/`.
- **Collections**: lease arrears use the NON_NCA charges and reminders; no
  Section 129 (`section129-eligibility.ts` refuses NON_NCA). IT:
  `lease-collections.integration.test.ts`.
- **Seed**: a company FML (LENDER_RISK, claims, readings), a sole-proprietor
  operating lease (CPA, an open quote) and a trust FML (LESSEE_SETTLED) with
  its RETURN elected (the inspection waits for the term's end, which a seed
  run on the booking day cannot reach), through the real lib functions. Acceptance:
  three lease deals with independent working (`__fixtures__/acceptance-lease-deals.ts`).
- // PARTIAL: the deal summary panel still shows deposit / trade-in / fees
  (R 0.00) for a lease; a claim's provider invoice must already be filed on
  the deal (no upload in the claim form); the portal loans list still says
  "loan" for a lease.

## Acceptance (every slice)

- 10–20 past client deals, anonymised to synthetic data, reproduce the
  client's figures to the cent: instalments, interest, VAT and settlement.
- Each DB-enforced rule has a `RUN_DB_IT` integration test that fails when
  the rule is removed.
- The solver is checked against an independent calculation and
  mutation-tested.
- Legal signs off the agreement and document wording; the tax memo covers
  slices 1 and 3.
- The flow is exercised in a browser against a seeded local DB, with
  screenshots.

## Open with the client (not blockers to building)

- Legal opinion on the classifier rules (D5) and the agreement wording.
- Tax memo on supply timing (D7), especially finance leases.
- The anonymised deal pack for acceptance.
- Commercial bureau contract (slice 1 uses a manual credit memo instead).
- Whether a funder or securitisation vehicle needs its own reporting.
