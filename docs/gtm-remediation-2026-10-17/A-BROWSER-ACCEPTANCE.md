# Portal browser acceptance — candidate 6

Source: `aeacfc065b9b8234261c2158dd98271938671ad7`. Immutable image: `sha256:9ab61b563f05b99071a0e96a32f55a4e63966c241d986eb52079d30e4b2f83cb`. All actors, documents and amounts below belong to MQ's private disposable synthetic environments. No real provider or customer operation occurred. MQ's separate ledger governs final automated gates; this record establishes the browser scenarios stated below.

Evidence: [index](evidence/a-browser/index.json), including original timestamps, source/image identity, driver hashes, result records and screenshot hashes. Screenshots were visually inspected. Chrome was driven through real visible forms and links with isolated browser contexts, at 390×844 and 390×400. Private config/credentials/cookies/tokens are excluded. The prepared driver remains privately at `/tmp/cf-gtm-a-browser-20261017/portal-acceptance.mjs`; its exact hash at each run is retained in results.

## Results established so far

| Finding | Actual observation | Evidence / scope |
|---|---|---|
| F06 no-loan | Sipho opened the single Dialog with keyboard Enter, reached all ten eligible destinations, closed with Escape and restored trigger focus. Dialog fit the 390×400 viewport and its overflowing content scrolled. Visible sign-out returned to login; protected loans redirected to login afterward. | `navigation-initial.json`, `no-loan-menu-390.png`, `no-loan-menu-short.png`. Sipho context closed and root was notified before the separate recovery tests. |
| F06 with loan | Dineo passed the same ten destinations, short-screen/keyboard checks, sign-out and protected-page refusal. No duplicate native details menu remained. | `navigation-initial.json`, `consumer-menu-390.png`, `consumer-menu-short.png`. Business eligibility is established separately below. |
| F06 business | Trustee reached all eleven eligible destinations, including `/portal/business` redirecting to its linked entity, and passed keyboard/short-screen/sign-out/protected-page checks. | `business-final-config.json`, business menu/entry screenshots. Final configured-runtime run is clean; the earlier document404 attempt remains recorded separately. |
| F12 asset | Partially paid natural-person instalment sale: exact principal R285,890.82, remaining contractual instalments R374,769.94 and overdue R0.00. Correctly requests a lender dated settlement quote; no calculated settlement is presented. | Clean `asset-canonical.json`, asset overview/statement/loan screenshots. This exercises the existing non-S125 pricing branch without changing the contractual calculation. |
| F07 | Actual Chrome styles and canvas-composited backgrounds meet 4.5:1 for heading, reference, helper and copy action in light/dark modes. Tenant and default palette measured; default substitution was browser-only and did not alter stored configuration. | Clean `personal-canonical.json`, payment screenshots, ratio table below. |
| F12 personal, charges off | Overview accurately says current account amount/principal-only definition; list and statement say outstanding principal. Loan breakdown matches MQ helper-derived expected principal, overdue, remaining contractual instalments and dated settlement: each R531.43. | Clean `personal-canonical.json`, overview/statement/loan screenshots. This existing personal loan qualifies for the repository's calculated-settlement rules. |
| F12 positive charges | Separate live-charge fixture shows the charges-on definition. Exact principal R10,000.00; remaining contractual instalments R12,569.86; overdue and calculated dated settlement R13,601.41. All match MQ helper-derived expected values. | Clean `charges-canonical.json`, charges overview/loan screenshots. This is fixture-only activation evidence; real activation is not claimed. |
| F08 presentation | Product card and PO intake state income, expenses, existing debts and full scheduled repayment assessment, without the audited salary exemption promise. PO number, buyer and uploaded-document inputs are present. | Both clean canonical results and PO intake screenshot. No qualification or affordability enforcement bypass. |
| F08 fresh intake | Submitted R10,000 / 30-day synthetic order GTM-20261017 and marked synthetic PDF using ordinary UI. Declined optional bundled cover, acknowledged disclosure, then checked the now-enabled PASQ understanding. Reached the application detail page. | `fresh-po.json`, `po-submitted.png`; application `cmvcix8rh004daodbwgwh2uqz` handed to MQ for staff assessment/refusal. A has not established that staff outcome. |
| Additional route gap | Authenticated `/portal/payment/success` and `/portal/payment/failure` render actual return-page UI. Success says payment initiated. | Clean `personal-canonical.json`, both return-page screenshots. No provider callback, transfer, receipt allocation or settlement was exercised. |

Actual contrast ratios:

| Palette / theme | Heading and helper | Reference and copy |
|---|---:|---:|
| Tenant dark | 4.809 | 12.762 |
| Tenant light | 4.958 | 14.286 |
| Default dark | 4.761 | 12.635 |
| Default light | 5.023 | 14.474 |

Canonical personal, charges, asset and final-config business runs exited 0 with no uncaught browser exceptions, console warnings/errors or HTTP responses ≥400. This clean-console statement applies to those four runs only.

## Attempts and outstanding boundaries

Initial navigation used MQ's original `127.0.0.1` URL. Its no-loan and with-loan scenarios passed, but staff-login link prefetches normalized to `localhost`, causing CORS console messages. MQ corrected private ingress/auth-origin configuration and directed canonical `http://localhost:44213` and `http://localhost:46203`, with the same image/source/databases. The canonical personal and charges reruns are clean. The initial result also contains the subsequent business login timeout and is deliberately not represented as an overall passing run.

Business trustee and partially paid asset borrower initially showed `Invalid email or password` with the shared synthetic password. MQ repaired their fixture access through supported forgot-password → local SMTP OTP → reset APIs, audited, without raw credential writes or bank/approval/evidence changes. Their subsequent browser scenarios passed as described above; fixture repair is not claimed as A browser recovery acceptance. The first two business runs recorded one document GET `/portal/login`404 despite functional navigation/sign-out. MQ subsequently restored the required canonical NEXTAUTH_URL for correct recovery/invitation links, with the same image/source/actors/ports. A further fully instrumented business run (`1792249620743`) then passed with zero console/network errors. Earlier404 evidence remains in `business-canonical.json`; no product-source correction was made or inferred from this configuration observation. Asset canonical run is clean.

The fresh-PO run completed submission before the next asset context hit a brief connection refusal during MQ's private ingress restart. It is scoped evidence of the completed PO scenario, not an overall passing full run. No duplicate PO was submitted during canonical reruns.

Harness-only preparation corrections were an installed Puppeteer import-path adjustment, case-insensitive comparisons for CSS-uppercase financial labels, and checking PASQ understanding after disclosure enabled the control. Those failed attempts are preserved privately; no product source, guards or assertions about financial meaning were weakened. No Sipho password reset or shared runtime/database configuration was performed by A.

All final finding closure decisions remain with the coordinator. MQ's actual staff PO assessment, provider lifecycle and legal/language approvals are not supplied by this record. The independent operator-origin source fix30b2c7f8 and any resulting new candidate need their own integration/runtime acceptance; this record does not inherit that future source identity.
