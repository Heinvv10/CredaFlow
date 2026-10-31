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
- Structures: AMORTISING, INTEREST_ONLY (principal at the end), BULLET (everything at the end).
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

## Pricing inputs

The channel is `PRICING_CHANNELS` (DIGITAL, BRANCH, API), recorded by the code that creates the application (the portal and website DIGITAL, staff and the CRM BRANCH, the lender API API) and never typed or changed by a person: the pricing-inputs PUT refuses a different channel. Segment and campaign code are chosen from those the lender's approved pricing rules name. Whoever ever sets them (the audit trail names every setter) does not approve the application, whether or not a rule priced it, and each setter is recorded in the application's grow-only `inputStaffIds`, so the segregation-of-duties rules of an engine approval and its disbursement cover them. The status is read under the application's row lock. An application that came in through a customer channel (DIGITAL, API) is not approved on a structured schedule, even if a version took effect after the customer applied.

A product's type, and whether it is the MICRO30 contract product, are locked once it has versions (the product PUT returns 409): a PO_FUNDING type lifts the Regulation 42 fee ceiling, and no pricing rule prices MICRO30.

## Limits

- NCA documents (PASQ, agreement) for a structured schedule are not rendered or verified: only a non-NCA lender can have one, and the agreement prints the term in days.
- Credit life and debit orders are refused for a structured schedule until they follow it.
- The staff loan calculator and the wizard's affordability step still read the base `LoanProduct`; the application page, the assessment and the decision facts use the version.
- Monthly dates of a structured (non-NCA) schedule are SAST calendar months clamped to month end (31 Jan, 28 Feb), unlike the legacy `setMonth` (3 Mar); the legacy schedule, used by every NCA lender, is untouched.
- Collateral and eligibility are stored and shown but not enforced at origination.
- Balloon and variable/reference-rate repricing (2.6.1) are not built.
