# B Wave A — F02 / F03 / F10

Base: `3a0a17e38b393d0c0707ed24e615be2b016f604e` (fresh coordinator-fetched origin/main).
Branch: `fix/gtm-b-20261017`; isolated worktree `/home/hein/Workspace/CredaFlow-gtm-b`.
Status: implementation submitted for independent review; browser acceptance and integrated full gates pending.

## Current reproductions and minimal changes

- F02: `LoanProductForm` still used fixed 3% monthly PERSONAL / 5% DAILY_ACCRUAL proxies and certified "Within NCA cap". Red regression rendered the 3% unsecured product with repo 8.25% and failed because that certification existed. Replaced proxy table with the existing approval classification and base-rate helper. The example amount/term determines the transaction classification; the page supplies the SAST date and the same applied/approved repo basis (including feed cuts). Missing/implausible repo fails advisory checks. Explicit text limits the result to the illustrative transaction, names borrower-history/repeat-short-term checks and does not certify the whole product. No product, historic contract, rule, threshold or document wording changed.
- F03: board-pack `groupBy` still constrained status ACTIVE while the headline used ACTIVE/DEFAULTED/PENDING_WRITE_OFF/RESTRUCTURED. Red regression expected collectible scope and received ACTIVE. Grouping now uses all collectible statuses without excluding entity loans; visible composition scope and total reconcile its purpose with the headline.
- F10: accounting settings, mapping and preview were disconnected siblings; a successful preview remained actionable after configuration changes. Red regression changed settings revision and still saw the earlier Close action. A shared workspace invalidates preview before each setting/mapping request, refetches after completion and selects a newly saved go-live month. Mapping changes reload confirmation. GET and POST-refresh responses are guarded against older periods/revisions; preview disappears while refreshing. Settings/mapping/VAT edits disable while a close is in flight; successful close locks go-live locally. The authoritative server close/refusal logic is unchanged.

## Verification

Node: `/home/hein/.nvm/versions/node/v22.23.1/bin/node`. Dependencies installed locally with `npm ci --legacy-peer-deps` (initial shell Node20 emitted engine warnings; every gate/test thereafter explicitly selected Node22).

- Fail first: `/tmp/gtm-b-red-wavea.log`: F02 and F03 regressions failed, 7 existing tests passed.
- Fail first: `/tmp/gtm-b-red-f10.log`: revision invalidation regression failed, 5 existing tests passed.
- Six affected suites: `npx vitest run lib/product-config/interest-guidance.test.ts components/accounting/AccountingWorkspace.test.tsx components/accounting/AccountingExportPanel.test.tsx 'app/(dashboard)/reports/board-pack/page.test.tsx' components/products/LoanProductForm.test.tsx 'app/(dashboard)/reports/accounting/page.test.tsx' --maxWorkers=2` passed 6 files / 26 tests before the additional delayed-POST regression.
- Additional delayed-POST stale refresh regression: `npx vitest run components/accounting/AccountingExportPanel.test.tsx --maxWorkers=2` passed 1 file / 7 tests.
- Boundary coverage: R8,000/180 days versus R8,000.01/181 days, monthly/daily annualisation, changed repo/feed cut, absent/implausible repo. Accounting actual sibling journey covers confirmation → go-live → VAT → mapping edit → refusal → reconfirm → deferred close, with controls disabled during the POST and go-live locked afterward.
- Initial `npm run ci:quick`: app and demo TypeScript passed; ESLint caught three hook errors. Fixed without suppression: derive selected period from its initial-period identity, update request identity in a layout effect, clear messages after the fetch callback. Targeted ESLint passes. Full quick gate rerunning; coordinator must receive the actual result before queue admission.
- Final combined targeted command adds the loan-product edit page test: 7 files / 30 tests PASS, including stale successful GET and stale POST refresh after a new refusal, tenant-scoped approved/feed repo basis, and deferred-close controls.
- `git diff --check` passed.

## Database and risk boundaries

No schema/migration/enforcement changes and no accounting source/journal or loan calculation changes. No database writes or real provider calls were made. Mocked/component tests establish rendering and invalidation, not migrated-database/browser closure. Full integrated quality, integration and browser evidence remain required. Configured launch rates need lender approval; this change deliberately does not reprice existing products to make them pass.

## Browser acceptance for MQ

1. Product editors: with synthetic approved repo 8.25%, personal unsecured 3% must report 36% annual above 29.25%; PO daily 2.5% unsecured must report its 30.42% equivalent above the same cap. Change preview to R8,000/180 days and beyond each boundary; verify transaction labels change and history limitation remains. Test a newer feed cut and a changed approved rate; reload the editor to obtain the explicit new dated basis. Check missing repo refuses guidance for unsecured; asset finance defers to the deal.
2. Board pack: fixture contains ACTIVE, DEFAULTED, PENDING_WRITE_OFF, RESTRUCTURED, completed/written-off and entity accounts. Sum each product row's count/principal and compare to composition total and Loan Book. Non-collectible statuses must be absent. Check empty book and print/dark readability.
3. Accounting: without manual reload, confirm mappings, set a synthetic go-live month, toggle VAT, edit a mapping, observe confirmation withdrawn/refusal, reconfirm then close an eligible month. While each request/preview is delayed, old eligibility must not return; while close is delayed, settings/mapping/go-live controls disable. Close must lock go-live immediately. Inspect actual resulting batch and audit; no provider push is required/authorized.

Independent review, integration SHA and browser evidence are recorded by the coordinator/MQ after submission.
