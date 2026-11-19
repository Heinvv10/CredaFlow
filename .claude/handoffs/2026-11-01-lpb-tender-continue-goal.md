# /goal — Lesotho PostBank tender: finish the build, then the bid papers (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-11-01-lpb-tender-continue-goal.md to completion. Work autonomously through Build (TDD) → Review → Fix loops → Merge. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then publish the evidence, write a handoff and stop.`

## 1. Mission

Tender LPB/0009/2026, JV: CredaFlow + Fair Score 51%. **Clarifications close 12 Nov 16:30 CAT. Bids close 25 Nov 12:00 CAT.** Evaluation is pass/fail per Section 6 item; "Comply" needs evidence and a live demo may be demanded. Hein: "You are in control and manage all"; no live clients, so merge and deploy demos freely. Finish A10b so a Lesotho loan runs end to end in a browser, then A3 and A5b, then the demo, the compliance summary and the Fair Score email draft. "Built" means real DB rows, real routes, RBAC, tests, and a browser walk with screenshots. Never mock data.

## 2. What already exists — do NOT redo

Status log (read the tail first): `.claude/handoffs/2026-10-29-lpb-tender-plan.md`. Memory: `project_credaflow_lpb_tender.md`.

**On main:** A1 jurisdiction #253, A2 IFRS 9 #255, A4 rules engine/maker-checker #256, A5 product engine #266, A6 approval matrix #265, A7 SSO #254, A8 audit/SIEM #257, A9 platform #252, A10 key facts documents #267, F1/F2 #259, CI on GitHub-hosted ubuntu-24.04 #263 (velo runners idle as a billing fallback), AF date fixtures #269, audit Message guards #274.

**In flight when this file was written (2026-11-01 ~10:00). First action: check each, and check for other sessions first (`git worktree list`, `gh pr list`, ListAgents). The previous session's teammates may have died with it.**
- **#275** `fix/structured-terms-branch-only`: blind-reviewed; queued with `mq add` when this was written. Another session added c19ba270 to the branch, which fixes the five date-sensitive AF accounting suites (F16). Confirm it merged.
- **#276** chore/deps: not ours, another session's.
- **#277 A10b PR A** `feat/lpb-a10b-ls-end-to-end`, worktree `/home/hein/Workspace/CredaFlow-lpb-a10b`, pushed head 0cc59913. **The round-1 fixes are UNCOMMITTED in that worktree** (21 modified files, 4 untracked, including `prisma/migrations/20261101090000_key_facts_no_credit_life/`). Do not discard them. Inspect, finish §3, commit, push.
- **PR B** local branch `feat/lpb-a10b-payout` (not pushed): includes `lib/non-nca-documents/disburse.ts`.
- Superseded, safe to remove at cleanup after a look: worktree `CredaFlow-audit-msg` (#274 did it), `CredaFlow-af-dates`, `CredaFlow-channel-fail-closed` once #275 merges, `CredaFlow-ci-hosted`.

**Saved artifacts:** `.claude/handoffs/lpb-artifacts/`: `bid.txt` (tender text), `qwatch.sh` (queue-on-green watcher, takes PR numbers), `brk277-attacks.integration.test.ts`, `brk267-round2.integration.test.ts`, `email-fairscore-lpb-draft1.md`. Other evidence sits in the old session scratchpad and may vanish.

**Workflow that worked:** one builder per item in a `CredaFlow-lpb-<id>` worktree. Builder opens a ready PR and stops. For a trust/money PR: quality+TDD (sonnet, with real mutations), policy or ledger breaker (opus, own clone + `it-db.sh`, repros), architecture+absence (opus). Send one consolidated fix list. Fixes get a named breaker round until SHIP. Breakers found real bypasses in every wave-2 PR, so do not skip them. Merge only via `mq add <pr>` from inside the repo.

**Traps already paid for:**
- `AuditLog.createdAt` is DB-stamped: backdate only via `plantAuditRowsForTest`.
- `checkRateLimit` is async: `await` it.
- `instrumentation` `register()` reads InstanceJurisdiction: boot tests mock `@/lib/jurisdiction/load.server`.
- After a merge run `npm run gen:registries` and `npx prisma generate`, or tsc reports false errors.
- Partial integration runs missed cross-PR breaks: run the full 3-shard runner before asking to queue.
- Date-sensitive suites: use `plannedStartFor` (`lib/asset-finance/first-due.test-helpers.ts`). Failures on the 29th–31st or the 1st: run the same suites on clean main before chasing a PR.
- A subagent's report is not evidence: its SHA or claim can be stale. #266's report claimed a fix that was not in the tested commit.
- Teammates go idle with queued messages: re-send explicitly.
- Registries: pick unused numeric prefixes. Never `git add -A`. No force-push.
- A builder hit "weekly limit, resets Nov 4 20:00 SAST". Probe by spawning before believing a limit blocks you. Tell builders to commit and push before any limit.

## 2a. Decisions already made (do not reopen)

- Credit life on KEY_FACTS: off, no configuration path. Weekly/fortnightly: credit life and debit orders refused.
- NCA lenders may configure no repayment structure; ZA schedules stay identical to main. Structured schedules: BRANCH channel only.
- Non-NCA month-end dates clamp (28 Feb). Segments derive from approved pricing rules.
- KEY_FACTS with no screening provider is refused; a simulated provider on a demo stack is acceptable; a real one is a go-live condition.
- KEY_FACTS payout: manual-labelled EFT, non-empty bounded `bankRef`, no real rail. Second-person verification of the payout account (recorded, audited, not the disburser) stands in for AVS, plus the statement match.
- Lesotho debts are self-declared; put this in go-live notes. LS matrix needs `ungraded` set.
- Regrade after a step: requirement rises, earlier steps stand.
- Never invent Lesotho legal wording: SAMPLE marker and a gap.

## 3. A10b PR A (#277): finish round 1

Fix list, in the worktree already in part: E1 engine refers a KEY_FACTS application with no bureau check to staff (cover any other missing fact); T1 regime-independent deceased refusal at decide and in the locked verifier; S1 screening NOT_CONFIGURED refused; D1b DB refuses ACCEPTED cover on KEY_FACTS; M1 correct `.claude.md` (Reg 23A is off on KEY_FACTS); O1 no `recklessLendingAssessed: true` on KEY_FACTS override; draft submit `applications/[id]/route.ts:319` aligned; tests for the locked re-verification in `lib/affordability/current-approval.ts` (NCA_PASQ fails, KEY_FACTS passes; removing the gates for ZA was green, the main ZA regression risk), `prepare-application.ts:164`, `portal/applications/route.ts:156` including the unloaded default, the misnamed IT title, the `keyFactsCreditLifeRefusal` 422 through the route, the page's evidenceRules; go-live notes. Then a breaker round on the fixed head, then queue.

## 4. A10b PR B and C

**PR B `feat/lpb-a10b-payout`:** KEY_FACTS payout booking; statements, certificate of balance and debit mandate with no NCR number. Scan findings to close: reuse `verifySubmissionAffordabilitySnapshot` and `verifyCurrentAffordabilityApproval` via a KEY_FACTS branch skipping only bureau and PASQ, KYC VERIFIED, bounded signed-agreement validity, no payout after the agreement start (or shift the schedule); NCA route's lock protocol (shared client advisory lock, FOR SHARE on KYC and statement docs, re-read on tx, derive the account from the locked read); second-person account verification; required `bankRef`. Prove the frozen approval fingerprint binds at payout. Note what tender 2.5.1 core banking needs.

**PR C `feat/lpb-a10b-letters-demo`:** LS arrears letter from a lender-owned versioned template (SAMPLE; S129 stays ZA-only); offer letter (spec 2.4.3); notification on issue; branch-assisted signing; seed a Lesotho demo lender with an approved KEY_FACTS application; full browser walk. Issue the key facts statement before submission if feasible (2.2.4 scored Partial).

Each: breaker + quality review, full 3-shard IT, browser evidence.

## 5. Then build

- **A3** restructure / top-up / refinance / consolidation / payment holiday with approval and history (2.6.6). Check A5 made `LoanTerms` versioned (append-only sequence) first; item 19 in the A5 addendum.
- **A5b** product types (check-off, SME, group, revolving), maker-checker on product create/edit, balloon, variable/reference-rate repricing (2.1.1–2.1.3, 2.6.1, all Partial).
- **F7** automated affordability attestation for non-NCA so 2.3.9 instant approval can approve. **F3** rand-formatter sweep to `formatMoney(activeCurrency())`.
- **F8** branch-scoped approvers. **F9** committee conditions shown and enforced at signing and payout. **F10** unversioned product payout cap re-check after a repo cut. **F11** committee "latest decision" by insert sequence. **F12** sockpuppet gap: approver must not be created or changed by the maker in the last N days, across every two-person control. **F13** `backdateLease` by the lease's day gap, drop the 5 skips. **F14** `prisma/seed/` month-end dates. **F15** recovery-rules-vat-refund deadlock. PASQ ceremony IT :821 flake. Deferred #257 notes: non-object newValue has no `_clipped`; clip marker forgeable; redaction leaves length visible.
- Tier B if time allows: tokenization (4.2/4.3), report builder (2.8.4), collections analytics (2.7.2, 2.7.10), payroll check-off import (2.6.3), mobile money, AI credit memos (2.9.3), live PEP/sanctions (2.2.2). Tier C stays Partial with a dated roadmap; raise "modular monolith + containers = equivalent?" as a clarification question before 12 Nov.

Priority if time runs short: A10b, demo, compliance summary and email first; then A3, A5b, F12, F7.

## 6. Bid papers

- **Fair Score email draft, do early, before 5 Nov:** a short version to Pramod and Dr Danny listing what only they can supply: ISO 27001 scope, LMS references, PM/Security lead CVs, PCI route, JV paperwork, plus the shortcomings. Start from `lpb-artifacts/email-fairscore-lpb-draft1.md`, save as a file. **Draft only, never send.** A full version follows when the build is done.
- **Clarification question list** for the bank (Lesotho ID format, monolith equivalence, core banking API, others found), ready before 12 Nov.
- **Section 6 compliance summary** lines 1.1–7.3: Comply / Partial / Fail with evidence per line, as a published artifact. Be honest: Partial is Partial. Reuse the architecture reviewers' scoring in the status log.
- **Demo re-bake** after hours with screenshots: needs SSO_SECRET_KEY; never hand-edit live demo env files.

## 7. Success criteria

- [ ] #275 and all A10b PRs merged via mq; ZA NCA fingerprint tests unchanged, no re-pin.
- [ ] Lesotho loan: apply → approve → sign → disburse → repay → arrears letter, real-PG IT through real routes with no `session_replication_role` shortcut, mutation-verified, with a browser walk and screenshots on an evidence page.
- [ ] Seeded demo needs no DB surgery.
- [ ] A3 and A5b merged, each with breaker SHIP, real-PG tests and browser evidence, or an explicit dated Partial in the summary.
- [ ] Every remaining F-item merged or listed with a reason.
- [ ] Email draft, clarification list and compliance summary exist. Worktrees cleaned, handoff and memory updated.

## 8. Confirmation gates (stop and ask Hein)

- Sending any email or external message. Drafts only.
- Production deploy of a real lender. Demo deploys are fine, preferably after hours; CredaFlow demos have standing approval.
- Spending money: GitHub billing changes, QSA, pen test, paid providers.
- NCA wording changes or re-pinning NCA render hashes: needs legal sign-off.
- Changing the ZA repayment date behaviour or anything printed on PASQ or debit orders.
- Weakening the staff TOTP rule, or any real personal data in the repo.

Also: Hein wants brief replies. Lead with the result. Do not relist instructions; act.
