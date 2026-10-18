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

No remaining implementation gaps are listed. The NCA, lease, commercial and
rate-change changes cover the original items 1–26. The sign-off record in
[`../DESIGN.md`](../DESIGN.md) records the legal rule for each change; tests,
render comparisons and local browser evidence are under
[`../evidence/legal-code-gaps/`](../evidence/legal-code-gaps/).

Consumer PASQ output and consumer NCA document pins remain unchanged. Code
acceptance does not authorize setting `assetFinanceLegalWordingApproved`: the
lender's legal team must still approve its rendered documents before use.
