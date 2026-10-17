# CredaFlow page spacing and navigation review

Reviewed all **161 page source entries**, with **372 route screenshots** and **43 additional tab/menu/form states**. The inventory identifies each source, requested/final URL, viewport, observed state and limitation. A dashboard alias means page-source count differs from unique URLs.

Fixed page gutters and readable form widths; cramped heading/label spacing; wrapping tabs; clipped client, FSCA and opportunities controls; the compressed lead sidebar; FIC export labels; mobile portal navigation; viewport-constrained dialogs; specific settings titles; and Message dropdown positioning/Escape behavior.

The final route sweep recorded no page JavaScript errors, page-level horizontal overflow or clipped heading/form/action elements under its declared DOM checks. Intentional scoped 404s and unconfigured provider pages are not counted as working provider journeys. The menus and form states were reviewed separately, including the final staff-drawer footer/keyboard check.

Validation: production build including TypeScript passed; full eslint passed; the full unit suite passed **19,424 tests** in 1,486 files, with 2,932 gated tests in 333 files skipped. The insurer-form tests now use a real DOM portal so they continue testing initialization and unsaved edits with the accessible dialog. DB integration suites were not rerun for these presentation-only changes.

Screenshots were reviewed through contact sheets and selected full images; DOM geometry covered the rendered page, including content below the first viewport. This is targeted UI acceptance, not proof of every workflow state or full WCAG conformance. See AUDIT-SCOPE.md and the explicitly bounded rows in PAGE-INVENTORY.csv.

All work is local on fix/ui-spacing-navigation. Nothing was merged, deployed or published. No live demo was changed.

Local evidence: [page inventory](uiux-2026-10-17/website-audit/PAGE-INVENTORY.csv), [findings](uiux-2026-10-17/website-audit/FINDINGS.json), [screenshot ledger](uiux-2026-10-17/website-audit/SCREENSHOT-LEDGER.json). These generated artifacts are intentionally ignored by git.

# CredaFlow UI review — 17 October 2026

Scope: spacing, gutters, readable headings and labels, responsive controls, staff and client navigation, tabs and safe modal entry states across every page source in this checkout. Target users are lender staff, synthetic borrowers and operator staff. South African lender identity and statutory wording are preserved.

All 161 route source entries are registered. Each was requested at 1440 and 390px; 25 representative entries were also checked at 900px and in light mode. All source files were inspected for shared layout patterns. Aliases, redirects, disabled integrations and invalid-link states are explicitly labelled in PAGE-INVENTORY.csv.

The isolated synthetic database was created and migrated locally. No shared database, real borrower, external delivery, payment or production deployment was changed. One synthetic insurance policy was bound through the application's disclosure/PDF/bind APIs to inspect its real detail screens. No regulated wording changed.

Limits: consumer agreement and debit mandate fixtures redirect because those documents are not prepared. Their active signing screens were source-reviewed, while asset-finance document viewing was rendered with legitimate seeded fixtures. PASQ/selfie/reset links were checked in invalid/expired states; camera capture and a real password change were not exercised. External QuickQuote content is unavailable without provider configuration. No assertion covers every business status, every role/language combination, full accessibility conformance, legal compliance, production conversion or field performance.

## Page-by-page coverage

| Source page | Rendered state | Coverage note |
| --- | --- | --- |
| `(dashboard)/applications/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/applications/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/applications` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/assets/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/assets/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/assets` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/deals/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/deals/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/deals` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/entities/[id]/edit` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/entities/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/entities/[id]/people/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/entities/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/entities` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/reference-rates` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/suppliers/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/suppliers/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/asset-finance/suppliers` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/clients/[id]/edit` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/clients/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/clients/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/clients` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/collections/[loanId]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/collections/batches` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/collections` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/breach-log` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/bureau-overrides` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/bureau-submissions` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/coi` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/complaints` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/dsar` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/fic` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/fsca-return` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/ncr-return` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/screening` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/compliance/tcf` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/contacts/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/contacts` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/agent-hub` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads/[id]/convert` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads/[id]/duplicates` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/leads/queue` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/opportunities` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/crm/re-engagement` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/dashboard` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/disbursements` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/disbursements/payouts` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/inbox` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/inbox/reconciliation` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/insurance/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/insurance/claims/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/insurance/claims` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/insurance/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/insurance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/learn/[lesson]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/learn` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/loans/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/loans` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/no-access` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)` | normal-render | Dashboard source is also exported by /dashboard; alias reviewed. |
| `(dashboard)/payments/bank-reconciliation` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/payments` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports/accounting` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports/advisor` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports/arrears-aging` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports/board-pack` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports/default-charges` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/reports` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/api` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/asset-finance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/attorneys` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/audit-log` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/automation` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/bank-sync` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/branches` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/comms` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/credit-policy` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/documents/[id]/edit` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/documents` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/email/logs` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/email` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/identity` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/insurance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/insurers` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/integrations` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/languages` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/login-log` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/notifications` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/insurance/[id]/eligibility` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/insurance/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/insurance/[id]/rates` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/insurance/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/insurance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/loan/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/loan/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products/loan` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/products` | expected-redirect | Intentional redirect to loan products. |
| `(dashboard)/settings/repo-rate` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/security-policy` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/security` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/support-access` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/users` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(dashboard)/settings/whatsapp` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/grants` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/lenders/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/lenders/[id]/support` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/lenders/new` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/usage` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/(console)/users` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/login` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/security` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(operator)/operator/set-password` | invalid-or-expired-link | Missing/expired operator reset-link state reviewed; no password change performed. |
| `(portal)/portal/[...rest]` | expected-404 | Intentional portal catch-all: scoped 404 reviewed. |
| `(portal)/portal/agreement/[applicationId]` | expected-redirect | Draft fixture has no generated consumer agreement: expected redirect reviewed; signing UI source-reviewed only. |
| `(portal)/portal/applications/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/applications` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/apply/[product]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/apply` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/business/[entityId]/contracts/[loanId]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/business/[entityId]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/business` | expected-redirect | Single authorised business: expected redirect to its entity page. |
| `(portal)/portal/documents` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/insurance/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/insurance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/loans/[id]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/loans` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/mandate/[applicationId]` | expected-redirect | Draft fixture has no prepared debit mandate: expected redirect reviewed; signing UI source-reviewed only. |
| `(portal)/portal/notifications` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/payment/failure` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/payment` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/payment/success` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/profile` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/sign/deal-signers/[signerId]` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(portal)/portal/statement` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(quote)/quote` | expected-404 | External quote host/embed is not configured: disabled/404 state reviewed; provider content unverified. |
| `(website)/site/apply` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/calculators` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/contact` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/privacy` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/products/insurance` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/products/insurance/quotes` | expected-404 | External quote configuration is absent: disabled/404 state reviewed; provider content unverified. |
| `(website)/site/qualify` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/regulatory-information` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `(website)/site/terms` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `forgot-password` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `login` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `Home` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `pasq/[token]` | invalid-or-expired-link | Expired/invalid one-time-link state reviewed; valid PASQ-link states not exercised. |
| `portal/forgot-password` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `portal/login` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `portal/register` | normal-render | Default page rendered and checked for clipping, gutters and responsive layout. |
| `reset-password` | invalid-or-expired-link | Missing/expired reset-link state reviewed; no password change performed. |
| `selfie/[token]` | invalid-or-expired-link | Expired/invalid one-time-link state reviewed; valid selfie capture/camera states not exercised. |
