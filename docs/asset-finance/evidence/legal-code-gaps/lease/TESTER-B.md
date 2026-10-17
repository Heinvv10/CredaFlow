# Independent tester B — candidate cb9ac237

Tested in a separate shared clone with its own npm ci installation and disposable PostgreSQL 16 container `cf-it-lease-tester-b-1017`. No shared database, activation, deployment or outbound messaging.

Staff password and actual TOTP login passed against the seeded local app. Screenshot 04 captures no end-of-term election; screenshot 05 captures the automatically continued defaulted CPA lease. The real invoice batch returned issued=4, failed=0, extensionRentals=1. The automatic outcome was EXTENDING with neither a staff nor client elector. Extension period 7 was due and supplied 17 October 2026, invoiced as INV-000012, with invoice and rental totals both 24,133,196 cents. No browser page errors. The tenant retained requireStaffTotp=true and assetFinanceLegalWordingApproved=false.

The independently added simultaneous-total-loss test passed: two concurrent requests produced exactly one recorded result and one refused result, one quote, and exactly 100,000 cents insurer cash and schedule allocation.

Command: `RUN_ASSET_FINANCE_LEASE_IT=1 npx vitest run lib/asset-finance/lease-tester-b.integration.test.ts` with DATABASE_URL and IT_CONTAINER exported by scripts/it-db.sh.

Additional exact-candidate PostgreSQL run: lease-legal, review-b-repro, lease-servicing-rules-eot and lease-invoices suites: 27 passed, one failed. The failure at lease-servicing-rules-eot.integration.test.ts:218 is an outdated mutation-test substring: guardLeaseEndOfTerm no longer contains its expected extensionEndsOn clause. This candidate cannot claim the integration gate passes until corrected and rerun. Local log: /tmp/lease-tester-b-existing.log.

A separate experimental historical CPA assessment repro is recorded in the tester's next commit. It inserts a later ContractRate as fixture setup and demonstrates use of the latest rate instead of the fixed cancellation date's rate. Ordinary application reachability of that later rate after unilateral cancellation has not been established, so it is not presented as a demonstrated user-path defect.
