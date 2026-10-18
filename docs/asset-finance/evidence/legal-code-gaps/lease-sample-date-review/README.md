# CPA sample date correction

Fresh law review found that the old synthetic quote incorrectly described
23 February–15 March 2027 as twenty business days. The production helper
returns 24 March, allowing for the observed Human Rights Day holiday.
The fixture now uses that helper and fourteen explicit monthly rental cash
flows, discounted at 12% to the correct cancellation date. Goods value and
actual recovery cost remain R120,000 and R5,000. An independent numeric
regression checks PV, charge, VAT, arrears and total; the date test failed
before this correction. Both CPA and commercial quotes now derive their
figures from the same explicit schedule at their respective dates.

The PDFs and page images were regenerated using
`npx tsx scripts/asset-finance/render-legal-wording-deal-samples.ts` and
`pdftoppm -r 60 -png`. Cost descriptions/evidence now appear in the wrapping
value column, avoiding overlap with the amount. Extracted before/after CPA
text and hashes are retained here. No consumer NCA pins changed.

Validation: 29 tests across sample, servicing-PDF and loader suites pass;
focused lint passes. Full CI and fresh review remain separately required.
