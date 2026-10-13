# Asset Finance — Design

Status: **design approved 2026-10-13 (grill-me), not built.** Slice 1 goal:
`.claude/handoffs/2026-10-13-asset-finance-slice1-goal.md`.

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
  audited and NCA → NON_NCA needs a second approver. A restructure or new
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
