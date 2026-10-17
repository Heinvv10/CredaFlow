# NCA asset-finance legal wording: rendered samples

Rendered from synthetic fixtures (no real data) with the lender's legal wording
not yet approved, so every page carries the DRAFT watermark. Wording and open
points: [`../../../legal-wording/nca.md`](../../../legal-wording/nca.md).

| File | Document | Pages |
|---|---|---|
| `agreement-instalment-sale.pdf` | NCA instalment sale agreement, Prime-linked rate, large agreement, credit life | 5 |
| `quote.pdf` | Pre-agreement statement and quotation for the same deal | 3 |
| `s127-valuation-notice.pdf` | Voluntary surrender valuation notice | 1 |
| `s127-final-notice.pdf` | Voluntary surrender final account notice (shortfall) | 1 |
| `s131-valuation-notice.pdf` | Repossessed goods valuation notice | 1 |
| `s131-final-notice.pdf` | Repossessed goods final account notice (shortfall, costs) | 1 |

Page images at 60 dpi were checked for layout: clauses wrap inside the margins,
headings stay with their first paragraph, the watermark sits behind the text.
The agreement's two signature blocks fall on pages 4 and 5 (the shared writer
starts a new page when a block does not fit).

## Re-pinned s127 render hashes: what changed

`surrender-pdf-costs.test.ts` pins five s127 renders. The text runs of each
render before (base `fbcb1535`) and after this change were dumped and diffed.
In every case the only line removed is
`[Placeholder clause — wording to be supplied by the lender's legal team]`
(plus `Page 1 of 1` where the wording runs onto a second page); every line
added is clause wording or the second page's footer (`Page x of 2`, the
reference, the watermark). No figure, label or table line changed.
