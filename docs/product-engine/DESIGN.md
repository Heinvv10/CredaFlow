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
- Rounding residue is absorbed in the final row; rows with a zero total are dropped and renumbered.
- Structures: AMORTISING, INTEREST_ONLY (principal at the end), BULLET (everything at the end).
- Grace: PRINCIPAL_ONLY emits interest-only rows. FULL emits no rows; the interest accrued is deferred as simple interest (no compounding) and spread over the later instalments. BULLET with FULL grace is refused.

## Versioning

A `ProductVersion` holds the commercial configuration with an effective date. It is proposed and approved through maker-checker (`PRODUCT_VERSION`, permissions `manage_product_versions` / `approve_product_versions`). On activation the version is written through into `LoanProduct`: on approval when effective today, otherwise by the nightly cron `product-version-activate`. Approval prices on the version in effect on the decision day. `LoanTerms` records the version a loan was written on and never changes.

The direct product PUT returns 409 `PRODUCT_VERSIONED` for versioned fields once a product has versions.

## Pricing

`ProductPricingRule` (`PRODUCT_PRICING_RULE`, create or retire) matches on risk grade (A4 `getRiskGrade`, compared by rank), segment, channel and campaign. Rules do not stack: most specific wins, then priority, then newer, then lower id. Segment, channel and campaign are set per application by `PUT /api/applications/[id]/pricing-inputs`.

## NCA

An NCA lender may configure only MONTHLY + AMORTISING + no grace + REDUCING_BALANCE (or no structure), and a service fee of at most R69. Everything else is refused until the lender's legal team signs off the rendered documents. A rule's rate is re-checked against the cap at approval.

## Evidence chain

The structure and version reference are frozen in `AffordabilityDecisionInputs` (`repayment`, `productVersion`) and included in the fingerprint only when present, so legacy fingerprints are unchanged. Disbursement recomputes the schedule from the frozen inputs.

## IFRS 9

Engine schedules are plain `RepaymentSchedule` rows, consumed by `lib/ifrs9` unchanged. `ifrs9-cashflows.test.ts` runs weekly, fortnightly, grace and bullet schedules through the ECL functions.

## Limits

- Credit-life premium periods and agreement/PASQ rendering for non-monthly schedules are not verified.
- Staff previews and quotes read the base `LoanProduct`, not rule-priced terms.
- Collateral and eligibility are stored and shown but not enforced at origination.
- Origination routes do not set channel automatically.
- Balloon and variable/reference-rate repricing (2.6.1) are not built.
