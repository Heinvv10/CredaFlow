# GTM remediation finding tracker

Audit base: `5cb9279bc17d3c306e49c06c75b27660894eba73`. Fetched implementation base: `3a0a17e38b393d0c0707ed24e615be2b016f604e` (2026-10-17). Current main includes 179 changed files after audit; old line numbers are not authority.

Root checkout is dirty with unrelated handoffs and the untracked audit; preserved. Four active agents only: coordinator, MQ, A, B. No public runtime, real data, providers, spending or deployment authorized.

Closure requires regression results AND real browser acceptance on the integrated candidate. Source reproduction is recorded separately from runtime reproduction. No finding is closed yet.

## Current checkpoint (2026-10-17)

F01–F14 are independently reviewed and integrated, with F07's existing fix preserved for actual browser contrast verification. Recovery audit/single-use correction G06-R, G20 dialog description and G18-R bounded pinned-model acquisition are reviewed/integrated. Current frozen candidate is `3e6674986e5fd782a6c24dce9b3a22354bdd3088`, preserving actual main `5711f5331f5f966d830b0647c0f176a555e6c8f0` (PR166 UI reconciliation and default-off PR163 Statement AI). Targeted39 tests and ci:quick passed; both owned fixture databases migrated with AI false and financial invariants intact. Final full quality/integration and pristine image build are pending on this source. The already-running exact-source image build is adopted as candidate pending verification; it is not accepted merely because its bounded transfer progresses. No image/browser acceptance exists yet.

Prior candidate31339e0c full quality passed19569 unit tests/14 face tests and real integration passed2917 tests;2 accuracy cases explicitly skipped. Its pristine image attempt1 failed on a long SFace response; reviewed G18-R replaces acquisition with bounded, validated ranges while preserving official URLs/pins. These predecessor passes do not establish current combined-source acceptance. Earlier superseded integration b637a03e stopped143 and is never counted as passing.

F15 remains a separate unmerged technical/legal proposal owned by B. Rebase onto exact3e667 is assigned, retaining both Statement AI and declaration relations. Full legal-branch gates wait for MQ's host-suite resource release. Original executed pages are preserved; the certificate presentation requires lender legal approval before merge. No closure is inferred from signatures or historical boxes.

## F01 — Payouts require AVS while the AVS action is hidden/disabled by the collections flag

- Priority/status/owner: P1 / integrated / A.
- Current reproduction/root cause: AVS is gated only by collections, while payouts require it. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Allow AVS when payout OR collection engine requires it; retain permissions and account binding.
- Acceptance: Four flag combinations, API refusal/authorization, browser ready-to-payout journey. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F02 — Product editor claims rates are within NCA caps when the server's own rule rejects them

- Priority/status/owner: P1 / integrated / B.
- Current reproduction/root cause: Product form has fixed proxy caps; current server cap helper was subsequently changed. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Share implemented cap semantics with explicit rate/date/classification assumptions; no contract repricing.
- Acceptance: Boundary amounts/terms, monthly/daily annualization, changed repo rate, editor browser. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F03 — Board-pack portfolio composition does not cover the headline collectible book

- Priority/status/owner: P1 / integrated / B.
- Current reproduction/root cause: Composition groups ACTIVE only versus broader collectible headline. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Common collectible scope and explicit description.
- Acceptance: Product rows sum to headline including defaulted and entity loans; browser reconcile. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F04 — Sole-proprietor asset deals render the consumer application workflow and misleading blockers

- Priority/status/owner: P2 / integrated / A.
- Current reproduction/root cause: Application view branches on borrower shape instead of linked asset deal. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Deal-aware presentation for entity and natural-person deals; stored contractual term and decision evidence.
- Acceptance: Both natural-person contract types and completed deal pages without misleading prebooking blockers. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F05 — Non-NCA leases are offered a Section 129 action that the backend correctly refuses

- Priority/status/owner: P2 / integrated / A.
- Current reproduction/root cause: Collections action eligibility uses arrears without NCA regime. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Explain regime and suppress unavailable statutory action; retain backend refusal.
- Acceptance: Non-NCA lease, NCA asset and ordinary loan row/browser + refused direct request. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission: cb35643d5442a7532a0e169c98a05e8db4ce456e; ci:quick PASS and targeted 6 files/53 tests PASS per A-WAVE-A.md. B independent APPROVE (53 rerun tests); MQ integrated as a679a71c. Full combined/database/browser closure evidence pending.

## F06 — Mobile portal loses global access to several features and sign-out

- Priority/status/owner: P2 / integrated / A.
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

- Priority/status/owner: P2 / integrated / A.
- Current reproduction/root cause: Current source confirmed: translated poBusinessOnly promises buyer repayment/no salary sizing; PO qualification proxy checks interest only while review assesses scheduled full repayment. Current portal card already shows configured range only, so preserve it; false translated intake promise remains. Runtime verification pending.
- Intended smallest change: Truthful intake and repayment/assessment explanation; preserve affordability enforcement.
- Acceptance: PO submission, review, affordable/declined scenarios; no new underwriting model. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:9f2ba03ec0ac8454de4c41da1ee75eaaa801687c,7 targeted suites239 tests PASS and ci:quick PASS. B independent review pending; runtime approval/refusal acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F09 — READONLY users receive editable client forms whose writes are forbidden

- Priority/status/owner: P2 / integrated / B.
- Current reproduction/root cause: Source confirmed: client detail gates edits/New Application on showLoanBook; edit page only requires loan-book viewing. Actual READONLY browser pending.
- Intended smallest change: Render action permissions consistently; explanatory direct-link read-only state.
- Acceptance: Actual READONLY session controls/direct URL/PATCH 403; eligible staff retained. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F10 — Accounting preview stays stale after configuration is saved

- Priority/status/owner: P2 / integrated / B.
- Current reproduction/root cause: Settings changes do not invalidate sibling accounting preview. A/B confirmed present in current source; runtime pending.
- Intended smallest change: Shared invalidation and race-safe response handling; updated initial period.
- Acceptance: Confirm mappings/edit/go-live/VAT then close without reload; stale response regression. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration: aea9f3b4 +9891a0ef ->3a337585 +f7c72d67. A independent APPROVE9891a0ef with28 tests; B final ci:quick PASS. Combined quality/database/browser remain pending.

## F11 — “100% / Good Standing” implies broader compliance coverage than measured

- Priority/status/owner: P2 / integrated / B.
- Current reproduction/root cause: Source confirmed: Good Standing and statutory obligations complete headline represent stored subset. Browser/configuration scope verification pending.
- Intended smallest change: Name tracked scope and clarify excluded/unconfigured/not-due/unverified areas.
- Acceptance: Partial and complete tracked rows, absent config and browser labels. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F12 — Customer “Outstanding Balance” needs a clearer financial definition

- Priority/status/owner: P2 / integrated / A.
- Current reproduction/root cause: Current source confirmed: portalOutstanding is principal with charges off and totalToSettle with charges on. Conditional labels required; browser remains pending.
- Intended smallest change: Explain existing ledger amounts without changing financial calculations or legal documents.
- Acceptance: Part-paid asset and live default charges; staff/portal amount definitions and dated settlement distinction. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission/integration:314a9321 +34040560 ->0803b838 +87516c0f. B independent APPROVE,34 affected tests independently rerun; initial quick and corrected rendered regression pass. Root caught a false next-payment definition; correction removes it with fail-first rendered coverage. Full combined/database/browser pending.

## F13 — Customer-facing operator screens expose internal paths and development-phase copy

- Priority/status/owner: P3 / integrated / B.
- Current reproduction/root cause: Source confirmed internal buildTemplate/lib paths/migration instructions in notification client and Phase 7 go-live in IntegrationsTab. Browser pending.
- Intended smallest change: Replace internal implementation instructions with operational meaning.
- Acceptance: Settings browser copy retains prerequisites and simulation warnings. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F14 — Academy lesson references missing video and poster assets

- Priority/status/owner: P3 / integrated / B.
- Current reproduction/root cause: Source confirmed lessonAssets constructs all video/poster paths and lesson page unconditionally renders LessonPlayer. Clean-build/browser request proof pending.
- Intended smallest change: Deliberate text-only lessons unless packaged media exists.
- Acceptance: Clean-build all declared lesson assets no missing requests; browser text-only state. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Submission:81d92ef2a8f71dddae850bccbed11019aab8e7a2,12 targeted files57 tests PASS; final ci:quick/A independent review pending. Browser acceptance pending.

- Integration: included in frozen e1d5cff9 after independent reviewer approval and final branch ci:quick. Full quality stopped on F12 locale regression; integration/browser remain pending.

## F15 — Executed agreement leaves declaration boxes visually empty after electronic acceptance

- Priority/status/owner: P2 / review / B (separate unmerged legal branch).
- Current reproduction/root cause: Current source confirmed: five checks are UI-local; sign payload and AGREEMENT_SIGNED audit have no individual declaration record. Historical evidence cannot be inferred from a signature. Current renderer reproduced:5 PDFs, signature page visually confirms5blank boxes with signatures/dates, evidence/f15-baseline hashes retained. See POLICY-REVIEW.md.
- Intended smallest change: Prepare legally reviewable representation preserving original document/signature hash binding.
- Acceptance: Render before/after, signature/declaration audit binding and existing fingerprints; legal sign-off before merge. Targeted Vitest first; `npm run ci:quick`; combined `npm run ci:quality` + `npm run ci:integration`; browser evidence after integration.
- Ownership/dependencies: see OWNERSHIP.md; wave B depends on reviewed wave A handoff; F15 separate legal gate.
- Closure evidence: baseline render reproduced, no fix accepted. Separate unmerged candidate proposed: append-only declaration acceptance bound per signature ceremony with verified evidence certificate. Required legal approval remains outstanding; no historical inferred acceptance.


No finding is accepted yet. The original full-suite locale regression was independently corrected; final combined-source gates and immutable-image browser acceptance remain mandatory. See the current checkpoint and VALIDATION.md.
