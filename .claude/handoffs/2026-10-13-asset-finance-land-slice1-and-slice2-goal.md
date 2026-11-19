# /goal — Asset finance: land slice 1, then build slice 2 (finance lease + the NCA path), 2 parts / 14 work items (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-13-asset-finance-land-slice1-and-slice2-goal.md to completion. Work autonomously through Spec -> Build (TDD) -> Integrate -> Acceptance -> Review -> Fix loops for Part A, then each item in Part B, in order. Do not stop to ask, except at a Confirmation Gate (section 6) or a genuine external blocker. Loop until every Success Criterion (section 5) is proven with evidence, then open the PRs, write a handoff and stop.`

Read first: `.claude/handoffs/2026-10-13-asset-finance-slice1-done.md` (state of slice 1,
open decisions, follow-ups), `docs/asset-finance/DESIGN.md` (locked D1–D9),
`CLAUDE.md`, `docs/ARCHITECTURE.md`, `lib/collections/.claude.md`, `lib/pdf/.claude.md`,
`lib/messaging/.claude.md`, `lib/bureau-submission/.claude.md`.

---

## 1. Mission

**Part A — land slice 1.** Make the three stacked PRs #48 → #50 → #59 mergeable against the current `main`, with CI green and a fresh blind review. Then close the slice-1 follow-ups listed in the done-handoff that need no product decision. Stop Part A with the PRs ready; Hein merges.

**Part B — slice 2.** Build the finance-lease product and the **NCA path** for asset finance, end to end, on top of slice 1.
- **Who it serves:** sole proprietors borrow as a `Client`, small trusts and small juristic deals as an entity classified NCA.
- **What it covers:** NCA rate and fee caps; the pre-agreement quote and the NCA instalment-sale / finance-lease agreement as a new asset-finance document set; NCA affordability on business income; credit life offered through the existing election flow; s129 for asset loans; and s127 voluntary surrender (record and notices).
- **What changes:** an NCA-classified deal is no longer refused. It is originated under NCA rules and booked as an NCA `Loan`.

"Done" for an item means:
- real DB rows written through real API routes with RBAC and `lib/audit.ts`;
- a test that fails when the code is wrong, mutation-verified, plus `RUN_*_IT` integration tests for anything the DB enforces;
- a blind review returning SHIP on the final commit, with CI green on its PR;
- where a screen changed, the screen loaded in a browser against a seeded local DB, with a screenshot in `docs/asset-finance/evidence/slice2/`.

No mock data on any screen. Nothing is merged; Hein merges.

## 2. What already exists — do NOT redo

- **Slice 1 (unmerged):**
  - #48 `feat/asset-finance-foundation` (worktree `../CredaFlow-af-a`)
  - #50 `feat/asset-finance-engine` (`../CredaFlow-af-b`)
  - #59 `feat/asset-finance-origination` (`../CredaFlow-af-c`)
- **Slice 1 contents:** entities and relationships; the NCA classifier with a four-eyes `NcaRegimeOverride` (bound to its snapshot, single-use); regime gates (s129, fee cap, bureau and NCR exclude NON_NCA); the structure solver and oracle; reference rates and repricing (four-eyes rates, notice window); VAT and tax invoices; assets, suppliers and deals; the credit memo; signing (e-sign and wet-ink); the payout checklist and payout; booking; servicing; the portal; the seed and acceptance fixtures.
- **Review history:** the DB rules were hardened over many breaker rounds. Read the migrations' hand-written sections before adding SQL.
- **NCA scaffolding:**
  - `Loan.ncaRegime` / `contractType` (`FINANCE_LEASE` already exists in the enum).
  - Deals refused at submit when NCA: `lib/asset-finance/deal-submit.ts` `ncaRefusalReason`. Part B replaces the refusal with the NCA path.
  - The `LoanApplication` triggers exempt only NON_NCA rows, so an NCA entity application still meets the consumer PASQ, credit-life and countersign triggers. Part B makes the asset NCA path satisfy them or extends them deliberately, with tests.
- **Consumer NCA machinery to reuse, not change:**
  - `lib/loan/nca-fee-cap.ts` (initiation-fee cap)
  - `lib/insurance/credit-life-election*.ts`, `credit-life-billing.ts`, `credit-life-containment.ts` and their DB triggers
  - `lib/affordability/` (`ndi.ts`, `current-approval.ts`)
  - `lib/compliance/pasq*.ts`
  - `lib/collections/section129-*.ts`
  - Consumer NCA documents in `lib/pdf/*.ts` must render **byte-identical** (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`).
- **No interest-rate cap module exists** (only the initiation-fee cap). Part B adds one.
- **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, `npm run claude-md:check && npm run agents:check` (if docs or `.claude.md` changed), and `bash scripts/run-integration-tests.sh` on a throwaway Postgres 16. `scripts/integration-baseline.txt` may only shrink.
- **Browser:** no Playwright in the repo. Use the chrome-devtools MCP, or puppeteer-core from a scratch dir under `/tmp` (never a repo dependency).

## 2a. Product decisions (already made — Hein, 2026-10-13)

1. **NCA documents:** a NEW asset-finance NCA document set under `lib/asset-finance/documents/`.
   - Pre-agreement statement and quotation for the asset deal.
   - NCA instalment-sale agreement.
   - NCA finance-lease agreement.
   - Real data and the NCA-mandated disclosure figures.
   - Placeholder legal text with the DRAFT watermark until legal signs off.
   - Consumer `lib/pdf` documents are not touched.
2. **Affordability:** business-income NDI.
   - For an entity: from the credit memo (bank-statement average credits, AFS, existing debt service) less the proposed instalment.
   - For a sole proprietor: the same, plus their personal bureau and the existing consumer NDI rules.
   - Recorded as the s81 assessment, with mandatory reckless-lending notes.
3. **Credit life is OFFERED** on NCA asset deals through the existing credit-life election and bundled-policy flow (`lib/insurance/credit-life-*`), meeting its DB triggers.
4. **s127 voluntary surrender: record and notices.**
   - In scope: record the surrender (borrower or staff), the valuation within the statutory window, the s127 notices, crediting the sale proceeds, and computing the shortfall or refund.
   - Out of scope (slice 4): physical repossession and the remarketing sale workflow.
5. **Defaults the agent applies** (Hein may override later; flag each in the handoff):
   - **Finance lease:** same engine as instalment sale (`contractType FINANCE_LEASE`; residual = balloon). VAT on the full cash price at inception, `// UNTESTED: tax memo pending`.
   - **NCA caps:** max interest for instalment agreements and finance leases per Reg 42 ("other credit agreements"), service fee, and initiation fee.
     - Values go in `lib/asset-finance/nca-caps.ts`, each with its Gazette citation marked `// UNTESTED: citation to confirm with legal`.
     - Enforced at structuring, at booking, and again on every repricing (D4: a reprice above the cap is refused or capped; choose refused, audited).
   - **s129:** NCA asset loans go through the existing s129 pipeline. The addressee is the entity (registered address), or the sole proprietor; reminders go to authorised contacts as in slice 1.
   - **Bureau:** NCA asset loans to a sole proprietor go into consumer bureau files; NCA entity loans stay excluded, `// UNTESTED: legal view on juristic consumers`.

## 3. Rules for this run

- **Part A first.** Merge `origin/main` into #48 with a merge commit (NO force-push; branches have open PRs), then #48 into #50 and #50 into #59. Re-run every gate and get CI green.
- **Part B branch:** `feat/asset-finance-slice2` off #59's head. Stack its PRs on #59. Recommended split (the agent may adjust):
  - **PR D:** caps, documents, affordability, credit life (B1–B5)
  - **PR E:** booking, servicing, s129, s127, portal, seed (B6–B10)
- Never `git add -A`; stage paths. Never amend or force-push a branch with an open PR. Never commit to `main`.
- Max 300 lines per new file; no `console.log`; no empty catch; full typing; no `any`; no non-null assertions.
- Money is integer cents. Rates are decimals with an explicit day-count. Synthetic data only.
- Write the failing test first for caps, affordability, the NCA document figures, the s127 computation and every regime gate. Mutation-verify each.
- Every new hand-written SQL rule gets a `RUN_*_IT` case that goes red with the rule removed.
- Review: `/review-team` (quality, security, TDD, architecture/absence, breaker, browser) on every PR over 500 lines, and `/review` otherwise. Fix and re-review until SHIP. Expect several breaker rounds on the DB rules.

## 4. Work items — what "real" means for each

### Part A — land slice 1
- **A1 Merge main and cascade.**
  - Merge `origin/main` into #48, then #48 into #50 and #50 into #59.
  - Conflicts so far were mechanical: the `TENANT_SCOPED_MODELS` list and its test, `AuditAction` keys, and new main code that reads `application.client` / `loan.client`. Narrow those with `lib/borrower.ts` `hasClientBorrower` / `requireClientBorrower`, as in `lib/credit-checks/load-facts.ts`.
  - Every gate passes on each branch and CI is green.
- **A2 Follow-ups with no product decision:**
  - The bureau-checks route writes its audit row even when a later subject throws, and the deal page shows "busy" results (`app/api/asset-finance/deals/[id]/bureau-checks/route.ts`).
  - NON_NCA default interest follows the loan's `ContractRate` history instead of the current rate across replayed history (`lib/asset-finance/non-nca-charges.ts` PARTIAL).
  - Each with a test.
- **A3 Main follow-up, separate PR off main:** the consumer signing routes (agreement, debit-mandate and documents sign) and `logDocumentContentAccess` record the trusted-proxy IP via `callerIp` / `recordedCallerIp` instead of the client-supplied first `X-Forwarded-For`. Tests.
- **A4:** a fresh blind review of each slice-1 PR's final head returns SHIP. Then stop Part A and report that the PRs are ready to merge.

### Part B — slice 2

**B1 NCA caps.** `lib/asset-finance/nca-caps.ts` covers the max annual interest per agreement type (Reg 42 formula on the repo rate, where it applies), the service-fee cap and the initiation-fee cap. Each value carries its citation and an UNTESTED marker.
- Applied in the structure preview and deal creation (refuse above the cap with a clear message), at booking (DB-checked), and on repricing (refused and audited if the new rate exceeds the cap).
- Table tests and a mutation-verified IT.

**B2 Lift the NCA refusal.** An NCA-classified deal proceeds down the NCA path instead of REFUSED_NCA, for both instalment sale and finance lease.
- A sole proprietor (`Client`) can be the borrower on an asset deal: `AssetFinanceDeal` takes a clientId or an entityId (XOR, DB CHECK).
- The classifier is not run for natural persons; they are always NCA.

**B3 NCA documents.** A new set under `lib/asset-finance/documents/nca/`:
- the pre-agreement statement and quotation, with the cost-of-credit disclosure (all charges, total cost, rate, instalment, schedule);
- the NCA instalment-sale agreement and the finance-lease agreement (real figures);
- placeholder legal text and the DRAFT watermark;
- deterministic output so sha256 binds what was signed.

The quote is acknowledged in the portal, which mirrors the consumer PASQ ceremony via the existing DB fields and triggers, or deliberately extended asset-specific ones; tests either way. Consumer render pins unchanged.

**B4 Affordability (s81).** Business-income NDI per 2a.2, in `lib/asset-finance/affordability.ts` (pure, table-tested).
- A decide route refuses approval without a recorded assessment and reckless-lending note.
- For sole proprietors, the existing consumer NDI is combined in.
- The DB requires the assessment on an NCA asset application before APPROVED (trigger or the existing affordability columns).

**B5 Credit life.** Offer credit life on NCA asset deals through `lib/insurance/credit-life-election*`.
- The election is in the deal flow; the premium goes in the schedule via `credit-life-billing`.
- A bundled policy is created at booking, satisfying the existing `assertDisbursedCreditLifeCoverage` / `credit-life-containment` triggers (no exemption).
- IT: book an NCA asset deal with credit life elected → exactly one valid bundled policy; declined → the no-offer disclosure path.

**B6 NCA booking.** Booking writes an NCA `Loan` with `ncaRegime NCA` and the PASQ / credit-life / countersign evidence the consumer DB rules require, adapted to the asset documents.
- DB-check that the booked rate and fees are within the caps.
- Finance lease books with `contractType FINANCE_LEASE` and the residual as balloon.

**B7 NCA servicing.** NCA asset loans get NCA charges (in duplum, NCA default-charge caps, s126 allocation) via the existing default-charges engine, not `non-nca-charges`.
- The statement shows NCA disclosures.
- Settlement for NCA loans follows the NCA rule for early settlement (s125). Mark `// UNTESTED: legal` if the NCA rule's exact computation can't be confirmed from the code base.
- IT: book → miss → s129-eligible at 90 DPD → receipt → balances.

**B8 s129 for asset loans.** The existing pipeline picks up NCA asset loans.
- The notice is addressed to the entity (registered address) or the sole proprietor; delivery is via the existing channels.
- Every existing s129 test stays unchanged and green. IT for an entity and a sole-proprietor loan.

**B9 s127 voluntary surrender** (per 2a.4):
- `SurrenderRequest` (loan, requestedBy, date, asset condition), valuation (`AssetValuation` within the window), and the s127 notice (asset-finance document, DRAFT watermark).
- Recording the sale proceeds credits the loan through the receipt pipeline. The shortfall or refund is computed and the notice issued. Loan status transitions are DB-guarded.
- No remarketing workflow.
- Tests and IT.

**B10 Portal, seed and evidence.**
- Portal: quote acknowledgement and signing for NCA deals, the credit-life election, the surrender request.
- Seed (synthetic, through the real lib functions):
  - a sole-proprietor TLB deal on the NCA path with credit life, booked;
  - a small-trust finance lease on the NCA path;
  - the refused-trust case becomes an NCA deal.
- Acceptance fixtures: 3 more synthetic NCA deals with independent working (caps, total cost of credit, instalment) asserted to the cent.
- Browser walkthrough screenshots in `docs/asset-finance/evidence/slice2/`.

## 5. Success criteria (all with evidence)

- [ ] A1 #48/#50/#59 merge cleanly into current main, all gates green, CI green; A2–A3 done with tests; A4 blind review SHIP on each final head.
- [ ] B1 caps enforced at preview, creation, booking (DB) and repricing; mutation-verified.
- [ ] B2 NCA deals proceed; the sole-proprietor deal XOR is DB-enforced; natural persons are always NCA.
- [ ] B3 NCA quote and agreements render with real figures and the DRAFT watermark (screenshot); consumer render pins unchanged.
- [ ] B4 no NCA asset approval without a recorded s81 assessment (DB-enforced, IT).
- [ ] B5 credit life elected → exactly one valid bundled policy at booking, with the existing triggers passing unexempted (IT).
- [ ] B6–B8 book → arrears → s129 → receipt → balances for an NCA asset loan (IT); existing s129 and charges tests unchanged.
- [ ] B9 surrender → valuation → notice → proceeds → shortfall (IT).
- [ ] B10 seed runs twice via `npx prisma migrate reset`; acceptance deals to the cent; browser walkthrough screenshots.
- [ ] Every PR: blind review SHIP and CI green.
- [ ] A handoff listing every new `// UNTESTED:` and `// PARTIAL:` marker and every agent default from 2a.5.

## 6. Confirmation gates — STOP and ask Hein

1. Applying any migration to a database that is not a throwaway local or docker Postgres.
2. Turning off any DRAFT watermark, or writing anything presented as final legal wording (asset or consumer).
3. Shipping VAT supply timing, NCA cap values or s127/s125 computations as final; building them is fine.
4. Any new third-party integration, credential or paid service.
5. Merging, deploying, or pushing to `main`; force-pushing any branch.
6. Any change to consumer NCA document output or the NCA render pins.
7. Changing a consumer (clientId) NCA flow's behaviour beyond what an asset deal needs. If a shared trigger must change, the consumer path's tests must stay unchanged and green, and the reason goes in the PR.
