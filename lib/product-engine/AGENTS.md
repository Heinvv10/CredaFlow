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
- **Schedules reconcile to the cent.** Rows sum to principal + interest + fees,
  each principal row is at most the balance, no balance goes negative
  (`schedule.test.ts` sweeps small principals and high rates). Failing test first.
- **An NCA lender may not configure any repayment structure** (`ncaStructureIssues`):
  its loans keep the legacy schedule, so PASQ, agreement, mandate and month-end
  dates cannot change when a product gets its first version. Held again at
  every approval (`ApprovalTerms.ncaIssues`) and at activation. Until legal signs off.
- **The cap binds the rate the loan is written at**, rule or no rule
  (`capApplicationFor`), at approval and at payout; activation does not write an
  over-cap version through (`blocked`). MICRO30 is never re-priced by a rule.
- **Versions and rules come only from an approved ChangeRequest** (guard triggers:
  provenance, payload equality, one request one row, no backdating). Never `create` them.
- **`LoanTerms` is append-only per loan** (`sequence`); a restructure appends a row.
- **Approval prices on the version in effect that day**; activation writes it
  through into `LoanProduct` (so the product PUT returns 409 `PRODUCT_VERSIONED`).
- **A structured product is not offered by the portal, website or lender API**
  (`repaymentStructured`, `CUSTOMER_PRODUCT_WHERE`) and takes no debit order or
  credit life yet: refused at approval. Staff preview and assess via `previewCalcInput`.
- **Rules do not stack.** Most specific, then priority, newer, lower id. Pricing
  inputs: segment and campaign from the lender's rules, channel set by the system only;
  every setter is input staff and cannot approve, rule or no rule. A product's type and
  MICRO30 identity are locked once it has versions.
- **FULL grace emits no rows**: its interest and service fees are deferred, spread over
  the rows after it; IFRS 9 reads `LoanTerms.deferredInterest` to accrue it in the grace.
- **Fingerprint stays backward compatible.** New `AffordabilityDecisionInputs`
  fields are appended only when present (`lib/affordability/snapshot.ts`).

## Not built / not enforced
Balloon, variable or reference-rate repricing (2.6.1), collateral and eligibility
enforcement, credit life, debit orders and NCA documents for structured schedules.
