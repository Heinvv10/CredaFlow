# Statement reader accuracy corpus

Measures how often the statement readers read a real statement exactly, using
the balance identity as the oracle: a read that reconciles to the cent, row by
row, was read correctly.

## Client documents never enter this repository

Bank statements carry names, account numbers and every transaction a person
made. The corpus lives outside the repo (`STATEMENT_CORPUS_DIR`, laid out as
`manifest.psv` = `id|type|mime|bank|sha256|date` plus `bank_statement/<id>.<ext>`)
and the report prints counts and document IDs only.

```bash
STATEMENT_CORPUS_DIR=/secure/path/to/statements RUN_STATEMENT_ACCURACY=1 \
  STATEMENT_ACCURACY_REPORT=/tmp/report.md \
  npx vitest run lib/statement-analysis/accuracy/
```

Add `STATEMENT_ACCURACY_VLM=1` (with `VLM_API_URL`/`VLM_MODEL`) to also run the
vision reader. The model is shared: do that only outside 08:00–17:00 SAST on
weekdays. Without it, files that need the vision reader are counted SKIPPED.

## What it asserts

- Capitec + FNB PDFs produced by the bank's own program pass the balance check
  by the text method at least 95% of the time (v1 goal §8.1), and so do each of
  Capitec, FNB, Nedbank and ABSA on its own (`TEXT_GATES` in `run.ts`). Standard
  Bank and Discovery are reported per bank without a threshold (limited evidence).
- None of those raises BALANCE_MISMATCH or RUNNING_BALANCE_BREAK (§8.3).

Every other authenticity signal is listed by document ID for a person to look
at. Do not tune a signal away because it fires on a corpus file: that file may
be a forgery.
