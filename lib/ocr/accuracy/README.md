# Payslip extraction accuracy corpus

Measures how often the extraction pipeline reads a payslip correctly. Without
this, "the VLM is more accurate now" is an opinion — a prompt change can only be
argued about, not shown to help.

## Client documents never enter this repository

A real payslip carries an ID number, an income, an employer and often a bank
account: POPIA special personal information, and git keeps it forever. The
corpus therefore lives **outside the repo** and is named by an environment
variable. Only the runner, the schema and a synthetic sample are committed.

```bash
VLM_ACCURACY_CORPUS=/secure/path/to/payslips \
VLM_API_URL=http://vlm-host:8100 VLM_MODEL=<model> \
RUN_VLM_ACCURACY=1 npx vitest run lib/ocr/accuracy/
```

Without `RUN_VLM_ACCURACY=1` the suite skips: it calls a real model, costs money
and is not hermetic. It prints a per-field report either way, so a skipped run
announces itself rather than passing quietly.

## Ground truth is read by a human

Every expected value in a manifest must be read off the document **by a person**.
A fixture generated from the pipeline's own output only proves the pipeline
agrees with itself, and would have ratified the year-to-date misread that this
corpus exists to catch.

## Adding a case

Drop the PDF in the corpus directory and append to its `manifest.json`:

```json
{
  "file": "employer-2026-07.pdf",
  "source": "where it came from, and anything unusual about the layout",
  "docType": "PAYSLIP",
  "expect": { "grossIncome": 4012345, "netIncome": 2654321, "totalDeductions": 1358024 },
  "traps": { "grossIncome": 16049380 }
}
```

`expect` is cents, human-read. `traps` are the wrong values on the same rows —
usually the year-to-date column. Reporting a trap value is counted and named
separately in the report, because "read the wrong column" is a different failure
from "misread a digit" and has a different fix.

## What to collect

Coverage matters more than volume. Aim for one case per payroll system your
clients actually use (Sage, VIP, PaySpace, SimplePay, in-house), plus:

- a phone photo of a printed payslip (exercises the vision path)
- a scanned PDF with no text layer
- a multi-page payslip
- a payslip with no explicit "Total Deductions" line
- an Afrikaans payslip
