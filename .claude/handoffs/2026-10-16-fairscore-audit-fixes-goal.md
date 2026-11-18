# /goal — Fair Score pre-market audit: fix every finding (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-16-fairscore-audit-fixes-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops, one workstream PR at a time. Do not stop to ask, except at a Confirmation Gate (§13) or a genuine external blocker. Loop until every Success Criterion (§12) is proven with evidence, then publish the evidence, queue the PRs with mq, write a handoff and stop.`

---

## 1. Mission

A browser audit of the Fair Score demo on 2026-10-16 found 4 blockers, ~14 compliance items and ~60 UX/data defects. Fix all of them in the product (not by editing demo data by hand), prove each fix with a test that fails on the old code, re-run the audit flows in a real browser, and finish with a fresh Fair Score bake that a prospect can be shown.

"Fixed" means: real DB rows, real API, RBAC enforced server-side, the UI showing it, a test that goes red when the fix is reverted, and a browser screenshot of the corrected screen. A hidden button with the API still open is NOT fixed. A copy change with the wrong number underneath is NOT fixed.

Sources (read both first):
- Audit doc (the readable version): https://claude.ai/code/artifact/e2015c0f-7f42-4906-8863-c0659aa7dbb3 — read with the Claude Docs connector.
- Raw notes with exact screens, figures and HTTP codes: `.claude/handoffs/2026-10-16-fairscore-audit-findings.md` (113 lines; each bullet = one finding; tag in `[]` = area).

Every finding in that notes file must end up in the §12 ledger as FIXED (with evidence), GATED (§13, with what's needed), or WONTFIX-with-reason agreed in §2a. Nothing silently dropped.

---

## 2. What already exists — do NOT redo

- `origin/main` at `ba16fbc3` (2026-10-16). Branch per workstream from latest `origin/main`; merge **only** via `mq add <pr>` (merge-queue worker; agents' `gh pr merge` is blocked).
- Full autonomy on CredaFlow (memory `feedback_credaflow_full_autonomy`): push, PR, merge via mq and **migrations are pre-approved** after gates + blind review. Still ask for: prod deploy, money, contracts, **NCA wording** (§13).
- Root `CLAUDE.md` rules that bite here: NCA document text and COB/PASQ numbers are pinned (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`) — re-pin only with a proof of what changed; every state change through `lib/audit.ts`; DB-enforced rules need `RUN_*_IT` integration tests (mocked Prisma can't see triggers); hand-written SQL lives in `prisma/migrations/20261009000000_baseline/migration.sql` and is mirrored in `lib/db-baseline.test-helpers.ts` — a trigger change is a NEW hand-written migration + updated static tests.
- Integration DB: `eval "$(bash scripts/it-db.sh up cf-it-<unique>)"` → `bash scripts/it-db.sh check` → `npx prisma migrate deploy` → `bash scripts/run-integration-tests.sh` → `bash scripts/it-db.sh down cf-it-<unique>` (teardown with `docker rm -fv` semantics, always).
- Gates: `npm run ci:quality` before every PR; `npm run ci:full` before queueing. `npm ci --legacy-peer-deps` in each new worktree.
- Lists are registries: new permissions/audit actions/cron jobs/simulated integrations go in `lib/registry/<kind>/` files, schema in `prisma/schema/` (conflict-free registries, #110).
- No Playwright in the repo. **Browser acceptance = the claude-in-chrome tools** against a local seeded stack (as the audit did). Do not add Playwright.
- Local browser setup that works (learned the hard way): staff app on `http://127.0.0.1:<port>`, portal on `http://localhost:<port>` — never both on one host (shared cookies sign each other out). `*.localhost` names are refused by the host allow-list. Typing test passwords is allowed only on these local hosts.
- Fair Score live stack: compose dir `/home/hein/Workspace/CredaFlow-fairscore`, staff :3330, portal :3332, DB container `credaflow-fairscore-db` (user `credaflow`, db `credaflow_demo`). It currently holds audit test data. Pre-audit dump: `~/credaflow-fairscore-data/backups/pre-market-audit-20261016T1650.dump`. Do **not** develop against the live stack; use a local dev stack or the IT DB.
- Demo tooling: `scripts/demo/build-image.sh`, `scripts/demo/bake.sh`, `scripts/demo/restore.sh`, `scripts/demo/upgrade-stack.sh`, `scripts/demo/update-runner.sh` (run from ANOTHER checkout), persona/lender data in `prisma/demo-lender.ts`. Read `.claude/handoffs/2026-10-14-fairscore-native.md` before baking. Bakes only after 17:00 (shared vLLM on :8100 is FibreFlow production) and never while an Acme/Tsela bake runs (`ps aux | grep scripts/demo/bake.sh`).

### 2a. Product decisions (already made by Hein — build these, don't re-ask)

1. **Countersign order:** allow either order. The provider countersignature may be recorded once (NULL → value) after the debit mandate is signed. Every other frozen field stays frozen.
2. **Demo lender identity:** a clearly fictional demo lender — obviously fake but plausible NCR/company/address values plus a visible "Demo lender" label. No FAIS/FSP claim anywhere unless `TenantConfig` holds an FSP number. Real Fair Score details are NOT used.
3. **Segregation of duties:** new per-lender setting, **ON by default**. When on: the approver of an application cannot disburse it; the person who records the in-branch consumer signature cannot countersign; whoever creates an asset-finance payout cannot approve it. Demo stacks may turn it off; real lenders keep the default. Changed only by ADMIN/SUPER_ADMIN, audited.
4. **Scope includes:** NCR return arrears history, website AI chat for Fair Score, demo re-bake, DebiCheck (DebiCheck likely ends at a gate — §11).

Defaults I chose for the rest (build them unless code evidence shows they're wrong — then record why in the PR):
- RBAC: INSURANCE_OFFICER gets no loan-money writes (payments, amend amount, cancel application, affordability edits). Move those routes from the linear `hasMinRole` ladder to explicit permission entries in `lib/registry/permissions/`. Do not widen any other role.
- CREDIT_OFFICER does not gain NCA-check confirmation; the UI hides/disables controls a role can't use, with "Needs a Branch Manager or Admin".
- Forbidden staff pages render a "You don't have access" page, never the public site.
- Loan references: new loans get a human reference in the same style as applications (e.g. `LN-XXXXXXXX-XXXX`); existing loans keep theirs (mandates and payments quote them).
- Decline: separate "internal note" (staff-only) from "reason shown to the client" (chosen from category text, editable). Bureau-based categories show the bureau's name and contact to the consumer.
- Portal notifications show the borrower "Sent" / "Not delivered — we'll contact you another way", never internal reconciliation states.
- Password policy for portal (and staff, if weaker): ≥ 10 chars and not in a common-passwords list; existing passwords keep working until next change.
- PO Funding: requires a business purpose and PO facts (PO number, buyer name, PO document upload); consumer purpose categories hidden for that product.
- Section 129 on demo stacks: a DEMO_MODE email transport that records "simulated (not sent)" exactly like the reminder simulator, only for `.invalid` recipients. Real lenders still need real email.

---

## 3. Workstream A — Signing, disbursement, segregation of duties (BLOCKER 1)

- **A1 Countersign after mandate.** New hand-written migration replacing the immutability trigger (baseline ~line 6560–6625, message "Signed debit-mandate authority is immutable outside an explicit return to review") so `agreementCountersigned*` columns may go NULL→value once while `debitMandateSignedAt` is set; any other change still raises. Update `lib/db-baseline.test-helpers.ts` static tests. Route: `app/api/applications/[id]/agreement/countersign/route.ts` must also map any DB 23514 to a 409 with a readable message (never a bare 500). Portal mandate page `app/(portal)/portal/mandate/[applicationId]/page.tsx` stays as is.
  - RUN_*_IT test: borrower signs agreement → signs mandate → countersign succeeds; a second countersign is refused; tampering with mandate fields still raises. Mutation: revert the migration → test red.
- **A2 Maker-checker setting** (§2a.3): `TenantConfig` boolean (additive migration, default true), Settings → Security policy page toggle, enforced server-side in decide/disburse/branch-signature/countersign/AF payout-approve routes, audited. Seeds for demo stacks set it per `prisma/demo-lender.ts`. IT tests for each pair + toggle off.
- **A3 UI:** Disburse button in the decision rail at "Disbursement readiness"; header badge must never say "NO BLOCKERS" while approval is blocked (derive from the same gate list the rail uses); after Return to review the portal explains why the mandate must be signed again.

## 4. Workstream B — Money correctness & compliance numbers

- **B1 Settlement (s125) [Confirmation Gate before merge — §13].** Root-cause why `lib/loan/settlement.ts` / `staffLoanFigures` gives R33,877.51 for Elize's loan while the COB route (`app/api/loans/[id]/certificate-of-balance/route.ts`) certifies R27,133.91. Make staff page, portal payment page (`app/(portal)/portal/payment/page.tsx`) and COB agree on one figure from one helper, on the s125 basis (unpaid principal + interest, fees and charges accrued to the settlement date; no unearned future interest; no penalty for non-large agreements). Write the derivation into the PR with a worked example. Re-pin any PDF hashes only with a proof. Build and test fully; stop at the gate before `mq add`.
- **B2 Interest-rate cap.** Reject product/application pricing above the NCA cap for its credit type, computed from the repo rate in reference rates (`asset-finance/reference-rates` already stores REPO). Unsecured: repo×2.2+20% p.a.; short-term 5% p.m.; other types per the regulation table you implement — cite the regulation in a code comment. Demo Personal Loan currently 3.0% p.m. = 36% p.a. → bake data must be within the cap. Unit tests at the boundaries.
- **B3 Affordability counts the lender's own loans.** `lib/affordability/ndi.ts` (+ snapshot/approval evidence): add instalments of the client's ACTIVE/DEFAULTED loans with this lender unless already declared; show "In arrears with us: N days, R x" on the new-application page and staff wizard. IT test with Elize-shaped data.
- **B4 Portal qualify caps.** `app/(portal)/portal/apply/PortalApplyClient.tsx` / `lib/qualify.ts`: never offer more than the product max (micro card said R7,700 vs R2,000 max); don't show "You qualify / BEST MATCH" to a client declined in the last N days [agent decides N, default 30] — show the decline-aware message instead; the over-max form error must be visible text, not native validation only.
- **B5 Schedule & reminders.** Future instalments show "Upcoming", not PARTIAL (portal + staff schedule). Reminder templates must never render "R 0.00" (`app/api/cron/payment-reminders/route.ts`, `app/api/cron/reminders/route.ts`); due-day copy without threats. Unit tests with the exact Kabelo/Elize schedules.
- **B6 Credit-life when no product is available.** Portal/staff apply: no disabled "Add the offered cover" radio; the election is recorded as "NOT_OFFERED" and the PASQ prints "Credit life: not offered" with no product rows (`lib/insurance/credit-life-election*.ts`, `lib/pdf/*`). NCA wording change → §13 gate for the PDF text; logic can merge. Remove the "TEST Asset Credit Life" product from any non-test seed.
- **B7 Payments.** Portal "Notify us of a payment" creates an item in Payments "Awaiting reconciliation" (with the POP) and a staff notification, in addition to the loan note (`app/api/portal/payment/manual/route.ts`); staff can allocate or reject it there. Record Payment form resets after success. "Pay with Stitch" hidden when Stitch isn't configured.
- **B8 One source for arrears/PAR/book.** Dashboard, collections page, sidebar badge and NCR return must use one helper; same definitions, same numbers (audit saw 14/12/15 accounts, R149,598 vs R328k, PAR30 84.2/93.1/94.2%, book R1.15m vs R2.62m). Label the definition on each screen.

## 5. Workstream C — Insurance & RBAC (BLOCKER 2)

- **C1 FAIS disclosure render** fails with `Error: Invalid storage path` (`lib/storage.ts`) from `app/(dashboard)/insurance/new/page.tsx` → disclosure step. Reproduce locally with the Fair Score tenant config (logo/brand upload path is the first suspect), fix, add a test that renders the disclosure for a tenant with an uploaded logo.
- **C2 Commission** is premium-based (it showed 20% of the R20,000 sum assured = R4,000).
- **C3 Claims:** approved amount cannot exceed claimed amount or sum assured (server-side, `app/api/insurance/claims/[id]/route.ts`); the amount field must not append to a pre-filled value (select-all on focus or empty + placeholder); actions read "Record insurer decision" for intermediary lenders; "New Claim" opens a real claim form.
- **C4 RBAC** per §2a defaults: explicit permissions for payment capture, application amend/cancel, affordability edits; INSURANCE_OFFICER refused (403) with IT/route tests per endpoint; nav hides what the role can't open; forbidden page instead of public site; CO sees disabled NCA controls with the reason.
- **C5** Insurer name on catalogue products comes from tenant product config; the bake must not name real insurers unless Hein supplies a partner.

## 6. Workstream D — Borrower portal UX

All in `app/(portal)/portal/**` unless noted. Each item gets a component/unit test and appears in the browser acceptance.
- Human loan references for new loans (§2a); show the payment reference prominently with a copy button.
- Notifications borrower-facing statuses (§2a).
- Documents page: no "selfie REQUIRED" row when identity is verified in person; system-generated documents never show the OCR "couldn't read" message (`app/(portal)/portal/documents/PortalDocumentsClient.tsx`).
- Settled loan's application shows "Settled"; method labels "EFT"/"Debit order" everywhere.
- Arrears banner shows the overdue amount and the correct days.
- Decline view: client-facing reason, bureau name/contact for bureau declines, next steps, timeline in true order.
- Selfie with no camera: readable error and a "Continue on your phone" link/QR (re-use the staff selfie-link mechanism).
- Apply: no layout jumps (reserve space for the credit-life box; never clear declarations on amount change unless the quote changed — then say so); term entered in months for monthly products.
- Password policy (§2a). Portal page titles "Client portal — Fair Score"; tenant logo in the portal sidebar and website header.
- Thembeka-style returning client with stale statement: if a NO_STATEMENT check will block approval, the portal asks for a statement instead of saying "All required documents are complete".

## 7. Workstream E — Asset finance & leasing

- **E1 Lease deal page** (`app/(dashboard)/asset-finance/deals/[id]/page.tsx`, `app/(dashboard)/asset-finance/deals/[id]/DealSummaryPanels.tsx`): for OPERATING_LEASE / FULL_MAINTENANCE_LEASE render the rental schedule (rental ex VAT, maintenance, VAT, total; residual NOT paid by lessee) — the same figures as the creation preview and the agreement PDF. Show contract type; lease terms "Lessee", "Residual", no "balloon"/"Financed amount"/"Total interest". Test: page figures == PDF figures for both lease types.
- **E2** Finance lease shows as finance lease (not "Instalment Sale"); list subtitle covers leases.
- **E3 NCA-regulated deal booked:** deal AF-MNFLX7W7 is "REGULATED BY THE NCA" yet booked although only non-NCA deals may be financed. Find whether the seed bypassed the gate or the gate has a hole; fix the hole with an IT test; fix the seed.
- **E4** Deal product dropdown lists only products matching its caption rule; months field not pre-filled with an appended value; usage unit defaults by asset class (km for vehicles, hours for machinery); unfinanced asset shows "Available", not "On book".
- **E5** Internal default cross-check: when a director/trustee/surety of the entity has a loan in arrears or default with this lender, show it on the credit memo and require an override reason to approve.
- **E6** Trustee bureau check "SKIPPED – CONSENT_MISSING" cannot coexist with an approval reason claiming the check ran — block approval or force the reason to state it.

## 8. Workstream F — Staff UX & consistency

- Section 129 failure reason visible in the queue and on the account (not just "Failed"); DEMO_MODE simulated transport (§2a) so the demo can show S129.
- Money formatting one style app-wide (`R 30,000.00` style, the house format — check `lib` formatter and use it everywhere).
- Credit-check clear: one minimum (counter and placeholder agree). Stale validation errors clear when the field becomes valid. Update Affordability gives a toast. After a successful bureau check the primary rail action is the next step, not "Retry Bureau Enquiry". "Selfie capture link" panel hidden when identity is verified.
- Staff client wizard bank name = same dropdown as the portal.
- Complaints: statuses include Acknowledged and Resolved from Open; tiles count consistently ("Escalated" vs "Escalated to Ombud").
- New-application copy: PASQ timing text matches the real flow.
- Reckless-lending acknowledgement in the wizard: keep the hard approval gate; change the checkbox to "Submit for a decline/override review" wording [agent decides exact copy within §13 NCA-wording rule if it is consumer-facing].
- Bank reconciliation: add FNB, Standard Bank, Nedbank and Capitec statement CSV parsers **only** from real format specs/samples — §13 gate if no verifiable sample exists.

## 9. Workstream G — NCR return arrears history

New table of daily per-loan arrears snapshots (loanId, date, dpd, arrearsCents, outstandingPrincipalCents, status) written by a nightly cron (registry entry in `lib/registry/cron-jobs/`), tenant-scoped. NCR return (`app/(dashboard)/compliance/ncr-return/page.tsx`, `app/api/compliance/ncr-return/route.ts`) uses the snapshot at quarter end when present, else keeps today's warning. History cannot be reconstructed backwards from current state (helpers read current loan state) — do NOT backfill fake history; start from first run and say so on screen. IT test: two snapshots on different dates → return for the earlier quarter uses the earlier snapshot.

## 10. Workstream H — Website AI chat for Fair Score

`components/support/WebsiteChat.tsx` exists; it's off on Fair Score (`featureMarketing=false`, no chat model env). Enable it for the Fair Score demo config and bake; obey the ndzinga-chatbot rules where they apply (identity isolation, POPIA guardrails, staff handoff). LLM key/provider: re-use whatever the Acme/Tsela demo uses if it has one; if no key exists anywhere on velo-server for this purpose → §13 gate.

## 11. Workstream I — DebiCheck, and J — Demo re-bake

- **I DebiCheck:** research SA DebiCheck (TT1/TT2 mandates via a sponsoring bank/PSP), write `docs/DEBICHECK.md` with the provider options and the data model the mandate flow needs, then STOP at the gate (§13): building it needs a provider sandbox account from Hein. Do not build a fake integration.
- **J Demo re-bake (last, after A–H merge, after 17:00):**
  - `prisma/demo-lender.ts` Fair Score: fictional identity + "Demo lender" label (§2a.2), brand spelled "Fair Score", logo in staff/portal/site, brand colours via TenantConfig (must pass `scripts/palette-contrast.ts`), maker-checker OFF for the demo, DEMO_MODE S129 transport on.
  - Healthier book: PAR30 ≤ ~15%, defaults/write-offs a minority; pipeline ages ≤ 30 days at bake time; no "TEST"/"Synthetic" names in asset finance or insurance; human loan references; varied simulated bureau results; pricing within B2's cap.
  - Kit personas (Lerato, Mxolisi, Thembeka) unused after bake; refresh the kit cheat sheets so the click path matches the fixed product (countersign either order, OTP steps).
  - Build image, bake (watched; `SIM_VLM_RETRY_BACKOFF_MS=60000,120000,240000,480000`), verify, then **stop at the gate** for Hein to approve the live switch. Update `~/Downloads/credaflow-fairscore-logins.txt` after the switch.

---

## 12. Success criteria (every box needs evidence in the final handoff)

Per workstream PR:
- [ ] Each finding in its area has a test that fails on `origin/main` and passes on the branch (state the mutation you reverted). DB-enforced rules (A1, A2, B3, C3, C4, E3, G) have `RUN_*_IT` tests run against a throwaway PG via `scripts/it-db.sh`.
- [ ] `npm run ci:full` green; blind `/review` run and its findings fixed or answered; `/security-review` for A, C, D (auth/password), I.
- [ ] Browser acceptance with claude-in-chrome on a local seeded stack (staff on 127.0.0.1, portal on localhost), screenshots saved.

End to end:
- [ ] Re-run the audit's coverage table (doc section "Coverage") in the browser on the fixed local stack: returning-client loan with the borrower signing the mandate BEFORE countersign → disbursed; new client → KYC → decline; affordability fail blocked; micro and PO funding applications; payment notify → reconciliation queue → allocate; payment plan; S129 (simulated) issued; COB = staff settlement = portal settlement; operating + full-maintenance lease deal pages match their PDFs; policy issued with FAIS disclosure; claim over sum assured refused; Insurance Officer refused on payments; forbidden page shown.
- [ ] Ledger: a table in the final handoff with one row per bullet of `.claude/handoffs/2026-10-16-fairscore-audit-findings.md` → FIXED (PR + test + screenshot) / GATED (§13 item) / WONTFIX (reason, only if §2a allows).
- [ ] Evidence page published as an Artifact (screenshots before/after for the blockers and the ledger), link in the handoff.
- [ ] Fair Score re-bake done and verified on the staging image; live switch awaiting Hein (gate).

## 13. Confirmation gates — STOP and ask Hein

1. **NCA wording / NCA numbers:** merging any change to PASQ, credit agreement, COB, Section 129 or mandate text, or to settlement figures (B1, B6 PDF text). Build, test, render before/after PDFs, then ask.
2. **Live Fair Score switch** after the bake (and any change to `/home/hein/Workspace/CredaFlow-fairscore` env or cron). After hours only.
3. **External accounts/keys:** DebiCheck provider sandbox (I); a chat LLM key if none exists (H); bank statement samples for new CSV parsers (F) if no verifiable spec.
4. **Real outbound messages:** never send real email/WhatsApp; demo transports only to `.invalid` addresses.
5. **Restoring the live Fair Score DB** from the pre-audit dump — not needed if the re-bake replaces it; ask before touching it.
6. Anything touching another session's open PR/worktree: run `git worktree list` and `gh pr list` first; if a workstream file is being edited by another session (< 30 min old commits), sequence after it instead of racing.

No production exists, so no prod-deploy gate applies beyond #2.
