# Final CPA assessment and total-loss browser acceptance

Synthetic local stack at union `88dea40e`, Node22, isolated clone with its own
npm install and fresh disposable PostgreSQL16 migrations. Password+TOTP staff
login; lender legal approval remained false. Cron secret unset; no provider,
external payment, real message, deployment or lender activation occurred.

Six screenshots show required refund proof → completed loss; required lessor
reasoned net charge → retained assessment; unilateral consumer notice → retained
Reg5 assessment. Browser performed five actual POST actions, statuses
201/200/200/200/200, with no page errors (`result.json`). Actual staff forms,
file upload, server routes, audits and PostgreSQL guards were exercised.

Stored state: TOTAL_LOSS/COMPLETED, no inspection date, terminal TOTAL_LOSS asset,
450,000-cent maintenance refund with unique synthetic bank reference and
64-character retained proof hash. Loss Payment count and amount sum were
unchanged across refund closure (`stored-loss.txt`). Lessor waiver preserved
actual costs and applied the single real goods proceeds receipt. Consumer notice
was recorded before assessment, without accepting a cancellation quote.

Optional repeat seed: `LEASE_FINAL_BROWSER_SEED=1 npx vitest run
lib/asset-finance/lease-final-browser-seed.test.ts` on an owned migrated DB only.
It writes private fixture metadata to /tmp, never repository credentials.
Browser runner is `browser.cjs` (uses local metadata and installed Playwright).
These screenshots precede final proof-lock/amended-rental fix integration;
the relevant unchanged UI paths are accepted here. Final source/DB reviews and
full CI are recorded separately; no whole-goal completion claim is made here.
