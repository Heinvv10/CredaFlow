# Product engine design

Spec 2.1.1-2.1.4 and 2.6.1 of the Lesotho PostBank tender. Code: `lib/product-engine/`.

## Schedules

`generateSchedule` takes principal, rate, term and `RepaymentTerms`
(frequency, structure, grace kind, grace instalments, instalments) and returns
rows that sum exactly to principal + interest + fees.

- Instalments = round(termDays / periodDays); periods are WEEKLY 7, FORTNIGHTLY 14, MONTHLY 30 days.
- Periodic rate = monthly rate x 12 / periods per year (the monthly rate itself for MONTHLY).
- FLAT interest = round(P x ratePm x 12 x N / periods per year), split evenly.
- The monthly service fee is charged once per 30-day month of the term, on the first instalment due on or after each month end (or the last).
- Monthly dates use SAST calendar months with the day clamped to month end. The legacy path keeps `setMonth`.
- A row's principal is what the instalment leaves after its own interest, never more than the balance and never negative; the final row clears the balance. Rows with a zero total are dropped and renumbered.
- The instalment affordability sets against monthly income is the second row (the first carries the initiation fee), the first row that repays principal after a principal-only grace, the interest-and-fee row of an interest-only loan, the one payment of a bullet; weekly and fortnightly scale the row's principal and interest by 52/12 and 26/12 and add the monthly service fee once (it is a monthly charge, not a per-instalment one); a bullet is not scaled.
- Structures: AMORTISING, INTEREST_ONLY (principal at the end), BULLET (everything at the end), BALLOON (the annuity of the principal less the balloon's present value, the balloon, a share of the principal, on the last row; a flat rate spreads the principal less the balloon evenly). A balloon takes no grace and needs two instalments.
- Grace: PRINCIPAL_ONLY emits interest-only rows. FULL emits no rows; the interest accrued, and the service fees of the grace months, are deferred (interest as simple interest, no compounding) and spread evenly over the later instalments, so the first payment is no heavier than the rest. BULLET with FULL grace is refused.

## Versioning

A `ProductVersion` holds the commercial configuration with an effective date. It is proposed and approved through maker-checker (`PRODUCT_VERSION`, permissions `manage_product_versions` / `approve_product_versions`). On activation the version is written through into `LoanProduct`: on approval when effective today, otherwise by the nightly cron `product-version-activate`. Approval prices on the version in effect on the decision day. `LoanTerms` records the version a loan was written on and never changes.

The direct product PUT returns 409 `PRODUCT_VERSIONED` for versioned fields once a product has versions.

## Pricing

`ProductPricingRule` (`PRODUCT_PRICING_RULE`, create or retire) matches on risk grade (A4 `getRiskGrade`, compared by rank), segment, channel and campaign. Rules do not stack: most specific wins, then priority, then newer, then lower id. Segment, channel and campaign are set per application by `PUT /api/applications/[id]/pricing-inputs`.

## NCA

An NCA lender may configure no repayment structure: its loans keep the existing monthly schedule (lib/loan-calculator.ts), which the PASQ, the credit agreement, the debit-order mandate and the NCA schedules describe to the cent, month-end dates included, so a product's first version changes none of them. Every structure, the monthly one too, needs the lender's legal team to sign off the rendered documents first. The version's service fee is held to R69. The whole gate (`versionNcaIssues`: structure, fee, cap, the MICRO30 contract) is re-run at every approval (`ApprovalTerms.ncaIssues`) and by the nightly activation, the same function in both, because a version may have been approved while the process was another jurisdiction, and when the nightly activation would write the version through.

The interest-rate cap binds the rate the loan is written at, not the product row's: at approval, `capApplicationFor` gives the cap check the version's rate (with its rule's price, if one matched) and the approved principal and term, so the general cap, the NON_NCA and jurisdiction exemptions and the repeat short-term rule all apply, rule or no rule. The same check runs at payout on the frozen rate of a versioned approval, so a repo cut between approval and payout stops it. The nightly activation does not write an over-cap version through to `LoanProduct`: it reports it as blocked and tries again the next night. No pricing rule prices MICRO30 (matched by `isMicro30Code`: case and spaces aside), whose contract is fixed; a rule is checked against the version in effect and every scheduled one, not the product row.

## Evidence chain

The structure and version reference are frozen in `AffordabilityDecisionInputs` (`repayment`, `productVersion`) and included in the fingerprint only when present, so legacy fingerprints are unchanged. Disbursement recomputes the schedule from the frozen inputs.

## IFRS 9

Engine schedules are plain `RepaymentSchedule` rows. The interest a full grace defers is earned in the grace though no row carries it: `LoanTerms.deferredInterest` is read by the run (`graceDeferral`) and `accruedInterestCents` accrues it through the grace, then the unraised remainder alongside the period's own interest. `ifrs9-cashflows.test.ts` runs weekly, fortnightly, grace and bullet schedules through the ECL functions.

## Customer channels, collection and credit life

The portal, the website and the lender API show and schedule monthly instalments only, so a product whose version in effect has a structure is hidden from them (`LoanProduct.repaymentStructured`, written by the activation; `CUSTOMER_PRODUCT_WHERE`) and originated by staff. Staff previews, the affordability assessment and the decision engine's facts use the version's terms (`previewCalcInput`). A DebiCheck mandate is monthly with one recurring amount, so a structured loan is collected by EFT: approval, disbursement and staff mandate creation refuse a debit order for it. Credit life is billed a premium per month of cover bound to schedule rows, which a weekly or fortnightly schedule has several of in a month: approval refuses an accepted election on one.

## Variable rates and repricing

A version may name a reference (`variableRate`: PRIME or LENDER_BASE, and an annual margin). A loan on it is priced at the approved reference value on the approval day + margin, divided by 12, and a pricing rule moves that as it moves any base rate. The loan keeps its own margin, the rate it was priced at x 12 less that reference value, frozen in `AffordabilityDecisionInputs.variableRate` (in the fingerprint when present) and written on `LoanTerms` sequence 1. `affordabilityInputSha256` and `guardSignedDebitMandateAuthority` know both: a rate off the product row stands in the database only as what an approved reference value and the version's margin give, outside the NCA, with a live rule on top if one priced it. A variable rate needs a reducing balance and a repayment structure, so it is BRANCH-only like every structure, and neither a bullet nor a full grace: nothing could be regenerated, or deferred interest sits in the rows. With no approved reference value on the day, approval is refused. An NCA lender may have none (`ncaStructureIssues`).

The lender records values at Settings, Products, Reference rates (`/api/products/lending-rates`, non-NCA only: `ReferenceRate`, with the table's own four-eyes rules; deciding one needs the session's second factor). The nightly `loan-rate-reprice` job takes each approved value after the one a loan is on, oldest first, and for each: locks the loan, plans the tail (`reprice.ts`), appends a `LoanTerms` row, rewrites the tail rows in place, and moves the loan's rate, total interest and total repayable, and the agreed baseline when set, by the change in interest. The rate applies from the first period starting on or after the effective date, so no period is split and an instalment already running keeps its amount. `guardLoanTerms` refuses a repricing row that no approved value backs, or that changes the loan's basis, margin or structure, or whose rate is not what that value gives. A row the common-law cap has reduced ends the run: the charge sync owns it. What a loan change carried onto a row stands: arrears principal bears no interest and stays on its row, carried interest is added to the row's fresh interest. A loan change keeps the reference columns and the balloon (`lib/loan-changes/.claude.md`) and may not set a variable loan's rate. Default interest on closed days stays at the rate of that day: the charges replay reads the loan's rates from `LoanTerms` (`loanTermsRateHistory`), because `ContractRate` belongs to asset-finance contracts.

## Maker-checker on a product

Creating, editing and deactivating a `LoanProduct` is a `LOAN_PRODUCT` change request (`lib/product-config/change-handler.ts`): the product routes answer 202 with the request and write nothing, the same rules are checked when proposing and again inside the approval, and a change is STALE if the row moved after it was submitted. A LOAN_ADMIN proposes, an ADMIN approves. The table has no provenance trigger: the seed, the fixtures and a version's activation write it too. The operator CLI `scripts/set-micro30-pricing.ts` and the insurance products are outside this.

## Product types

SALARY_BACKED, SME, GROUP and REVOLVING are refused to an NCA lender, offered by no customer channel, and each is gated at approval (`lib/product-types/rules.ts`). `lib/product-types/.claude.md` says what each does and does not do. Mortgage is out of scope.

## Pricing inputs

The channel is `PRICING_CHANNELS` (DIGITAL, BRANCH, API), recorded by the code that creates the application (the portal and website DIGITAL, staff and the CRM BRANCH, the lender API API) and never typed or changed by a person: the pricing-inputs PUT refuses a different channel. Segment and campaign code are chosen from those the lender's approved pricing rules name. Whoever ever sets them (the audit trail names every setter) does not approve the application, whether or not a rule priced it, and each setter is recorded in the application's grow-only `inputStaffIds`, so the segregation-of-duties rules of an engine approval and its disbursement cover them. The status is read under the application's row lock. An application that came in through a customer channel (DIGITAL, API) is not approved on a structured schedule, even if a version took effect after the customer applied.

A product's type, and whether it is the MICRO30 contract product, are locked once it has versions (the product PUT returns 409): a PO_FUNDING type lifts the Regulation 42 fee ceiling, and no pricing rule prices MICRO30.

## Limits

- NCA documents (PASQ, agreement) for a structured schedule are not rendered or verified: only a non-NCA lender can have one, and the agreement prints the term in days.
- Credit life and debit orders are refused for a structured schedule until they follow it.
- The staff loan calculator and the wizard's affordability step still read the base `LoanProduct`; the application page, the assessment and the decision facts use the version.
- Monthly dates of a structured (non-NCA) schedule are SAST calendar months clamped to month end (31 Jan, 28 Feb), unlike the legacy `setMonth` (3 Mar); the legacy schedule, used by every NCA lender, is untouched.
- Collateral and eligibility are stored and shown but not enforced at origination.
- A rate change sends the borrower no notice. The one existing rate notice (`lib/asset-finance/reprice-notice.ts`) is an asset-finance document bound to a `ContractRate` row, and `lib/notifications.ts` has no event for it: a notice needs new wording, which is the lender's.
- A repricing does not reach back: a reference approved late changes only rows not yet due, and paid rows keep the rate they were paid at. A value older than the one a loan is already on is ignored.
- Affordability is set against the recurring instalment: the balloon is on the schedule and in the totals, not in the instalment test.
- Loan changes (2.6.6) are `lib/loan-changes`: they call `generateSchedule` on the balance and terms that remain, and append to `LoanTerms`.
