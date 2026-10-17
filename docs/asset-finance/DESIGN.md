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
| Finance lease | passes at end | if the borrower is NCA | full cash price at inception (signed off, see the sign-off record 2026-10-17 below) | amortising, residual |
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
  NCA contracts re-check the cap on every repricing. PRIME, REPO and ZARONIA
  are fetched on weekday mornings from the Reserve Bank's public feed
  (`lib/asset-finance/rate-feed-sync.ts`) and recorded PENDING with source
  `SARB_FEED` and no requester; the feed stands in for the recording person,
  so a fetched value needs one approver (a manual value still needs two
  people). Its effective date is the day the feed showed it, which can trail
  the real change; the approver checks it against the Reserve Bank's
  announcement. ZARONIA is recorded only when it moves 25 bp or
  more from the latest live value. JIBAR and the lender's base rate stay manual.
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
  Signed off (see the sign-off record 2026-10-17 below). Consumer bureau files exclude every lease.
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
  inception invoice. Signed off (see the sign-off record 2026-10-17 below). // PARTIAL: a VAT-rate
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
  ownership is confirmed. Signed off (see the sign-off record 2026-10-17 below).
- **Early termination** (`lease-termination*.ts`): a quote (staff, or the
  lessee in the portal), valid `TenantConfig.leaseTerminationQuoteValidDays`
  (10): PV of the remaining rentals ex VAT and maintenance at the contract
  rate + the deal's penalty % + arrears; a CPA lessee's on 20 business days'
  notice, its basis naming the Reg 5(2) factors. Accepting cancels the
  uninvoiced rentals after the termination date (their rows go to 0),
  invoices PV and penalty, and opens a RETURN end of term. Signed off (see the sign-off record 2026-10-17 below).
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

## Slice 4a: recovery, remarketing, legal matter (built; legal and tax to confirm)

Spec and rules: [`SLICE4.md`](SLICE4.md). Code: `lib/asset-finance/recovery-*.ts`,
`legal-matter-*.ts`, `documents/nca/recovery-pdf.ts`,
`documents/post-sale-statement.ts`, `components/asset-finance/recovery/`;
migration `20261015400000_asset_finance_recovery`. Evidence:
`evidence/slice4/`.

- One `Recovery` per loan at a time, on four routes: s127 surrender (the
  existing `SurrenderRequest` is its sub-record and keeps its notices), s131
  attachment and NON_NCA court order (both opened by the legal matter's
  ASSET_RECOVERED step), and NON_NCA voluntary. The status flow, route rules,
  write-once figures and asset status (`RECOVERED`, `SOLD_IN_REMARKETING`)
  are enforced by triggers.
- `LegalMatter` + append-only `LegalMatterStep`: an NCA summons waits for an
  s129 step plus 10 SA business days, a NON_NCA summons needs a letter of
  demand, an attachment order needs a judgment. Appointing the attorney on an
  NCA loan needs an issued s129 notice; it sets `ATTORNEY_REFERRED`, which
  makes the bureau screen propose an L. Nothing is sent automatically.
- Costs are recorded by one person and approved or rejected by another;
  only approved costs count. NCA deducts only the tenant's allow-listed
  sale costs; LEGAL_TAXED needs a judgment or settlement step.
- A sale needs a current non-INTERNAL valuation; below the highest one, or to
  a related party (borrower, surety, director, staff, COI), it needs a second
  approver. Proceeds are one real `Payment`; the resale tax invoice and the
  repossession VAT event (s8(10)/s10(10), signed off, see the sign-off record 2026-10-17 below) are immutable.
- A shortfall freezes charges from the proceeds date to the deadline (NCA:
  final notice + 10 business days; NON_NCA: tenant demand period), then
  collections resume via the nightly charges and a deadline cron. Write-off
  stays the manual two-person route. A surplus is a `RecoveryRefund`
  released by two people.

Known limits: only the loan's current recovery shows on the staff panel; an
NCA freeze is open-ended between proceeds and the final notice (the deadline
cron bells the recovery's creator once after 5 SA business days without a
final notice; charges stay frozen and nothing else happens; an s127 recovery
whose surrender's final notice was issued but whose own step failed still sits
at PROCEEDS_APPLIED, so it is reminded too, and retrying the final notice
completes the step); the
cost-type allow-lists, deadlines and VAT treatment await legal and tax
sign-off. 4b (journals, IsaFlow push) waits for PR #89.

## Slice 4b: asset-finance journals (built; accounting and tax to confirm)

Asset-finance contracts export through the accounting engine (`lib/accounting/`), never the consumer
sources. Sources: instalment sale and finance lease (financed amount at inception, then the interest
each row accrues, capitalised interest included, the balloon posts nothing), leases per tax invoice
(rentals, end-of-term and termination invoices, credit notes), credit notes on an inception invoice
or a repossession sale's invoice, the maintenance fund, and a repossession through `RECOVERY_CLEARING`
to nil. An instalment sale or finance lease posts its inception when the supplier payout is released
(each row's interest is `B(next) - B(this) + totalDue`); a lease's end-of-term and termination invoices
are schedule rows, so they sit on the receivable. A contract that predates the first open month posts
there, dated by origin. Every month ties to independent SQL and six controls
(VAT in and out, recovery clearing and result, refund payable, fund liability); a control that
differs refuses the close. Hand-worked acceptance deals are in
`lib/asset-finance/__fixtures__/acceptance-journal-*.ts` (`CLIENT_JOURNAL_DEALS` empty until the
client's accountant supplies signed journals). Browser evidence: `evidence/slice4b/`.

**UNTESTED: tax / accounting. Each needs the lender's accountant or tax adviser before go-live:**

- **Maintenance-claim input VAT is not posted.** A paid claim credits bank for its amount excluding
  VAT (`MaintenanceClaim.amountExclVatCents`); the supplier's VAT on it is neither claimed nor
  accounted for.
- **Charged-cost VAT.** A recovery cost charged to the account claims its input VAT, and the
  recharge to the borrower is the gross amount with no output VAT, so the VAT portion lands in
  profit and loss (via the recharge contra account).
- Input VAT claimed at inception on the dealer's invoice (an inception credit note leaves it claimed
  until the dealer credits the lender; reversing it then is the accountant's entry); interest recognised as it falls due (no
  deferred finance income); the recovery-result account (output VAT less the input VAT claimed on
  repossession and on deducted costs); the split of a credit note between rental, maintenance and
  asset-sale income, and that a credited maintenance contribution stays in the lessee's fund; the
  sale's cash taken in on the completion day; the lease asset's net book value is derecognised in
  the fixed-asset register, not posted.
- **Not exported yet (refuses the close):** a lease with a deposit or trade-in, and a credit note
  against an instalment sale's tax invoice other than its inception invoice (the app issues none).
- A credit note adjusts the ledger's lease or instalment debtors but not the loan's schedule: staff
  settle the schedule balance separately. No screen or route issues a credit note today; only
  `issueCreditNote` (`lib/vat/credit-note.ts`) does, and nothing reprices the schedule after one.
- **Credit note on an instalment sale's or finance lease's inception invoice:** Dr `AF_PRICE_CREDITS`
  (6400, new) the value excl. VAT, Dr output VAT; Cr instalment debtors incl. VAT, on its issue date,
  or with the inception when the payout is released later. The invoice is one line, the asset's cash
  price, so a credit lowers the price and the amount financed F by its incl. VAT value. The inception
  netted the sale to the debtor against the dealer's price and posted no sales account, so there is
  no income to reverse: the excl. VAT value is the lender's cost unless the dealer credits the lender
  in turn, which the accountant books against the same account (and reverses that input VAT). Fee
  income is untouched (financed fees are not on the invoice); input VAT is untouched (no dealer credit
  is recorded). The independent SQL subtracts the credit from what the schedule says is owed, as for a
  lease, so the receivable ties while the schedule still carries the full price.
  A credit is at the invoice's incl. VAT value, but the debtors were booked at F, which excludes the
  deposit and trade-in the debtor paid outside the contract. So a large enough credit on such a deal
  (the whole invoice, say) leaves instalment debtors in credit: on a R11 500.00 cash price with a
  R1 500.00 deposit (F R10 000.00), a full credit takes R11 500.00 off a R10 000.00 debt. That is the
  lender's policy, not a fault: refunding or offsetting the credit balance is the accountant's step,
  and the code leaves it as is (repro R1 in `lib/accounting/af-break-credit-notes.integration.test.ts`).
- **Credit note on a repossession sale's buyer invoice:** Dr output VAT, Dr `RECOVERY_CLEARING` excl.
  VAT; Cr bank incl. VAT, on its issue date. The sale source takes the buyer's cash in on the invoice
  date with no buyer debtor account (Q2 of the 4b spec), so the refund goes out the same way: a
  payable would never clear from data the app holds. The proceeds applied to the debtor are the sale
  price before the credit (`lib/asset-finance/recovery-proceeds.ts`), so the credit is the lender's
  loss: the result source sweeps it from clearing to `RECOVERY_RESULT` (a credit issued after the
  proceeds were applied moves the result in its own month), clearing stays nil, and the result
  control adds the credit's excl. VAT value.
- **Input VAT on a dealer that is not a VAT vendor.** The instalment-sale and finance-lease input VAT
  control reads the inception invoice's VAT, the same figure the journal posts, so it checks the date
  (posted once, when the supplier payout is released), not the dealer's own VAT. Whether the lender may
  claim that input VAT at all (for example from a non-vendor dealer) is the accountant's call.
- **VAT history carried in at go-live.** The opening entry carries the input and output VAT balances of
  every contract booked before go-live. The accountant clears what was already submitted to SARS before
  go-live against the legacy ledger; the export does not know what was submitted.
- **No fee-VAT split on asset finance.** A VAT-inclusive fee account (a lender's setting) splits VAT out
  of consumer fees only. An asset-finance contract's financed fees and default charges post gross: its
  VAT is the VAT of its tax invoices, which the VAT control reads. Whether VAT is due on a financed fee
  is for the tax adviser.
- A billed maintenance deficit credits the lessee's fund liability (it settles the fund) and not income.

## Slice 4b part 2: IsaFlow draft push (built against a fake IsaFlow; live push not yet done)

A tenant connects one IsaFlow company. After that, an ADMIN whose session verified a TOTP code
(always, whatever the lender's 2FA policy) pushes each closed month as ONE draft journal. Nothing is
posted in IsaFlow: the lender's accountant posts the draft. Code: `lib/accounting/isaflow/`.

- **Transport: IsaFlow's MCP endpoint.** `/api/mcp` JSON-RPC `tools/call`, with a personal access
  token (`pat_…`) that IsaFlow binds to one company. The REST journal endpoint takes only a session
  cookie and has no external reference. Everything above `client.ts` talks to `IsaFlowTransport`, so
  a REST adapter can replace `mcpTransport` once IsaFlow ships Bearer auth plus `external_ref`.
  Contract with IsaFlow file:line references: `contract.ts`. `contract.test.ts` pins the fake to it.
- **Connection** (`IsaFlowConnection`, one per tenant). Connect, verify and disconnect go through
  `superAdminPolicyWrite` (a TOTP-verified SUPER_ADMIN, re-checked on the locked row).
  - The IsaFlow calls (`list_companies` for the bound company id, `list_gl_accounts` to prove
    `read:reports`) run in its `prepare` step, before the write's transaction. They write nothing:
    a refusal, and a token IsaFlow no longer takes, are recorded inside the write, after the role
    re-check. `company_profile` has no id.
  - A token IsaFlow refuses on any path (verify, chart read, send, read-back) moves the connection
    to NEEDS_RECONNECT, drops the token and writes an `ISAFLOW_NEEDS_RECONNECT` audit row.
  - The token is sealed with `sealCredential` and opened strictly. It is never returned and never
    audited.
  - The base URL must be an origin listed in `ISAFLOW_ALLOWED_ORIGINS`. An https origin must
    resolve to public addresses only (`lib/lender-api/webhooks/ssrf.ts`). Every request dials
    through `guardedLookup` (`dial.ts`), so the address connected to is the one checked at that
    moment: a listed name that re-points to a private address is refused (DNS rebinding).
    Redirects are not followed.
  - http is accepted only for a listed loopback origin, under NODE_ENV `development` or `test`. That
    covers the fake, `scripts/fake-isaflow.ts`.
  - The database refuses CONNECTED unless `connectedWithTotp` is set and the connector is an active
    SUPER_ADMIN of the tenant. It also refuses an unsealed token, and a token on a connection that
    is not CONNECTED (`guardIsaFlowConnection`).
- **Push** (`AccountingIsaFlowPush`, one per CLOSED batch). Nothing is claimed or sent before each
  check passes:
  - the batch's digest;
  - every line's role has a stored mapping to the line's code, and no line carries a tax code;
  - every code exists once and is active in IsaFlow's chart. Otherwise a 422 lists the codes.

  Then the request is built once: net per account, rands to 2 dp, dated the last day of the month,
  memo `CredaFlow journals <month> [credaflow:<batchId>]`, `company_id` asserted. It is stored with
  the SENDING claim and sent under `credaflow:batch:<batchId>`. IsaFlow replays the same key with the
  same arguments, so a resend never makes a second draft.
- **Before any retry**, IsaFlow is read back: `list_journals`, drafts of that day, with lines. This
  covers a FAILED push pushed again, and a NEEDS_REVIEW push checked. A draft with the memo tag and
  identical lines is the push (PUSHED, `foundOnReadBack`). A tagged draft with other lines waits
  for a person. Otherwise the stored request is resent byte for byte with the same key, and the
  draft IsaFlow answers with counts only if a second read-back finds it.
  - SENDING for 10 minutes becomes NEEDS_REVIEW.
  - An auth refusal drops the token (NEEDS_RECONNECT).
- **Guards** (`20261016100000_isaflow_connection_push`): a copy of the Xero push guard, plus:
  - request, hash, key, reference and IsaFlow company are immutable;
  - the journal id is written once, and PUSHED needs one;
  - NEEDS_REVIEW may go back to SENDING. That is safe only because the request and key never change.
  - a claim starts with no journal id, resolver, note or read-back flag, and is made by a user of the
    tenant; a retry claim clears any earlier resolver, so leaving review other than by a resend names
    the resolver of this resolution, a user of the tenant;
  - DELETE and TRUNCATE are refused.
- **Known limits.**
  - A draft a person deletes in IsaFlow is not recreated by a resend: IsaFlow replays the stored
    result (the deleted draft's id). The push then stays NEEDS_REVIEW ("draft deleted in IsaFlow;
    key replays the old id") for a person to resolve. Resolving it "not pushed" and pushing again
    only replays the deleted id again, back to review: that month is posted in IsaFlow from the CSV
    download and then resolved, which the screen and the 409 message say. Sending it again would need
    a new key, which IsaFlow does not support today (out of scope).
  - `write:journals` is proven only by the first push.
  - A tax code on a mapping (meant for Xero) refuses the IsaFlow push; post that month from the CSV.
  - A remap after close refuses the push for that month.
  - Account ids are resolved at push time. A code renamed in IsaFlow afterwards gives a definite
    refusal on resend, never a misposting.
- **Evidence.** Integration tests against the fake: `isaflow.integration.test.ts` and
  `isaflow-guards.integration.test.ts` (`RUN_ACCOUNTING_IT=1`). Mutation record:
  `evidence/slice4b-isaflow/MUTATIONS.md`. The live push to Hein's IsaFlow dev company is still to
  do; it waits for his credentials (goal §9).

## Acceptance (every slice)

- 10–20 past client deals, anonymised to synthetic data, reproduce the
  client's figures to the cent: instalments, interest, VAT and settlement.
- Each DB-enforced rule has a `RUN_DB_IT` integration test that fails when
  the rule is removed.
- The solver is checked against an independent calculation and
  mutation-tested.
- The lender's legal team and tax adviser signed off the calculations and rules
  (sign-off record 2026-10-17 below); the agreement and document wording is
  drafted and awaits legal approval.
- The flow is exercised in a browser against a seeded local DB, with
  screenshots.

## Open with the client (not blockers to building)

- Legal approval of the agreement wording (the classifier rules, D5, and supply timing, D7, were signed off, see the sign-off record 2026-10-17 below).
- The anonymised deal pack for acceptance.
- Commercial bureau contract (slice 1 uses a manual credit memo instead).
- Whether a funder or securitisation vehicle needs its own reporting.

## Sign-off record

- **2026-10-17** — Hein (owner) confirmed the lender's legal team and tax
  adviser signed off the calculations and rules as built; the document wording
  is separate and remains DRAFT until
  `TenantConfig.assetFinanceLegalWordingApproved`. Code comments that say
  "signed off" point here.
- `TenantConfig.assetFinanceLegalWordingApproved` must not be set for any
  lender until the list "Code changes required before approval" in
  [`legal-wording/README.md`](legal-wording/README.md) is empty: the drafted
  wording states the law where the code does not yet do what it says.

- **Changed 2026-10-17 to comply with the Conventional Penalties Act:** a
  NON_NCA instalment sale settlement excludes future interest; settling
  receipts reprice the schedule and preserve contractual rows as audit evidence.
- **Changed 2026-10-17 to comply with common-law in duplum:** unpaid default
  plus due contractual interest is capped at unpaid capital, including when
  another contractual-interest instalment falls due; collection fees remain
  outside this common-law interest-only ceiling.
- **Changed 2026-10-17 to comply with GLAA s6, ECTA s13(1), MPA s15(2)(h)
  and s15(5):** suretyships require wet ink; the database refuses payout while
  any surety's marital regime is unknown or an in-community surety lacks a
  staff-verified consent scan identifying the spouse and two distinct witnesses.
- **Changed 2026-10-17 to comply with CPA scope and s49:** instalment sales
  snapshot the purchaser's evidenced CPA classification separately from lease
  scope; the CPA agreement preserves statutory goods remedies and prominently
  draws attention to risk and indemnity. The surety's existing client physical
  address is included in the deed and its domicilium clause.
