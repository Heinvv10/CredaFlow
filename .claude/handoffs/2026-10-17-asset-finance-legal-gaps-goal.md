# /goal — Asset finance: close the 26 code gaps that block legal approval of the wording (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-17-asset-finance-legal-gaps-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§7) or a genuine external blocker. Loop until every Success Criterion (§6) is proven with evidence, then open the PRs, queue them with mq, write a handoff and stop.`

## §1 Mission

PR #164 drafted all asset-finance clause wording so that it states the law (NCA, CPA, Conventional Penalties Act, GLAA, MPA, VAT Act). Where the system does something different, the gap is listed in `docs/asset-finance/legal-wording/README.md` → "Code changes required before approval", items 1–26. DESIGN.md (sign-off record) says `TenantConfig.assetFinanceLegalWordingApproved` must stay off for every lender until that list is empty. **Build every item so the system does what the wording says, then empty the list.** "Built" means:
- real DB rows and enforcement where a rule is statutory (a trigger or CHECK where the repo's pattern uses one);
- real API routes and RBAC;
- UI where staff or the borrower must act;
- tests that fail when the rule is broken (mutation-verified), including `RUN_*_IT` integration tests for DB-enforced rules;
- the README line removed only when its test is green.

## §2 What already exists — do NOT redo

- PR #164 (`feat/af-legal-wording`, queued 2026-10-17). If it isn't merged when you start, wait for it (`mq` status / `gh pr view 164`); everything here builds on it.
- The gap list itself, with file:line pointers, is in that README. Read it first. Per-group detail and points for legal are in `docs/asset-finance/legal-wording/{commercial,lease,nca}.md`.
- Wording modules: `lib/asset-finance/documents/wording/*.ts`. Sample renders: `scripts/asset-finance/render-legal-wording-{nca,deal}-samples.ts` (run `npm run gen:registries` first).
- The calculations and rules were signed off by legal and tax on 2026-10-17 (DESIGN.md sign-off record). The 26 items are where the code departs from the law or the wording. Fixing them is in scope; changing anything else that was signed off is not.
- The pinned NCA hashes (`surrender-pdf-costs.test.ts`, `lib/pdf/*`) re-pin only with a committed text-run diff, as in `docs/asset-finance/evidence/legal-wording/nca/s127-text-runs/`.

## §2a Decisions (made; don't re-litigate)

1. **The wording is the spec.** Where an item says "or reword the clause", build the behaviour the wording describes. The exceptions are items 23 and 26 (below).
2. **Item 22 first.** The NCA `principalDue` over-count (`schedule-records.ts:111`) may already affect booked NCA loans via `booking.ts:144` and every PASQ consumer. Prove or disprove it with a test on a booked NCA deal before anything else, then fix it. No live users or live data exist, so no backfill is needed. State that in the PR.
3. **Item 23 (total cost of credit) is a legal question.** Research the NCA Regulations (Reg 31, Form 20.1/20.2) and write up what they require, citing sources, in `nca.md`. Do NOT change `calculatePasqTotalCostOfCreditCents` (shared with the consumer-loan PASQ) unless the regulation text is unambiguous. If it is ambiguous, leave the item open and say so in the handoff.
4. **Item 26:** rate changes apply from the date the reference rate takes effect (SARB announcement / publication effective date). If a feed only gives the observed date, store an `effectiveFrom` that staff can correct, with an audit row. Don't reword the clauses.
5. **Item 25:** invoice each rental at the VAT rate in force on its supply date (VAT Act s67). Remove the `vat_rate_changed` refusal for that case.
6. **Item 14 (total loss):** add a write-off route for a lease, staff-initiated and audited. The figure is the arrears plus the PV of the remaining rentals, no penalty, less insurance proceeds recorded against it.
7. **Item 18 (spouse consent):** record marital status and matrimonial regime on the surety. In community of property, payout is blocked until the spouse's written consent, with two witnesses, is uploaded and verified. This is part of the existing DB-enforced payout checklist.
8. **Item 17:** portal e-sign is refused for `SURETYSHIP`. Wet ink (upload + staff verification) is the only route; no AES provider is integrated.
9. **Item 4 (s127 surplus):** collect the bank account at the valuation stage. Verify it with the repo's existing bank-verification path if there is one. When the final notice is issued, create the refund ready for release. Keep the existing two-person release, but give it a hard deadline of the final-notice date and alert at deadline − 2 business days. Document in `nca.md` that two-person release is a control on top of the statutory timing, not a delay to it.
10. **Business days** use the existing helper `addSouthAfricanBusinessDays` (`lib/compliance/sa-business-days.ts`). Don't write a new one.

## §3 Work

Group the items into PRs that don't fight over files `[agent decides the exact split]`. Suggested split:
- **PR A — NCA money:** items 22, 1, 15, 16, 21, 23 (research only unless unambiguous), 24 for NCA.
- **PR B — s127/s131:** items 2, 3, 4, 5.
- **PR C — CPA lease:** items 6, 7, 8, 9, 10, 11, 12, 13, 14, 24 lease, 25, 26.
- **PR D — commercial/surety:** items 17, 18, 19, 20, 24 ISA.

For every item:
- Write a failing test first: a unit test for the calculation, plus an integration test where the rule is DB-enforced or crosses a transaction.
- Implement it, mutation-verify it, re-render the affected samples with the scripts, and remove the README line in the same commit.
- If the wording needs to change to match a design choice in §2a, change it and say so in the PR body. NCA-text changes need the text-run proof.
- Add audit rows (`lib/audit.ts`) for every new state-changing action.

## §4 Process

- Collision check first: `git worktree list`, `gh pr list --search asset-finance`. Each PR gets its own worktree; run `npm ci --legacy-peer-deps` in each.
- Before changing any enforcement, enumerate the live triggers and CHECKs (CLAUDE.md, "The Database Enforces the Rules").
- Every PR needs:
  - `npm run ci:full` green;
  - blind reviewers (code + adversarial; plus an SA legal reviewer for B, C, D) given only the diff and CLAUDE.md;
  - an edge-case tester in its own clone whose repros are committed;
  - every fix commit re-reviewed to SHIP;
  - then `mq add <pr>`.
- Integration tests use `scripts/it-db.sh up/check/down` with unique names and `docker rm -fv` teardown.

## §5 Browser acceptance

Use Chrome devtools on a local seeded stack with screenshots in `docs/asset-finance/evidence/legal-gaps/`, synthetic data only:
- an NCA instalment sale settlement quote showing the s125 rebate;
- a surrender withdrawn inside 10 business days, and a sale refused inside the window;
- a CPA lease cancelled by notice with no quote accepted, ending on day 20;
- a CPA lease rolling month to month at expiry;
- suretyship e-sign refused;
- payout blocked without spouse consent.

## §6 Success criteria

1. README "Code changes required before approval" is empty, except item 23 if the regulation is ambiguous (written up with sources).
2. Every item has a test that fails when its rule is broken (mutation table per PR).
3. Item 22: proven impact (or proven no impact) on booked NCA loans and PASQ consumers, and the fix is in.
4. Samples re-rendered from the scripts; any re-pinned hash has a text-run diff.
5. Every PR: `ci:full` green, reviewers and tester SHIP, queued with `mq`.
6. Handoff written; memory `project_credaflow_asset_finance.md` updated.

## §7 Confirmation gates — STOP and ask Hein

- Any production or demo deploy, or a demo/Fairscore rebake.
- Setting `assetFinanceLegalWordingApproved` for any lender. Never do it: legal approves the wording, Hein sets it.
- Changing `calculatePasqTotalCostOfCreditCents` or anything else shared with the consumer-loan path, unless the regulation is unambiguous (§2a.3).
- A destructive or non-additive migration.
- Changing NCA-mandated text in `lib/pdf/` (out of scope).
- Spending money (e.g. an AES or bank-verification provider).
