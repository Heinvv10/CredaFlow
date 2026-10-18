# Asset-finance legal wording

The drafted wording of every asset-finance document, for the lender's legal
team. Every page keeps the DRAFT watermark until
`TenantConfig.assetFinanceLegalWordingApproved` is set for the lender. The
calculations and rules behind the wording are signed off (DESIGN.md, sign-off
record 2026-10-17); the wording is not.

- [`nca.md`](nca.md): the NCA agreement, quotation, s127 and s131 notices.
- [`lease.md`](lease.md): the lease agreement, CPA expiry notice, inspection
  report and early-termination quote.
- [`commercial.md`](commercial.md): the commercial instalment sale, suretyship
  and resolution.

Rendered samples: `docs/asset-finance/evidence/legal-wording/`, produced by
`scripts/asset-finance/render-legal-wording-nca-samples.ts` and
`scripts/asset-finance/render-legal-wording-deal-samples.ts` (both
deterministic: a rerun reproduces the committed PDFs).

## Code changes required before approval

The wording states the law. Where the system does not yet do what the wording
says, the gap is listed here. While any line remains, the flag must not be set
for any lender (DESIGN.md, sign-off record). One line per gap: rule; clause;
code; what must change.

11. CPA lessor cancellation: approved candidate has passed booked PostgreSQL assessment and permanent-stop checks; final union, browser and review acceptance remain. Actual vendor expenses, cash and the single goods receipt must remain preserved.
14. Total-loss closure: approved TOTAL_LOSS outcome, unavailable asset and maintenance-refund proof passed PostgreSQL closure and both proof race orders; final union, browser and review acceptance remain. No fictitious inspection or return to stock is permitted.
24. Written rate notices are implemented with durable dispatch/deadline controls; final combined PostgreSQL, full CI and independent review acceptance remain.
26. Effective-date repricing and the approved nonnegative-rental migration pass targeted tests; final combined PostgreSQL/full CI, browser and independent review acceptance remain.

Consumer PASQ output and consumer document pins remain unchanged. Completion of
these code checks does not authorize setting the lender legal-wording approval
flag. See the sign-off record and committed legal-code-gaps evidence.
