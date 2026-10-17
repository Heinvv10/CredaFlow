# Portal browser acceptance — final candidate 8

Source: `63a96479d290b215049b3a3e46977dc09305c21f`. MQ-verified immutable image: `sha256:1d3ad6299b0054726ca80ac40776fce6663cc148a817029d27ad07794eb5c4fe`. Canonical private base `http://localhost:44213` and separate positive-charge fixture `http://localhost:46203`. Both browser runs independently fetched health before login, required HTTP200 and asserted its actual `commit` equals this source. Health reported build time `2026-10-17T17:47:29+02:00`; health metadata is retained in each result and index. The image digest comes from MQ's inspected runtime provenance, not a browser-visible digest claim.

[Final candidate 8 evidence index](evidence/a-browser/final-63a96479/index.json) contains two actual successful runs: base 25 scenarios and charges 7 scenarios, both exited 0, with zero uncaught JavaScript exceptions, console warnings/errors or HTTP responses ≥400. All 31 screenshots are hashed; all 3 JSON records parse and contain neither seed nor current recovered credentials. Prior source66 and candidate6 evidence remains unchanged below.

The final source replay independently re-established:

- F06: no-loan Sipho first with current recovered credentials, borrower Dineo and eligible business trustee traversed all 10/10/11 destinations. Single Dialog, Enter/Escape/focus restoration, 390×400 scrolling/geometry, actual sign-out on the same host, protected-page refusal and linked business entry passed. Sipho's context closed and root was notified before any subsequent root recovery; all remaining contexts also closed after completion.
- F07: actual Chrome contrast passed tenant/default ×light/dark on the base borrower, minimum heading/helper 4.761:1, reference/copy 12.635–14.474:1. Separate positive-charge borrower also passed native tenant dark/light reference checks. Default palette substitution was browser-only.
- F12: overview, list, statement and exact detail values passed for personal charges-off, partially paid natural-person asset instalment sale and positive-charge borrower. Figures remain personal R531.43 in all four breakdown rows; asset principal R285,890.82 / remaining contractual R374,769.94 / overdue R0, requesting a lender quote without calculated settlement; positive-charge principal R10,000 / contractual R12,569.86 / overdue and dated settlement R13,601.41. Charge-mode descriptions match the displayed calculation.
- F08 and routes: truthful PO product/intake wording and required fields passed, existing synthetic PO receipt was read on this final source, and authenticated business entry plus payment success/failure UI rendered. No duplicate application or consent ceremony was submitted. Staff assessment/refusal and provider callback/money/payment allocation/settlement remain separate evidence.

A made no product edit, credential reset, runtime/configuration/database fixture change or provider activation during this replay. All data is synthetic; no external customer message was sent. MQ's final automated gates and coordinator's closure decisions remain separate. This portal replay does not establish the new operator sign-out flow: root owns that distinct actual browser acceptance.

## Historical candidate 7 checkpoint

Final source: `66c183c1d316b2c8d696b56aa37a42de4700445e`. Immutable image: `sha256:e4c12642a7013852aad870fe8da061c525100df186da359f03df2b1065563a1d`. Canonical private origins: `http://localhost:44213` (base) and `http://localhost:46203` (separate positive-charge fixture). Prior candidate 6 evidence is retained below and does not substitute for this final replay.

[Final evidence index](evidence/a-browser/final-66c183c1/index.json): full base run 25 scenarios and separate charges run 7 scenarios both exited 0 with **zero uncaught JavaScript exceptions, console warnings/errors and HTTP responses ≥400**. Result JSON records exact source/image, timestamps and driver hashes; screenshot hashes are indexed. All data is synthetic. Credentials/cookies/tokens remain private and are absent from artifacts.

- F06: recovered no-loan Sipho ran first, then borrower Dineo and eligible business trustee. Every eligible destination was actually traversed (10/10/11 respectively), including linked business entity entry. Keyboard Enter/Escape and focus restoration, actual sign-out and protected-page refusal passed. At 390×400 each Dialog spans x16–374/y16–384; its 366px client area scrolls 577px (no-loan/consumer) or 621px (business), making remaining links and sign-out reachable. No duplicate disclosure menu.
- F07: actual Chrome composited heading/reference/helper/copy contrasts passed all tenant/default × dark/light combinations. Minimum normal-text ratio 4.761:1. Default substitution remains browser-only; stored branding was untouched. Reference/copy ratios 12.635–14.474:1.
- F12: final overview/list/statement/detail checks passed for personal, partially paid natural-person instalment-sale asset and positive-charge borrower. Personal principal/overdue/remaining/dated settlement each R531.43. Asset principal R285,890.82, remaining contractual instalments R374,769.94, overdue R0; lender settlement-quote request is shown and no calculated settlement is presented. Positive-charge principal R10,000, remaining contractual R12,569.86, overdue/dated settlement R13,601.41. Each matches MQ helper-derived expected figures; charges-on/off definitions are accurate. This does not certify a real lender settlement quote.
- F08: truthful PO card/intake and required fields passed again; the existing submitted R10,000 synthetic PO application receipt was opened on final source. No duplicate application or new legal consent was submitted. The original actual intake belongs to candidate 6 evidence below; MQ's independent staff assessment/refusal remains its own acceptance record.
- Additional route evidence: authenticated business entry and payment success/failure presentation passed. Return pages do not prove provider callback, money movement, receipt allocation or settlement.

Sipho used the current private recovery credentials, not the stale initial file; A notified root immediately after sign-out and closed that context before any further root recovery actions. Asset/business credentials had previously been repaired through MQ's supported audited recovery APIs. No password reset, provider activation, fixture/database/configuration edit or external message was performed by A in this final tranche. All browser contexts closed after completion.

MQ's final quality/integration/image ledger governs those separate checks. Overall finding closure and release approval remain with the coordinator; provider, legal/language and production boundaries are unchanged.

## Historical candidate 6 checkpoint

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
