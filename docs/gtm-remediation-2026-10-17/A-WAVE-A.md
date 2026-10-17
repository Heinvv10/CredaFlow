# Implementer A Wave A submission

Base: `3a0a17e38b393d0c0707ed24e615be2b016f604e`; branch `fix/gtm-a-20261017`; worktree `/home/hein/Workspace/CredaFlow-gtm-a`.

F01 remains present: application AVS route and page gate solely on collections even when payouts require AVS. Failing regression at current source: payouts=true/collections=false returns 409 instead of 200. Both surfaces now enable AVS when either engine needs it; both off still refuse. Provider selection, account subject/fingerprint matching, staff roles and tenant scope remain enforced. No providers activated.

F04 remains present: application only selects client/entity shape, and a natural-person asset application proceeds into consumer affordability panels. All linked asset applications now redirect to the tenant-scoped linked deal page, which owns stored term, classification, decision reasons, booked-state exceptions and signing/payout evidence. Existing consumer rate-cap blocker unchanged. Routing regression fails with the routing statement removed and passes with it restored for natural-person and entity borrowers. No historical evidence fabricated.

F05 remains present in current CollectionsTabs and unused legacy CollectionsTable: DPD alone exposes S129. Both now require the explicitly supplied regulatory regime; non-NCA overdue rows explain that Section 129 does not apply instead of offering a send control. Backend statutory refusal and all eligibility logic unchanged. Fail-first rendered regression showed S129 on NON_NCA lease. Covers NCA instalment sale, ordinary NCA loan and non-NCA lease.

Targeted verification (Node v22.23.1, maxWorkers=2): 6 files / 53 tests PASS: application page routing, AVS route, both collections tables, lib/avs and lib/payouts/avs. npm ci --legacy-peer-deps completed in this worktree. ci:quick PASS (app/demo TypeScript, ESLint, docs/mirrors, date boundaries and 44 date tests in each of four timezones).

No schema, migrations, compliance policy, mandated wording or persisted financial evidence changes. Full quality/integration and browser acceptance belong to the integrated candidate; not claimed here.

Browser acceptance:
- In owned synthetic tenant, vary collections/payout flags through all four combinations. For personal application, AVS card and API action exist if either flag on; both off hides/refuses. Use simulated provider only. Retain refusal for unauthorized staff and wrong-tenant application. Change account identity after passing AVS and confirm stale subject is rejected by payout gate.
- Visit audited natural-person instalment-sale and sole-proprietor operating-lease applications: redirect to their matching deal, contractual 48/36 month terms and recorded regime/decision reasons remain visible; no consumer missing-snapshot reassessment action on booked deal. Confirm entity application and ordinary consumer application routing separately.
- Collections: NON_NCA operating lease at 137 DPD explains statutory inapplicability and has no S129 send confirmation. NCA asset and ordinary NCA overdue rows retain S129. Direct NON_NCA backend request must continue refusing.

Rollback: revert this isolated submission (no database rollback needed). Remaining risk: destination deal page correctly applies its existing asset-feature/role authorization; no broader authorization granted. Browser acceptance pending.
