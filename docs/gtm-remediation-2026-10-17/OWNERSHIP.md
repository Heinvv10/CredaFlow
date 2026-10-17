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
