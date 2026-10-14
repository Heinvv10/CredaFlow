<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: statement-analysis
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Statement → transactions, one `StatementAnalysis` per (bytes, `PARSER_VERSION`), for `lib/credit-checks/`.

## Critical Rules
- **The balance check is the oracle.** opening + Σ amounts = closing (±1c), and
  each printed running balance = previous + amount (`balance-check.ts`). A
  reader change is only right if bank-produced corpus files still PASS.
- **Text readers** (`TEXT_READERS`, `analyse.ts`): Capitec, FNB, Nedbank, ABSA
  (two layouts), Standard Bank, Discovery. Standard Bank and Discovery are
  **limited evidence** (6–9 corpus files) until 20+ files have been seen. Every
  bank marked in the text is tried in turn (`detectBanks`): a payee can name another bank.
  Other banks, scans and photos go to the vision reader (`vlm-reader.ts`).
- **What arithmetic cannot check goes to a person** (MANUAL_REVIEW): a derived opening
  (ABSA Transaction History, Discovery: FIRST_ROW_UNVERIFIED) or closing (Discovery:
  LAST_ROW_UNVERIFIED), rows printed without a balance (ABSA eStatement: ROWS_UNCHECKED).
  Other closings are printed (Standard Bank: opening + summary totals). Where a bank
  prints a balance on every row, a row without one is not read; with no closing,
  every printed balance is still checked.
- **A vision read is never tamper evidence**: its balance FAIL is MANUAL_REVIEW/
  UNVERIFIED_READ, never BALANCE_MISMATCH (a misread and a forgery look alike).
- **Never call the vision reader inside a staff request** (`persist.ts` `allowVlm: false`).
  **Bump `PARSER_VERSION`** when a reader's output changes for the same bytes. pdfinfo
  fields parse with `[ \t]*`, not `\s*`.
- **FNB marks only credits** ("Cr"); unmarked is a debit / overdrawn. A row
  printing an amount that moves no money is `nonPosting` only when the balance
  confirms it: FNB "EDO Collection Attempt", ABSA "( PENDING )"/"DECLINED FEE".
  Nedbank's Fees column, like FNB's accrued charges, is not the row's amount.
  Proportional-font banks (FNB, Nedbank, ABSA eStatement, Discovery) are read
  from word boxes (`pdftotext -bbox`, `word-table.ts`), not `-layout` columns.
- **Intake decryption rewrites the file** (`lib/documents/pdf-decrypt.ts`): the upload
  route records the original's revision count on DOCUMENT_DECRYPTED_AT_INTAKE for `persist.ts`.
- **A failed read is persisted** UNREADABLE (READ_FAILED), never thrown; missing PDF tools: pending.
- **Hostile-file bounds:** poppler async, pdfinfo before any text pass, text
  only up to `TEXT_MAX_PAGES`, lines over 400 chars or 200 words skipped, amounts above
  `MAX_CENTS` refused, implausible periods dropped, duplicate pdfinfo fields
  distrusted (METADATA_AMBIGUOUS), one background vision read per process.

## Corpus (real client data)
- Off-repo at `STATEMENT_CORPUS_DIR`; runner in `accuracy/` (README there).
- Never commit, print or log names, ID/account numbers or transaction text
  from it; never send it to any model but the local one at `VLM_API_URL`.
- Inspect it only through scripts printing masked shapes (a/9), counts or
  metadata: `scripts/statement-{layout-shapes,read-diagnostics,tamper-review}.ts`.
  A shape "label" must recur on 5+ accounts, or a client's name passes as one.
- Corpus vision runs only outside 08:00–17:00 SAST on weekdays (shared model).
- `fixtures/`: synthetic PDFs per text-read bank + doctored variants ("T TESTER").
