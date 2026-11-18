# /goal — Asset finance: close the 26 code gaps the legal wording exposed (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-17-asset-finance-legal-code-gaps-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open the PRs, queue them with mq, write a handoff and stop.`

## §1 Mission

PR #164 (merged 2026-10-17, `3a0a17e3`) gave every asset-finance document real clause wording that states South African law. Where the system does something different, the gap is listed in `docs/asset-finance/legal-wording/README.md` § "Code changes required before approval", items 1–26. While any item remains, `TenantConfig.assetFinanceLegalWordingApproved` must stay off for every lender (DESIGN.md, sign-off record 2026-10-17), so no lender can sign these documents. **Built** means: the system does what the wording says, enforced where the rule is a legal obligation (DB constraint/trigger or a server-side refusal, with a real-PG integration test), the README list is empty, and the wording that described a gap is updated if the fix chose the "reword" option.

## §2 What already exists — do NOT redo

- The wording: `lib/asset-finance/documents/wording/*.ts`; notes for legal: `docs/asset-finance/legal-wording/{nca,lease,commercial}.md`; sample renders: `scripts/asset-finance/render-legal-wording-*-samples.ts` (deterministic; rerun after any wording or figure change and commit the PDFs).
- The README list (§1) is the spec. Each line names the rule, the clause, the code location and what must change. Read it first; re-verify each code location on current `main` (line numbers drift).
- Sign-off: the calculations and rules as built were signed off 2026-10-17 (DESIGN.md "Sign-off record"). A change made here to a signed-off calculation is required by law, not a re-opening of the sign-off: record each in the sign-off record as "changed 2026-10-xx to comply with <rule>".
- Gates and process: `CLAUDE.md` (ci:full, `RUN_*_IT` suites via `scripts/it-db.sh`, migrations additive and shipped with their code, never edit an applied migration), `lib/collections/.claude.md`, `lib/pdf/.claude.md` (consumer NCA pins), merge only via `mq add <pr>`.

## §2a Product decisions (Hein confirmed 2026-10-17). Build against them; don't re-litigate.

1. **The law decides the behaviour.** Where the README offers "fix the code or reword", fix the code (items 25, 26 included), unless doing so is impossible without data the system cannot have; then reword, and note why.
2. **Item 7 (CPA cancellation charge):** PV of the remaining rentals at the contract rate, less the net realisable or re-let value of the returned goods (the inspection/valuation figure the lease end-of-term flow already records), plus the lessor's actual, documented costs of recovery, refurbishment and re-letting, floored at zero and capped below the undiscounted remaining rentals. No penalty %. Each cost line is recorded by staff with its evidence, audited, and itemised on the quote/invoice. Reword lease 9.10 and termination quote 5.2 to match (costs are a Reg 5(2) factor). Commercial lessees keep the existing formula.
3. **Item 14 (total loss):** a write-off ends the lease; the lessee owes arrears + PV of remaining rentals, no penalty, less insurance proceeds received. Staff record the loss and the insurer's payment; audited.
4. **Item 18 (spouse consent):** record the surety's marital regime (`IN_COMMUNITY`, `OUT_OF_COMMUNITY`, `UNMARRIED`, `UNKNOWN`). Payout is refused while any surety is `IN_COMMUNITY` without an uploaded, staff-verified spouse consent document (wet ink, two witnesses) or `UNKNOWN`. Same DB-enforced payout checklist pattern as slice 1.
5. **Item 17:** suretyships are wet ink only (no AES provider exists). Portal e-sign refuses `SURETYSHIP` server-side.
6. **Item 4 (surplus):** collect the consumer's bank account at the valuation notice; when the final notice issues, pay the surplus in the same action. The two-person release stays, but it happens **before** the final notice can issue (the final notice and the payment instruction issue together). If the account is not verified by then, the final notice still issues on time and says the surplus is held for lack of an account; record that as an exception.
7. **Item 23 (total cost of credit):** research the NCA definition (s1, s101, Reg 31/Form 20) and decide. If the fix changes `lib/compliance/pasq.ts` output for consumer loans, that changes pinned consumer NCA documents → Confirmation Gate §8 (stop and ask before re-pinning consumer pins).

## §3 Work — suggested PRs (independent unless noted)

- **PR A — NCA consumer (items 1–5, 21, 22, 23):** s125 rebate for NCA `INSTALMENT_SALE`/`FINANCE_LEASE` (and the s127 settlement value), surrender withdrawal state (additive enum value + transitions), 10-business-day sale gate on both surrender and recovery paths (DB-enforced: no proceeds/listing/sale row before the date), surplus timing per §2a.6, charge freeze on every surrender with a shortfall, cash price/deposit/credit-life rows on the NCA agreement, the schedule capital/fee split (check every consumer of the PASQ billing schedule), total cost of credit per §2a.7.
- **PR B — CPA and commercial leases (items 6–14, 25):** unilateral CPA cancellation effective 20 business days after notice (no quote acceptance needed; the quote only states the charge), the §2a.2 charge and its basis text, automatic month-to-month continuation at expiry for CPA lessees (including leases in default), 20-business-day lessee termination of a continued lease, damages after lessor cancellation (CPA: arrears + 9.10 charge; commercial: PV at contract rate), commercial termination date = acceptance date, total loss per §2a.3, VAT at the supply-date rate (s67).
- **PR C — commercial instalment sale and suretyship (items 15–20):** Settlement Amount = arrears + outstanding capital + accrued interest; after cancellation, less net proceeds; common-law in duplum on NON_NCA default interest; suretyship wet-ink only; marital regime + spouse consent gate (§2a.4); surety physical address in the data and printed; CPA scope classification for instalment sales plus a CPA variant of the ISA wording with s49 notices.
- **PR D — rate and notices (items 24, 26):** written notice of a rate/instalment change to the borrower/lessee through the existing send pipeline (`lib/messaging/.claude.md`; email/WhatsApp only, SMS is off), and rate changes applied from the reference rate's effective date (check what the SARB feed in #135 exposes).

Each PR removes its items from the README list in the same PR, updates the drafter notes where a "point for legal" is now resolved, and re-renders the samples.

## §4 Process

- Collision check first: `git worktree list`, `gh pr list --search asset-finance`; one worktree per PR, off `origin/main`; `npm ci --legacy-peer-deps` in each.
- TDD: each legal rule gets a failing test first; DB-enforced rules get a `RUN_*_IT` integration test; mutation-verify every guard.
- Every PR: `npm run ci:full` green; blind review team of fresh agents given only the diff + CLAUDE.md (code, security, tests, and a South African credit/consumer-law reviewer); an edge-case tester in its own clone whose repros are committed as tests; every fix commit re-reviewed to SHIP; queue with `mq add <pr>`.
- Delete worktrees and merged branches when each PR lands (Hein: worktree sprawl costs CPU).

## §5 Browser acceptance

Against a seeded local stack (TOTP staff per CLAUDE.md), screenshots in `docs/asset-finance/evidence/legal-code-gaps/` with a README:
- an NCA surrender: valuation notice → sale refused inside 10 business days → withdrawal path → sale after the window → final notice with surplus paid;
- a CPA lease: cancellation notice → lease ends 20 business days later without accepting a quote, charge credits the goods value; expiry with no election → month-to-month rentals bill;
- an instalment sale: payout refused for an in-community surety without spouse consent; suretyship e-sign refused;
- an early-settlement quote on an NCA instalment sale showing the s125 rebate.
Synthetic data only.

## §6 Docs

DESIGN.md sign-off record (dated "changed to comply" lines), the module `.claude.md` files you touch, `docs/asset-finance/legal-wording/*.md`, and the README list (empty when done).

## §7 Success criteria (all with evidence)

1. Every one of items 1–26 is closed in code (or reworded under §2a.1 with the reason), each with a test that fails when the fix is reverted; legal obligations are enforced server-side or in the DB with integration tests.
2. `docs/asset-finance/legal-wording/README.md` "Code changes required before approval" is empty.
3. Sample PDFs re-rendered; pinned hashes moved only with a text-run proof.
4. §5 browser run with screenshots.
5. Every PR: ci:full green, review team and tester SHIP, repros committed, merged via mq.
6. Handoff written; memory `project_credaflow_asset_finance.md` updated.

## §8 Confirmation gates — STOP and ask Hein

- Re-pinning any **consumer** NCA document hash (`lib/pdf/*`, `scripts/nca-pdf-fingerprint.ts`) or changing `lib/compliance/pasq.ts` output for consumer loans.
- Setting `assetFinanceLegalWordingApproved` for any tenant, or any change to a demo/Fairscore stack or production.
- A destructive or non-additive migration.
- Sending any real message to a person.
- Spending money.
