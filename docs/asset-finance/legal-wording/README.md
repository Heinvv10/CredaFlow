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

## Wording outside the templates

- **Dealer consent statement** (`lib/dealer/consent.ts`, `dealer-consent-v2`,
  SLICE5-FOLLOWUPS.md part D): what a dealer user attests for each person
  whose signed POPIA consent form it uploads. v2 drops "in my presence" so it
  is true for a remote signing; each attestation adds how the form was signed
  (in person, or remotely with how identity was checked) and snapshots the
  text. Attestations made under v1 keep their v1 text. Merged on a blind SA
  legal reviewer's SHIP (goal §2a 7); the lender's legal team confirms it
  matches its dealer process before switching the portal on.

## Starter wording issues found

- Fixed 2026-10-19 (Hein approved): lease clause 9.3 printed "linked to the
  Lender base rate rate" on a lease linked to the lender's base rate
  (`lease-agreement-goods.ts`); it now reads "linked to the Lender base rate".
  SYSTEM_REVISION 2026-10-19.1; lenders re-approve the four lease variants.

## Code changes required before approval

No remaining implementation gaps are listed. The NCA, lease, commercial and
rate-change changes cover the original items 1–26. The sign-off record in
[`../DESIGN.md`](../DESIGN.md) records the legal rule for each change; tests,
render comparisons and local browser evidence are under
[`../evidence/legal-code-gaps/`](../evidence/legal-code-gaps/).

Consumer PASQ output and consumer NCA document pins remain unchanged. Code
acceptance does not authorize setting `assetFinanceLegalWordingApproved`: the
lender's legal team must still approve its rendered documents before use.
