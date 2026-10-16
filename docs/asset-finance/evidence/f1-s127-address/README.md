# F1 — s127 notice address separators

`wrapText` (`lib/asset-finance/documents/pdf-layout.ts`) ran `winAnsiSafe` over
the whole value before splitting it on `\n`. `winAnsiSafe` replaces any
character outside WinAnsi, a newline included, with `?`, so the split never
fired and a multi-line address printed as one line joined by `?`.

The fix splits on every line break first (CRLF, LF, lone CR, NEL U+0085, and
U+2028/U+2029), turns each line's whitespace runs (tabs included) into single
spaces, and only then sanitises. `winAnsiSafe` works character by character
and the old code already split words on whitespace after it, so a value with
no line break and no tab-like whitespace prints exactly as before: only renders
whose values contain one change. (Review round 1 widened the split from
`\r?\n` and added the whitespace step; the pins and renders below were
re-checked after it and are unchanged.)

## Who is affected

`wrapText` is called only by `DealDocumentWriter.paragraph` and
`DealDocumentWriter.labelValues` (`placeholderClause` goes through
`paragraph`). The `lib/pdf/*` consumer documents each have their own local
`wrapText` and do not import this one.

### Every caller, and which runtime values can carry a line break

The 65 `paragraph` / `labelValues` call sites in `lib/asset-finance/documents/`
(agreement, suretyship, resolution, NCA quote/agreement, s127 surrender
notices, s131 recovery notices, post-sale statement, lease agreement,
statement, termination quote, expiry notice, inspection report, and the row
builders in `document-parts.ts` and `lease/lease-docs-parts.ts`) print these
kinds of value. The table records whether a line break can reach `wrapText` at
runtime, from the write path's validation (traced by reading it, not run):

| Value printed | Source | Line break possible? |
|---|---|---|
| Consumer address on the s127 notices, NCA quote, NCA agreement | `addressLines.join("\n")` in the renderer | **Always**, when the address has more than one line (the reported bug) |
| Every other address (s131 notices, post-sale statement, lease agreement, entity rows) | `addressLines.join(", ")` | Only inside a line itself, as below |
| Client names and address columns (consumer, lessee, surety, signatories) | client wizard, `lib/validation/client-wizard.ts` (required, trimmed) | Yes: nothing refuses an inner newline |
| Entity legal/trading name, registration and VAT number, Master's reference, address columns | `lib/asset-finance/entity-input.ts` `text()` (trim + max length) | Yes |
| Recovery `condition`, `location` ("Recorded condition", "Held at") | `lib/asset-finance/recovery-input.ts` `text()` (trim) | Yes (staff free text) |
| Surrender `assetCondition` | `lib/asset-finance/surrender-store.ts` (trim, 3–2000 chars) | Yes (borrower free text from the portal) |
| Valuer name | `recovery-store.ts` / `surrender-store.ts` (trim); `asset-input.ts` `readText` (trim) | Yes |
| Lease inspection `condition` | `lib/asset-finance/lease-end-of-term.ts` (trim) | Yes |
| Asset make / model (in "Goods", "Asset") | `asset-input.ts` `readText` (trim) | Yes |
| Supplier name | supplier write path | Not traced |
| Lender legal name, registered office lines, NCR/company numbers, contacts | `lib/config/identity-schema.ts` `PRINTABLE` (refuses control characters) | No |
| Serial / VIN / engine / registration numbers | `asset-input.ts` serial rule (`asset-input.test.ts` refuses `\t`, `\n`) | No |
| Money, dates, percentages, rate descriptions | `formatZarPdf`, `formatIsoDatePdf`, `percentPdf`, … | No |
| Fixed wording, `PLACEHOLDER_CLAUSE`, the draft notes, the termination `basis` (`basisText` template) | code constants | No |

So besides the three `"\n"`-joined addresses, a free-text value typed with a
line break (a condition, a location, a name or address line) now prints as
separate lines where it printed `?` before, and a tab prints as a space. No
pinned render has such a value.

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
after the fix, with no pin edited. After the round-1 change (every line break,
whitespace normalised): 29 files, 327 tests passed, including the tester's
`pdf-layout.breaker.test.ts` (lone CR, NEL and U+2028, tab: no `?`), and the
fingerprint and the eight renders below were re-rendered with identical hashes.

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
