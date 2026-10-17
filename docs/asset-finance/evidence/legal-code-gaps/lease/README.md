# Lease legal-gap candidate evidence — 2026-10-17

Scope: goal items 6–14 and 25. Synthetic local tenants only; no deployment or activation.

The browser exercised staff password/TOTP login, a unilateral CPA cancellation notice (HTTP 200), and an itemised goods-value/cost assessment (HTTP 200), with no browser page errors. Screenshots 01–03 record the notice and assessment flow. Screenshot 04 records the lease without an end-of-term election. A real invoice batch subsequently created an automatic EXTENDING outcome and one extension rental (`issued: 4`, `failed: 0`); the post-batch screenshot was not captured because the script expected the internal status instead of the displayed “Month to month” label.

Real PostgreSQL integration evidence before the final candidate edits: 18 suites, 177 tests passed, one browser-seed test skipped (`/tmp/lease-all-it3.log`). Integration tests include unilateral notice, retained rentals during the notice period, automatic continuation while defaulted, supply VAT, commercial acceptance repricing, total-loss insurance receipts, lessor damages, and prepaid invoice credits. Later maintenance-credit/EOT guard amendments require the final integration gate and fresh review; the earlier count is not an exact-candidate acceptance claim.

TDD evidence includes red-to-green charge arithmetic, cancellation completion blocking, and maintenance contribution accounting reversal. The final targeted run passed 24 tests across lease route, servicing documents, and contribution accounting (`/tmp/lease-final-targeted.log`). The final sample renderer completed (`/tmp/lease-render-final.log`); rendered PDFs remain in the legal-wording evidence directory.

The preceding full gate passed types, lint and documentation checks, then stopped at one outdated transaction mock: 19,510 unit tests passed and one failed (`/tmp/lease-full3.log`). That mock was corrected and its targeted suite passed. A new complete gate and independent review are required before merge; the parent agent records their final results and exact commit.

Temporary runner outputs are local evidence pointers, not repository artifacts. Browser metadata contains only synthetic fixture credentials and is intentionally excluded.

## Legal review corrections

The goods credit remains NET value under the approved formula. Every separately added cancellation cost now requires an evidence reference confirming it was not deducted from that valuation. The evidence is retained in the quote JSON and audit, enforced by server validation and `LeaseTerminationQuote_cost_overlap_evidence`. The new CHECK is NOT VALID for historical immutable rows, while PostgreSQL enforces all subsequent inserts/updates. Tests reject missing evidence through both the service and a direct accepted-quote write, and accept evidenced costs.

The agreements now identify the evidenced write-off/confirmed unrecovered theft loss as the termination and PV valuation event, independently of insurer settlement or physical return/inspection. Later actual insurer receipts remain credits, with excess reconciled/refundable to the entitled party. Commercial acceptance recalculates at the acceptance date and credits superseded/prepaid supplies instead of lapsing upon invoicing. No approval flag was changed.

Wording tests: 25 passed (`/tmp/lease-law-wording.log`). Sample renderer completed (`/tmp/lease-law-render.log`); `pdftotext` of both agreements confirms the operative changes (`/tmp/lease-law-commercial.txt`, `/tmp/lease-law-cpa.txt`). Real PostgreSQL tests after the final migration reset are recorded by the parent from `/tmp/lease-overlap-pg-final2.log`.

Historical total-loss event correction: the staff form/API now accepts an evidenced `lossOn` from commencement through today, independently of the actual `insuranceReceivedOn`. The event sets cancellation, PV discount date/rate, arrears valuation and damages supply/due date; the receipt keeps its actual date. The real-PG 1 October loss / 17 October recording regression also installs a later 10 October contract rate, verifies use of the earlier rate, credits post-loss prepaid invoices, verifies a separate 16 October insurer receipt, and proves cash conservation. Restoring the former implementation makes this regression fail (`/tmp/lease-event-regression-old-code.log`); the fixed implementation passes all four regression tests (`/tmp/lease-event-pg-final4.log`). New database enforcement independently bounds the loss date. Typecheck and scoped lint passed (`/tmp/lease-event-tsc.log`, `/tmp/lease-event-lint.log`).
