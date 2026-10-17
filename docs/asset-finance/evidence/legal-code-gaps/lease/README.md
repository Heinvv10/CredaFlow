# Lease legal-gap candidate evidence — 2026-10-17

Scope: goal items 6–14 and 25. Synthetic local tenants only; no deployment or activation.

The browser exercised staff password/TOTP login, a unilateral CPA cancellation notice (HTTP 200), and an itemised goods-value/cost assessment (HTTP 200), with no browser page errors. Screenshots 01–03 record the notice and assessment flow. Screenshot 04 records the lease without an end-of-term election. A real invoice batch subsequently created an automatic EXTENDING outcome and one extension rental (`issued: 4`, `failed: 0`); the post-batch screenshot was not captured because the script expected the internal status instead of the displayed “Month to month” label.

Real PostgreSQL integration evidence before the final candidate edits: 18 suites, 177 tests passed, one browser-seed test skipped (`/tmp/lease-all-it3.log`). Integration tests include unilateral notice, retained rentals during the notice period, automatic continuation while defaulted, supply VAT, commercial acceptance repricing, total-loss insurance receipts, lessor damages, and prepaid invoice credits. Later maintenance-credit/EOT guard amendments require the final integration gate and fresh review; the earlier count is not an exact-candidate acceptance claim.

TDD evidence includes red-to-green charge arithmetic, cancellation completion blocking, and maintenance contribution accounting reversal. The final targeted run passed 24 tests across lease route, servicing documents, and contribution accounting (`/tmp/lease-final-targeted.log`). The final sample renderer completed (`/tmp/lease-render-final.log`); rendered PDFs remain in the legal-wording evidence directory.

The preceding full gate passed types, lint and documentation checks, then stopped at one outdated transaction mock: 19,510 unit tests passed and one failed (`/tmp/lease-full3.log`). That mock was corrected and its targeted suite passed. A new complete gate and independent review are required before merge; the parent agent records their final results and exact commit.

Temporary runner outputs are local evidence pointers, not repository artifacts. Browser metadata contains only synthetic fixture credentials and is intentionally excluded.
