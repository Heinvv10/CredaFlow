# GTM remediation finding tracker

Audit base: `5cb9279bc17d3c306e49c06c75b27660894eba73`. Fetched implementation base: `3a0a17e38b393d0c0707ed24e615be2b016f604e` (2026-10-17). Current main includes 179 changed files after audit; old line numbers are not authority.

Root checkout is dirty with unrelated handoffs and the untracked audit; preserved. Four active agents only: coordinator, MQ, A, B. No public runtime, real data, providers, spending or deployment authorized.

Closure requires regression results AND real browser acceptance on the integrated candidate. Source reproduction is recorded separately from runtime reproduction. F01–F14 are accepted on the exact tested core source; F15 remains separate and legal-gated. Historical initial reproduction entries are superseded by the final closure ledger below.

## Current checkpoint (2026-10-17)

F01–F14 are independently reviewed and integrated. Current frozen candidate8 is `63a96479d290b215049b3a3e46977dc09305c21f`, preserving fetched main `685c86e951c0591324446af148d30d41ddc33652`. It includes both reviewed operator-origin corrections: middleware `30b2c7f8` and actual post-enrolment/header sign-out `ecf84394`. The latter passed 40 targeted tests, independent review and the frozen quick gate. Exact candidate8 full quality passed (1519 files/19675 tests, 14 actual face checks and production build); pristine image `sha256:1d3ad6299b0054726ca80ac40776fce6663cc148a817029d27ad07794eb5c4fe` passed pinned model/license/native-load verification. Final browser scopes passed and were independently reviewed; real PostgreSQL integration passed (333 files/2930 tests; two accuracy tests explicitly skipped from335 selected). Both required hosted checks passed on63a. Independent portable-artifact/restore review passed, and PR168 merged via the existing queue as `9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a`; root independently verified63a ancestry and an empty tree diff. No predecessor pass is inherited.

Predecessor candidate7 `66c183c1d316b2c8d696b56aa37a42de4700445e` passed full quality (1517 files, 19671 tests, 14 face checks, production build), real integration (333 files, 2930 tests; two accuracy tests explicitly skipped), hosted checks and pristine image `sha256:e4c12642a7013852aad870fe8da061c525100df186da359f03df2b1065563a1d`. Nine NCA fingerprints and five rendered samples/23 pages matched the preserved baseline. Its financial, mobile, pricing, accounting, recovery and token evidence is retained with exact provenance. Overall acceptance was held because actual sign-out returned the canonical staff origin and a 404; candidate8 must prove the correction through both real navigation paths.

F15 remains separate and unmerged, externally blocked for named-lender legal presentation approval. Corrected implementation `64a1fd37ae58dc790cb7acc48ece476ac47ced10` on accepted core63a passes full quality/integration, actual signing/countersigning/client download, RLS and PDF/restore acceptance. [Draft PR171](https://github.com/Heinvv10/CredaFlow/pull/171) contains the complete concrete review package. The earlier369candidate correctly failed RLS; the additive correction preserves its original applied migration and first signed receipt. See the final F15 checkpoint and F15-TECHNICAL-REVIEW.md; no legal approval, merge or deployment is implied.

## F01 — Payouts require AVS while the AVS action is hidden/disabled by the collections flag

- Priority/status/owner: P1 / accepted / A.
- Current reproduction/root cause: AVS is gated only by collections, while payouts require it. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Allow AVS when payout OR collection engine requires it; retain permissions and account binding.
- Acceptance: Four flag combinations, API refusal/authorization, browser ready-to-payout journey. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F02 — Product editor claims rates are within NCA caps when the server's own rule rejects them

- Priority/status/owner: P1 / accepted / B.
- Current reproduction/root cause: Product form has fixed proxy caps; current server cap helper was subsequently changed. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Share implemented cap semantics with explicit rate/date/classification assumptions; no contract repricing.
- Acceptance: Boundary amounts/terms, monthly/daily annualization, changed repo rate, editor browser. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F03 — Board-pack portfolio composition does not cover the headline collectible book

- Priority/status/owner: P1 / accepted / B.
- Current reproduction/root cause: Composition groups ACTIVE only versus broader collectible headline. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Common collectible scope and explicit description.
- Acceptance: Product rows sum to headline including defaulted and entity loans; browser reconcile. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F04 — Sole-proprietor asset deals render the consumer application workflow and misleading blockers

- Priority/status/owner: P2 / accepted / A.
- Current reproduction/root cause: Application view branches on borrower shape instead of linked asset deal. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Deal-aware presentation for entity and natural-person deals; stored contractual term and decision evidence.
- Acceptance: Both natural-person contract types and completed deal pages without misleading prebooking blockers. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F05 — Non-NCA leases are offered a Section 129 action that the backend correctly refuses

- Priority/status/owner: P2 / accepted / A.
- Current reproduction/root cause: Collections action eligibility uses arrears without NCA regime. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Explain regime and suppress unavailable statutory action; retain backend refusal.
- Acceptance: Non-NCA lease, NCA asset and ordinary loan row/browser + refused direct request. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F06 — Mobile portal loses global access to several features and sign-out

- Priority/status/owner: P2 / accepted / A.
- Current reproduction/root cause: Mobile hides desktop navigation and lacks complete global session controls. Current-source and runtime verification pending.
- Intended smallest change: Accessible mobile navigation from same enabled/authorized links.
- Acceptance: 390px borrower without/with loan and business rep; keyboard, touch, sign-out. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration:314a9321 +34040560 ->0803b838 +87516c0f. B independent APPROVE,34 affected tests independently rerun; initial quick and corrected rendered regression pass. Root caught a false next-payment definition; correction removes it with fail-first rendered coverage. Full combined/database/browser pending.

## F07 — Payment-reference card has very low contrast in dark mode

- Priority/status/owner: P2 / pending / A.
- Current reproduction/root cause: Current source already fixed after audit in 88cc3020: theme bg-raised mix and token foreground. Actual computed contrast/browser proof pending.
- Intended smallest change: Use existing contrast-tested surface/text tokens.
- Acceptance: Both palettes/themes/mobile; measure actual computed color contrast. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Closure evidence: none yet.

## F08 — PO-funding promise and the displayed affordability process conflict

- Priority/status/owner: P2 / accepted / A.
- Current reproduction/root cause: Current source confirmed: translated poBusinessOnly promises buyer repayment/no salary sizing; PO qualification proxy checks interest only while review assesses scheduled full repayment. Current portal card already shows configured range only, so preserve it; false translated intake promise remains. Runtime verification pending.
- Intended smallest change: Truthful intake and repayment/assessment explanation; preserve affordability enforcement.
- Acceptance: PO submission, review, affordable/declined scenarios; no new underwriting model. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:9f2ba03ec0ac8454de4c41da1ee75eaaa801687c,7 targeted suites239 tests PASS and ci:quick PASS. B independent review pending; runtime approval/refusal acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F09 — READONLY users receive editable client forms whose writes are forbidden

- Priority/status/owner: P2 / accepted / B.
- Current reproduction/root cause: Source confirmed: client detail gates edits/New Application on showLoanBook; edit page only requires loan-book viewing. Actual READONLY browser pending.
- Intended smallest change: Render action permissions consistently; explanatory direct-link read-only state.
- Acceptance: Actual READONLY session controls/direct URL/PATCH 403; eligible staff retained. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F10 — Accounting preview stays stale after configuration is saved

- Priority/status/owner: P2 / accepted / B.
- Current reproduction/root cause: Settings changes do not invalidate sibling accounting preview. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Shared invalidation and race-safe response handling; updated initial period.
- Acceptance: Confirm mappings/edit/go-live/VAT then close without reload; stale response regression. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F11 — “100% / Good Standing” implies broader compliance coverage than measured

- Priority/status/owner: P2 / accepted / B.
- Current reproduction/root cause: Source confirmed: Good Standing and statutory obligations complete headline represent stored subset. Browser/configuration scope verification pending.
- Intended smallest change: Name tracked scope and clarify excluded/unconfigured/not-due/unverified areas.
- Acceptance: Partial and complete tracked rows, absent config and browser labels. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F12 — Customer “Outstanding Balance” needs a clearer financial definition

- Priority/status/owner: P2 / accepted / A.
- Current reproduction/root cause: Current source confirmed: portalOutstanding is principal with charges off and totalToSettle with charges on. Conditional labels required; browser remains pending.
- Intended smallest change: Explain existing ledger amounts without changing financial calculations or legal documents.
- Acceptance: Part-paid asset and live default charges; staff/portal amount definitions and dated settlement distinction. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration:314a9321 +34040560 ->0803b838 +87516c0f. B independent APPROVE,34 affected tests independently rerun; initial quick and corrected rendered regression pass. Root caught a false next-payment definition; correction removes it with fail-first rendered coverage. Full combined/database/browser pending.

## F13 — Customer-facing operator screens expose internal paths and development-phase copy

- Priority/status/owner: P3 / accepted / B.
- Current reproduction/root cause: Source confirmed internal buildTemplate/lib paths/migration instructions in notification client and Phase 7 go-live in IntegrationsTab. Browser pending.
- Intended smallest change: Replace internal implementation instructions with operational meaning.
- Acceptance: Settings browser copy retains prerequisites and simulation warnings. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F14 — Academy lesson references missing video and poster assets

- Priority/status/owner: P3 / accepted / B.
- Current reproduction/root cause: Source confirmed lessonAssets constructs all video/poster paths and lesson page unconditionally renders LessonPlayer. Clean-build/browser request proof pending.
- Intended smallest change: Deliberate text-only lessons unless packaged media exists.
- Acceptance: Clean-build all declared lesson assets no missing requests; browser text-only state. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F15 — Executed agreement leaves declaration boxes visually empty after electronic acceptance

- Priority/status/owner: P2 / externally blocked / B (technical acceptance complete; named-lender legal approval outstanding).
- Current reproduction/root cause: Current source confirmed: five checks are UI-local; sign payload and AGREEMENT_SIGNED audit have no individual declaration record. Historical evidence cannot be inferred from a signature. Current renderer reproduced:5 PDFs, signature page visually confirms5blank boxes with signatures/dates, evidence/f15-baseline hashes retained. See POLICY-REVIEW.md.
- Intended smallest change: Prepare legally reviewable representation preserving original document/signature hash binding.
- Acceptance: Render before/after, signature/declaration audit binding and existing fingerprints; legal sign-off before merge. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Closure evidence: corrected implementation64a1fd37 passes full quality/integration, restricted-role RLS, actual SMTP/consumer signing/staff countersign/native consumer download and exact PDF/restore comparisons. Independent root/A technical acceptance complete. Draft PR171 remains unmerged for named-lender legal approval; no historical inferred acceptance. See the final F15 checkpoint below.


Historical pre-acceptance checkpoint: the original full-suite locale regression was independently corrected; the final combined-source gates and immutable-image browser acceptance were subsequently completed as recorded above and in the final closure ledger.

## Final candidate8 browser checkpoint

The route inventory's accepted status applies to its explicitly described browser scope, not an unrestricted product launch. A's32 mobile/contrast/balance/intake cases, MQ's pricing9/financial14/accounting9 states plus independent139-row balanced CSV, and coordinator operator/READONLY/staff/recovery/PASQ/selfie cases passed on actual63a96479. B independently reviewed those scoped results. Exact root evidence and SHA256 manifest are in `evidence/root-browser-candidate8/`; A evidence is submitted as `fbcd118d`, held outside the frozen artifact source. Operator G06-U both sign-out paths now actually reach the correct host's login form. Supported private `connection_limit=5` resolves four-app test-database exhaustion; failed partials are preserved. Exact integrated PostgreSQL subsequently passed333files/2930tests, with two accuracy tests explicitly skipped from335 selected; both hosted gates and the existing merge queue subsequently passed; see the final closure ledger. Earlier per-finding 'runtime pending' entries describe the initial reproduction checkpoint and are superseded only within these documented final scopes.

## Final closure ledger — core accepted, F15 separate

All accepted rows below bind to exact source `63a96479d290b215049b3a3e46977dc09305c21f`, private image `sha256:1d3ad6299b0054726ca80ac40776fce6663cc148a817029d27ad07794eb5c4fe` and tree-identical merged main `9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a`. Targeted fail-first and independent source reviews are retained in each submission; combined `ci:quality`, `ci:integration`, hosted quality/integration, PDF and model gates passed. Acceptance is for the stated behavior, not production activation.

| Finding | Status | Actual final browser/closure evidence |
|---|---|---|
| F01 | accepted | MQ14-case financial run: all four flags, subject/account/application/audit/server predicate, both-off409/three enabled200; flags restored. Overall payout readiness/dispatch not inferred. |
| F02 | accepted | MQ9 pricing boundaries match existing server guidance/caps, without saving/repricing products. |
| F03 | accepted | MQ board-pack SQL/UI reconcile26 collectible loans/3543918.83 including defaulted/entity scope. |
| F04 | accepted | MQ six asset application routes reach correct deal-aware presentation for natural/entity cases. |
| F05 | accepted | MQ non-NCA UI and notice dispatch422 refuse correctly; immutable missing-artifact PDF409 distinguished. |
| F06 | accepted | A32-case final run covers all10/10/11 links, keyboard/Escape/focus,390x400 bounds/scroll, actual sign-out and protected return. |
| F07 | accepted | Existing token fix preserved and measured across four palette/theme combinations: minimum4.761 normal text, reference/copy12.635+. |
| F08 | accepted supported presentation | Truthful product/intake wording, normal synthetic PO submission, actual full-single-repayment10450 versusNDI2470.46 yieldsNOTAFFORDABLE; no buyer-only underwriting or waiver invented. |
| F09 | accepted | Actual READONLY four page checks and three write403 probes, with targeted direct-page role gates. |
| F10 | accepted | MQ9 actual setup/preview/edit/reconfirm/close states and independently balanced139-row CSV; deferred race regressions passed. No destination export claimed. |
| F11 | accepted | Actual ADMIN compliance page shows precise tracked subset/exclusions rather than broad good-standing certification. |
| F12 | accepted | A personal/asset/positive-charge cases display principal/current/overdue/contractual/dated-settlement distinctions; non-S125 asset asks lender for quote. No calculations changed. |
| F13 | accepted | Actual settings/compliance pages retain actionable setup warnings without internal path/phase copy. |
| F14 | accepted | Actual training route renders written fallback when packaged media is absent; no broken advertised media. |
| F15 | externally blocked — named legal approval | Corrected implementation64a1fd37, full gates/actual ceremony/countersign/client-native download/RLS/PDF/restore accepted technically. Draft PR171 remains unmerged; exact certificate presentation and baseline G21 need named-lender legal review. Never included in PR168. |

A's final evidence commit `fbcd118d` and root evidence commit `9389e21a` are documentation produced after artifact freeze, intentionally separate from its baked source. MQ's private release directory is `/home/hein/credaflow-release-candidates/gtm-20261017-63a96479d290`; all1842 checksums/28 image blobs/5272 Git blobs and four database/upload restore drills passed independent A review. B independently approved the browser scopes. No public deployment, real provider activation, external customer message or real money movement occurred. The test-input image requires target-specific rebuild/acceptance before any production promotion. Remaining configuration gates are explicit in ACCEPTANCE.md.

## F15 final corrected technical checkpoint

Separate unmerged implementation `64a1fd37ae58dc790cb7acc48ece476ac47ced10` and private image `sha256:37c45525bf192f11dca2882858a7602894498cbec7be24f3188910ce47a2e91f` now pass full quality19687tests/14actualface/build and real integration334files/2932tests (two accuracy tests explicitly skipped,336selected,613.82seconds). The first369database run correctly failed the new receipt table's missing RLS policy; additive114th migration20261017200000 and a genuinely restricted-role fail-first test fixed it without editing the applied original migration or resetting the first signed receipt. Root/A independently approved the security delta.

A fresh second normal consumer ceremony passed on64: five explicit statements, actual local-SMTP OTP, signature, normal staff TOTP countersign and real owning-client Chrome attachment download. Exact stored/downloaded executed PDF SHA256`e1de7eb7b0a5083f31a552c8d463c3217021d254c841d7ec3a7432f276565836`; its first five pages equal the legacy renderer for the same inputs and one readable certificate is appended. Actual receipt/OTP/audit/countersign/document/access bindings and first-receipt preservation passed. Staff-native attachment is not claimed after its observed normal authentication rate limit; no limiter was cleared or bypassed.

The exact five statements/version/set hash are unchanged. Root/A reviewed actual certificate and original page5. Existing provider-signature/name crowding is explicitly preserved and recorded as G21 for legal review, not silently repaired. No statutory fingerprint was repinned. Named-lender legal approval of the precise presentation/version/sample hashes, historic/paper treatment and retention/rollback remains mandatory before merge. A independently approved the separate504-checksum portable legal package with restored114 migrations/two receipts/one assigned counterartifact/449 identical uploads and backed-up key decryption. [Draft PR171](https://github.com/Heinvv10/CredaFlow/pull/171) is open for the concrete legal review. Technical preparation is complete; neither review nor artifact is production promotion or merge authority.

Subsequent upstream boundary: another session merged PR169 as`c3fd5cf24a1c2437a631febff614268385dc4cf4` after accepted core9dfb. Its portfolio classification/demo-seed changes were preserved and are outside the frozen63a artifact; no claim is made that later main was baked or browser-accepted as that artifact. The evidence-only follow-up preserves upstream code and tracks its own required queue checks.
