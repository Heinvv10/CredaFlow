# CPA cancellation assessment after blind legal review

Changed 2026-10-18. The agreed PV less net goods plus actual costs calculation
remains the financial ceiling. It cannot determine a reasonable charge by itself.
The staff assessment records all ten Regulation 5(2) factors (including reasoned
inapplicability), an explicit assessed amount at or below the ceiling, reasons
for that amount and why it does not negate cancellation under Regulation 5(3).
Zero charges and reductions are permitted. Cancellation already stands and never
depends on this assessment or quote acceptance.

The assessment is retained on the immutable accepted quote and in the audit.
The invoice and collectible schedule use the assessed amount. An additional
database trigger independently requires the findings, staff identity, exact
amount, financial ceiling and matching billed amount. It preserves the original
accepted-quote immutability and cost-overlap constraints.

Primary law: [CPA Regulations, regulation 5](https://www.gov.za/sites/default/files/gcis_document/201409/34180rg9515gon293.pdf).

TDD: the real migrated PostgreSQL prepaid-lease test first failed because the
old service accepted a charge without findings (`/tmp/cf-cpa-reg5-pg-red.log`).
After the fix, three suites passed 12 tests, with one existing explicitly skipped
historical reachability probe (`/tmp/cf-cpa-reg5-pg-green2.log`). These cover an
actual 500-cent assessed charge below the financial ceiling, unchanged actual
cash and refund credit, missing/excessive assessment refusal, database mutation
of the new guard, retained cost-overlap refusal, immutable accepted findings,
and a zero-charge historical assessment. Unit and rendered-wording tests passed
41/41. TypeScript and scoped ESLint passed. This is focused evidence; final full
CI, browser assessment and fix-delta review remain required.

Re-rendered synthetic CPA agreement and termination quote, with all page images.
Only these two PDFs changed. Text runs show the new financial-ceiling wording
and express Regulation 5(3) limit; no figures or consumer PDF pins changed.

| PDF | SHA-256 |
|---|---|
| operating-lease-agreement-cpa.pdf | d782e2ec2bc5df47d06ddc62dc6ebb07ba937caf93de54825b0887c889c0ae38 |
| termination-quote-cpa.pdf | 266276e30746468eac480bcd97752cb47c4ac2e0dba5573edc86c1a520c1c1dc |

Text extraction: `pdftotext -layout`; agreement lines 479–494 and quote lines
105–124 in `/tmp/cf-cpa-reg5-{agreement,quote}.txt`. Originals, calculations and
the legal-approval flag remain subject to the existing lender approval process.
