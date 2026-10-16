# F1 — s127 notice address separators

`wrapText` (`lib/asset-finance/documents/pdf-layout.ts`) ran `winAnsiSafe` over
the whole value before splitting it on `\n`. `winAnsiSafe` replaces any
character outside WinAnsi, a newline included, with `?`, so the split never
fired and a multi-line address printed as one line joined by `?`.

The fix splits first and sanitises each line. `winAnsiSafe` works character by
character, so a value without a newline sanitises to exactly the same string
either way: only renders whose value contains `\n` change.

## Who is affected

`wrapText` is called only by `DealDocumentWriter.paragraph` and
`DealDocumentWriter.labelValues`. The values that contain `\n` are the three
`addressLines.join("\n")` rows:

- `lib/asset-finance/documents/nca/surrender-pdf.ts` — "Consumer address" on
  the s127 valuation notice and the s127 final notice;
- `lib/asset-finance/documents/nca/quote-pdf.ts` — "Consumer address";
- `lib/asset-finance/documents/nca/agreement-pdf.ts` — "Address".

The `lib/pdf/*` consumer documents each have their own local `wrapText` and do
not import this one. Other asset-finance documents join addresses with `", "`.

## Pins moved: none

Every pinned render uses a one-line address (or no `\n` value), so no pinned
hash moves and nothing was re-pinned.

| Pin | Before (origin/main 1d4f6557) | After |
|---|---|---|
| `surrender-pdf-costs.test.ts` `valuation` | `edcaedb44f63467ae0ae234aa3762467dfb91deb08effa8fd655cbf8526a3bbb` | same |
| `surrender-pdf-costs.test.ts` `final` | `6ccbbe4d0c06fae3b3462b07e4d5171c83d1262a684109ab506223406db0670a` | same |
| `surrender-pdf-costs.test.ts` `finalWithCosts`, `finalWithRecovery`, `finalWithUnrecoverable` | unchanged; the suite passes unmodified | same |
| `scripts/nca-pdf-fingerprint.ts` (s129, cob, statement, agreement38, pasq38, statement37, statementCharges, statementReversed, statementOfWhich) | output identical before and after (`diff` empty) | same |

`npx vitest run lib/pdf lib/asset-finance/documents`: 28 files, 321 tests passed
after the fix, with no pin edited.

## Renders that do change (multi-line address; none pinned)

Rendered with the synthetic address `2 Synthetic Street / Testville / Free State
/ 9999` (s127) and `2 Synthetic Street / Johannesburg` (quote, agreement). The
"before" column was rendered from `git archive origin/main`; its one-line hashes
match the pins above.

| Render | Before | After |
|---|---|---|
| s127 valuation notice | `18d06ae3690d8514434dd0d749baad9c69295fceb246f458d24d9030a670cdb9` | `834e4f6fa32afd971479efdcefd5e7dea7ca6c69dc9804f023c5d5c85a453627` |
| s127 final notice | `1a264ebb3c5f8b9d98b1fd5c0ba31254f2b623c7b54a6d7047dcc0c2564d1f68` | `bc8f6d53ad9168b29cce3f86f8625c6d42ca6ac9fdfbdc4c30daeb6355b06a6c` |
| NCA asset quote | `1700cd712240da7f0f827f59e7ac362f4a1e46186b8422e4afe88e4ea45ce0bd` | `4fcb05a1fafb1a15228a49d98d6795ffc9e348ce80e8c5fef95d9d692783b72c` |
| NCA asset agreement | `a7b335798d35b96d6d6000a763315eda8f646329669b7e801b0f42a1466f0b87` | `ea3a6d6fb93807e210e6326c4e47d4c6032f4acd1c2584bbb194865b8014d4c5` |

Same renders with a one-line address: identical before and after (s127
valuation `edcaedb4…`, final `6ccbbe4d…`, quote `f8aac470…`, agreement
`6737d045…`).

## Text extraction (`pdftotext -raw`, whole document, before vs after)

The complete `diff` of the extracted text is the address line and nothing else.

```
== s127 valuation notice
10c10,13
< Consumer address 2 Synthetic Street?Testville?Free State?9999
---
> Consumer address 2 Synthetic Street
> Testville
> Free State
> 9999
== s127 final notice
10c10,13
< Consumer address 2 Synthetic Street?Testville?Free State?9999
---
> Consumer address 2 Synthetic Street
> Testville
> Free State
> 9999
== NCA asset quote
13c13,14
< Consumer address 2 Synthetic Street?Johannesburg
---
> Consumer address 2 Synthetic Street
> Johannesburg
== NCA asset agreement
12c12,13
< Address 2 Synthetic Street?Johannesburg
---
> Address 2 Synthetic Street
> Johannesburg
```

The DRAFT watermark still prints (`surrender-pdf.test.ts` asserts
`DRAFT_WATERMARK` on both notices and passes unmodified).

## Test, red first

`lib/asset-finance/documents/nca/surrender-pdf-address.test.ts` reads the
printed text of each document between the address label and the next label and
expects exactly the four (or two) address lines, with no `?`. On origin/main
all 4 cases failed:

```
- Expected
+ Received
  [
-   "2 Synthetic Street",
-   "Testville",
-   "Free State",
-   "9999",
+   "2 Synthetic Street?Testville?Free State?9999",
  ]
Tests  4 failed (4)
```

After the fix: 4 passed.

## Wording diff: empty

```
$ git diff origin/main -- lib/pdf lib/asset-finance/documents/nca/surrender-pdf.ts \
    lib/asset-finance/documents/nca/quote-pdf.ts lib/asset-finance/documents/nca/agreement-pdf.ts \
    lib/asset-finance/documents/nca/types.ts lib/asset-finance/documents/document-parts.ts | wc -c
0
```

The only source change is the two lines inside `wrapText`; no string literal in
`pdf-layout.ts` changed (`PLACEHOLDER_CLAUSE`, `DRAFT_WATERMARK` untouched).
