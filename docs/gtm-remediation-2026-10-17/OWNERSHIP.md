# File ownership and resource registry

Base for all branches: `3a0a17e38b393d0c0707ed24e615be2b016f604e`.

| Owner | Branch | Worktree | Findings | Exact writable paths |
|---|---|---|---|---|
| Coordinator | docs/gtm-coordination-20261017 | /home/hein/Workspace/CredaFlow-gtm-coordinator | tracking/acceptance | docs/gtm-remediation-2026-10-17/{TRACKER,OWNERSHIP,ACCEPTANCE,POLICY-REVIEW}.md |
| MQ | fix/gtm-integration-20261017 | /home/hein/Workspace/CredaFlow-gtm-mq | integration/runtime | sole writer of integration checkout; docs/gtm-remediation-2026-10-17/QUEUE.md and release/runtime records; reviewed submissions only |
| A | fix/gtm-a-20261017 | /home/hein/Workspace/CredaFlow-gtm-a | F01/F04/F05 | app/(dashboard)/applications/[id]/{page.tsx,page.test.tsx}; app/api/applications/[id]/avs-check/{route.ts,route.test.ts}; components/collections/{CollectionsTable,CollectionsTabs}.{tsx,test.tsx}; components/loans/EntityBorrowerNotice.tsx if necessary; docs/gtm-remediation-2026-10-17/A-WAVE-A.md |
| B | fix/gtm-b-20261017 | /home/hein/Workspace/CredaFlow-gtm-b | F02/F03/F10 | components/products/LoanProductForm.{tsx,test.tsx}; app/(dashboard)/settings/products/loan/{[id],new}/page.tsx; lib/product-config/interest-guidance.{ts,test.ts}; app/(dashboard)/reports/board-pack/{page.tsx,page.test.tsx}; components/reports/BoardPackClient.tsx; app/(dashboard)/reports/accounting/{page.tsx,page.test.tsx}; components/accounting/{AccountingSettingsPanel,AccountingExportPanel,AccountMappingEditor,AccountingWorkspace}.{tsx,test.tsx}; docs/gtm-remediation-2026-10-17/B-WAVE-A.md |

No agent may edit another owner's paths. New shared-file needs require transfer recorded here before implementation. Tests adjacent to owned files are owned only as enumerated. No schema, migration, package, theme-global or statutory wording edits currently assigned.

Use Node 22.23.1 at /home/hein/.nvm/versions/node/v22.23.1/bin; each worktree npm ci --legacy-peer-deps. Targeted tests at most two workers. Heavy quality/integration/build suites serialize with coordinator resource lock. MQ alone owns shared candidate DB/runtime; A/B use unique disposable DB containers. Never run a development server and tests starting a development server in the same worktree.

2026-10-17 initial ownership approved through agent messages. Heavy lock initially reserved for MQ integrated candidate; no full suite currently running under this session.

## Wave B ownership approved (implementation starts after A/B Wave A commits)

A same branch/worktree, F06/F07/F12: components/app-shell/PortalSidebar.tsx, PortalSidebar.test.ts, PortalSidebar.mobile.test.tsx; app/(portal)/portal/payment/{page.tsx,page.test.tsx}; app/(portal)/portal/{page.tsx,loans/[id]/page.tsx,loans/[id]/page.test.tsx,statement/page.tsx,statement/page.test.tsx}; lib/i18n/messages/{en,af,zu,xh}/{portal-home.ts,portal-loans.ts,portal-statement.ts,portal-shell.ts}; lib/portal/loan-charges.test.ts; docs/gtm-remediation-2026-10-17/A-WAVE-B.md. PortalShell.tsx unassigned and not required by native disclosure menu approach.

F07 appears already fixed after audit by 88cc3020, current main uses color-mix brand8%+cf-bg-raised with theme text. Do not overwrite; actual computed contrast/browser evidence still required. F12 portalOutstanding is principal when charges disabled and totalToSettle when enabled: unconditional principal relabel is incorrect. Preserve calculations, use conditional precise terminology.

B same branch/worktree, F09/F11/F13/F14: app/(dashboard)/clients/[id]/{page.tsx,page.actions.test.tsx,edit/page.tsx,edit/page.test.tsx,edit/page.loan-book.test.tsx}; components/compliance/ComplianceDashboardClient.{tsx,test.tsx}; app/(dashboard)/settings/notifications/NotificationsSettingsClient.{tsx,test.tsx}; components/settings/IntegrationsTab.{tsx,test.tsx}; app/(dashboard)/learn/[lesson]/page.tsx; components/manual/LessonPlayer.{tsx,test.tsx}; lib/manual/media.{ts,test.ts}; docs/gtm-remediation-2026-10-17/{B-WAVE-B,B-REVIEW-A-WAVE-A}.md. Also B owns existing app/(dashboard)/settings/products/loan/[id]/page.test.tsx for Wave A repo-basis prop regression.

A Wave A submission cb35643d5442a7532a0e169c98a05e8db4ce456e (base3a0a17e3) is in independent B review; targeted 6 files/53 tests and ci:quick pass per A report. No integration admission yet; full combined gates/browser pending. Root preliminary inspection found no blocker, independent formal review still required.

A additionally owns app/(portal)/portal/loans/{page.tsx,page.test.tsx} if detail/definition requires explicit list prose, and docs/gtm-remediation-2026-10-17/A-REVIEW-B-WAVE-A.md. B review APPROVE for A cb35643d received with independent rerun 6 suites/53 tests; coordinator admitted A to MQ integration, browser remains pending.

B F09 additions approved: app/(dashboard)/applications/new/{page.tsx,page.test.tsx}. Replace unneeded clients/[id]/page.actions.test.tsx with components/clients/ClientRecordActions.{tsx,test.tsx}, extracting only two existing action controls and testing actual role floor. A F08 next-wave approved: lib/i18n/messages/{en,af,zu,xh}/portal-apply.ts; app/(portal)/portal/apply/{PortalApplyClient.tsx,PortalApplyClient.test.tsx}; app/(portal)/portal/apply/[product]/{PoFundingFields.tsx,PortalApplyProductClient.po.test.tsx}; docs/gtm-remediation-2026-10-17/A-WAVE-C.md. No underwriting/formula edits assigned.

Wave A integrated: A cb35643d -> a679a71c (B independent approve,53 tests). B aea9f3b4 ->3a337585,9891a0ef ->f7c72d67 (A independent approve final SHA,28 tests and final ci:quick green). Reviewer record22edb02c ->c60ad243. Combined targeted+quick running; full gates/image held until experience+F08 integrated. No main merge yet.

A F08 additions: components/applications/AffordabilityCapture.{tsx,test.tsx} and already-owned application detail page; optional single-scheduled-repayment label only, no underwriting arithmetic. Source correction: PO portal card is already range-only; do not change good current behavior based on historical proxy assumption. A WaveB314a9321 in B review; root found false account definition below next-payment amount in PaymentHero, queue held for corrected follow-up and review.

Coordinator owns docs/gtm-remediation-2026-10-17/evidence/f15-baseline/* for unchanged-current-render reproduction artifacts and digest manifest (synthetic source fixture). A owns app/(portal)/portal/page.test.tsx for PaymentHero regression. B F09 additions approved: app/(dashboard)/clients/{page.tsx,page.test.tsx,new/page.tsx,new/page.test.tsx}; components/clients/ClientsPageClient.{tsx,test.tsx}; only actual create affordance/direct-access alignment with existing POST role floor.
