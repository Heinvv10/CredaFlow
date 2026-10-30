<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: product-engine
<!-- summary: repayment schedules (frequency, grace, bullet, interest-only), versioned products, risk/segment/channel pricing -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Generates repayment schedules for weekly, fortnightly and monthly loans, with
grace and bullet/interest-only structures. Versions a product by effective date
(maker-checker) and prices an application by risk grade, segment and channel.
Design and decisions: `docs/product-engine/DESIGN.md`.

## Critical Rules
- **Schedules reconcile to the cent.** `generateSchedule` rows sum to
  principal + interest + fees exactly; a property test enforces it. Change the
  maths only with a failing test first.
- **MONTHLY + AMORTISING + no grace must equal legacy `calculateLoan`.** The
  parity test in `schedule.test.ts` is the guard. Legacy loans never pass
  `repayment`, so they are untouched.
- **An NCA lender may configure only MONTHLY, AMORTISING, no grace,
  REDUCING_BALANCE** (`ncaStructureIssues`, `versionNcaIssues`). Any other
  structure waits for the lender's legal team to sign off the rendered
  documents. Do not relax this to make a test pass.
- **Versions and rules are written only by an approved ChangeRequest.** The
  `guardProductVersion` / `guardProductPricingRule` / `guardLoanTerms` triggers
  enforce provenance and immutability. Never `create` them directly.
- **A loan keeps the version it was written on** (`LoanTerms`, written at
  disbursement from the frozen approval inputs). Approval prices on the version
  in effect on the decision day, not on `LoanProduct`.
- **Activation writes through into `LoanProduct`** (`activateDueVersions`, run on
  approval if effective today, else nightly cron) so every other reader sees
  the in-effect version. The direct product PUT refuses versioned fields once a
  product has versions (409 `PRODUCT_VERSIONED`).
- **Rules do not stack.** Most specific rule wins, then priority, then newer,
  then lower id. A rule naming a grade matches only applications that have one.
  A rule's rate is re-checked against the NCA cap at approval (`ruledRateRefusal`).
- **FULL grace emits no rows**; the grace interest is deferred as simple
  interest and spread over later instalments. Principal-only grace emits
  interest-only rows.
- **Fingerprint stays backward compatible.** New `AffordabilityDecisionInputs`
  fields are appended only when present (`lib/affordability/snapshot.ts`).

## Not built / not enforced
Balloon, variable or reference-rate repricing (spec 2.6.1), collateral and
eligibility enforcement at origination, automatic channel capture.
