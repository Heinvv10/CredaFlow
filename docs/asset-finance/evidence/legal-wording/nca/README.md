# NCA asset-finance legal wording: rendered samples

Rendered from synthetic fixtures (no real data) with the lender's legal wording
not yet approved, so every page carries the DRAFT watermark. Wording and open
points: [`../../../legal-wording/nca.md`](../../../legal-wording/nca.md).

| File | Document | Pages |
|---|---|---|
| `agreement-instalment-sale.pdf` | NCA instalment sale agreement, Prime-linked rate, large agreement, no credit life | 5 |
| `quote.pdf` | Pre-agreement statement and quotation for the same deal | 3 |
| `s127-valuation-notice.pdf` | Voluntary surrender valuation notice | 1 |
| `s127-final-notice.pdf` | Voluntary surrender final account notice (shortfall) | 1 |
| `s131-valuation-notice.pdf` | Repossessed goods valuation notice | 1 |
| `s131-final-notice.pdf` | Repossessed goods final account notice (shortfall, costs) | 1 |

## Figures in the agreement and quotation samples

The first samples used hand-typed figures that did not agree with each other
(flat interest, a principal that was not cash price less deposit, capital rows
that did not reach the principal). These are produced by the real solver:
`solveNcaDealStructure` (R1,000,000 + VAT, R150,000 deposit, R200,000 balloon,
36 monthly payments from 31 January 2027, Prime 10.50% + 1.25% = 11.75%,
initiation fee R1,207.50, service fee R60) and `createAssetPasqEvidence`,
mapped as `nca-agreement-store.ts` maps them. The render script,
[`scripts/asset-finance/render-legal-wording-nca-samples.ts`](../../../../../scripts/asset-finance/render-legal-wording-nca-samples.ts)
(`npx tsx scripts/asset-finance/render-legal-wording-nca-samples.ts`), refuses
to write unless the capital rows sum to the principal, principal = cash price -
deposit, and each row's capital, interest and fees add up to its total. It
renders all six PDFs here; rerunning it reproduces the committed bytes.

One departure from the store: the schedule rows are the solver's rows, not the
PASQ billing records, because `toScheduleRecord` folds an NCA row's fees into
`principalDueCents` (README gap 22,
[`../../../legal-wording/README.md`](../../../legal-wording/README.md)). The
store's documents therefore show a capital column that over-counts by the fees.
The quotation's "Total cost of credit" equals the total repayable: the PASQ
figure includes the principal (nca.md point 18).

Page images at 60 dpi were checked for layout: clauses wrap inside the margins,
headings stay with their first paragraph, the watermark sits behind the text.
The agreement's two signature blocks fall on pages 4 and 5 (the shared writer
starts a new page when a block does not fit).

## Re-pinned s127 render hashes: what changed

`surrender-pdf-costs.test.ts` pins five s127 renders. Their text runs are
committed in [`s127-text-runs/`](s127-text-runs/) at three points, with the
unified diffs between them:

- `1-base-fbcb1535/` to `2-placeholder-replaced-bd5b1047/` (`1-to-2.diff`): the
  only line removed is `[Placeholder clause — wording to be supplied by the
  lender's legal team]` (plus `Page 1 of 1` where the wording runs onto a second
  page); every line added is clause wording or the second page's footer
  (`Page x of 2`, the reference, the watermark).
- `2-…` to `3-review-fixes/` (`2-to-3.diff`): the valuation notice gains clause
  1.6 (the bank account for a surplus); the final notice without a recovery
  gains the shortfall charge freeze as 1.3 (the old 1.3 becomes 1.4). The
  recovery-linked renders do not change. `valuation`, `final` and
  `finalWithCosts` were re-pinned; `finalWithRecovery` and
  `finalWithUnrecoverable` keep their hashes.

No figure, label or table line changed in either step.
