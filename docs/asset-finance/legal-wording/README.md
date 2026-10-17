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

The integrated NCA, lease, commercial and rate-change work resolves the other
numbered code gaps. The legal wording approval flag remains unset. Its remaining
implementation gate is:

26. Active operating/full-maintenance leases can require a zero future rental
    after a large late effective-date rate cut. Existing `LeaseRental_amounts`
    requires a positive rental. The narrow nonnegative-rental CHECK replacement
    awaits the goal §8 confirmation and has not been implemented or applied.

The integrated changes cover NCA settlement, surrender timing and surplus
execution evidence; CPA cancellation/continuation, lease damages and total loss;
commercial earned-interest settlement, in-duplum and independently evidenced
cancellation; surety wet-ink/spousal consent and purchaser CPA scope; accurate NCA
asset disclosures and schedule splits; written rate notices, actual benchmark
effective dates and supply-attributed VAT adjustments. Consumer PASQ output and
consumer document pins remain unchanged. See the sign-off record in
[`../DESIGN.md`](../DESIGN.md) and the evidence under
[`../evidence/legal-code-gaps/`](../evidence/legal-code-gaps/).

This integration checkpoint is not whole-goal acceptance or authorization to set
`assetFinanceLegalWordingApproved` for a lender. The final full gate, independent
reviews, remaining zero-rental implementation and legal wording approval remain
separate requirements.
