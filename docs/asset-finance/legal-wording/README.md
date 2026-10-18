# Asset-finance legal wording

The drafted wording of every asset-finance document, for the lender's legal
team. It is the **starter** each lender adopts as its own versioned template
(`../evidence/lender-owned-templates/SPEC.md`). Agreements, suretyships and
resolutions are issued only from the lender's published, approved version: a
demo approval prints a SYNTHETIC DEMO watermark, a legal approval (a lender
SUPER_ADMIN on written legal sign-off) prints none. The NCA quotation and the
system notices keep the DRAFT watermark until
`TenantConfig.assetFinanceLegalWordingApproved` is set for the lender. The
calculations and rules behind the wording are signed off (DESIGN.md, sign-off
record 2026-10-17); the wording is not.

Drafters: editing the starter here changes only what a lender adopts from now
on (bump `STARTER_REVISION` in `lib/asset-finance/documents/templates/families.ts`);
lenders' adopted versions never change. A change to protected output bumps
`SYSTEM_REVISION`. Starter text of editable clauses lives in the
`*_STARTER` constants the wording files export.

- [`nca.md`](nca.md): the NCA agreement, quotation, s127 and s131 notices.
- [`lease.md`](lease.md): the lease agreement, CPA expiry notice, inspection
  report and early-termination quote.
- [`commercial.md`](commercial.md): the commercial instalment sale, suretyship
  and resolution.

Rendered samples: `docs/asset-finance/evidence/legal-wording/`, produced by
`scripts/asset-finance/render-legal-wording-nca-samples.ts` and
`scripts/asset-finance/render-legal-wording-deal-samples.ts` (both
deterministic: a rerun reproduces the committed PDFs).

## Starter wording issues found (for the drafters; not changed by code)

- Lease clause 9.3 prints "linked to the Lender base rate rate" when a lease is
  linked to the lender's base rate (`lease-agreement-goods.ts`, the rate label
  already ends in "rate"). Visible in the template preview's "Linked to the
  lender's base rate" deal; pinned as an expected failure in
  `lib/asset-finance/documents/templates/edge-round5-shapes.test.ts`. Fixing it
  changes protected lease output: bump `SYSTEM_REVISION`, re-pin the
  fingerprints, and lenders re-approve the lease variants.

## Code changes required before approval

No remaining implementation gaps are listed. The NCA, lease, commercial and
rate-change changes cover the original items 1–26. The sign-off record in
[`../DESIGN.md`](../DESIGN.md) records the legal rule for each change; tests,
render comparisons and local browser evidence are under
[`../evidence/legal-code-gaps/`](../evidence/legal-code-gaps/).

Consumer PASQ output and consumer NCA document pins remain unchanged. Code
acceptance does not authorize setting `assetFinanceLegalWordingApproved`: the
lender's legal team must still approve its rendered documents before use.
