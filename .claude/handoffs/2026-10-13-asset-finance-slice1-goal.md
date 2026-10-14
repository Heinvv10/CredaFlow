# /goal — Asset finance slice 1: non-NCA instalment sale for companies and trusts, 13 work items (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-13-asset-finance-slice1-goal.md to completion. Work autonomously through Spec -> Build (TDD) -> Integrate -> Acceptance -> Review -> Fix loops for each item in section 4, in order. Do not stop to ask, except at a Confirmation Gate (section 6) or a genuine external blocker. Loop until every Success Criterion (section 5) is proven with evidence, then open the PRs, write a handoff and stop.`

Read first: `docs/asset-finance/DESIGN.md` (the locked design D1–D9; do not re-litigate it), `CLAUDE.md`, `docs/ARCHITECTURE.md`, `lib/collections/.claude.md`, `lib/pdf/.claude.md`.

---

## 1. Mission

Build slice 1 of the asset-finance module. A company or trust buys a vehicle, tractor, TLB or other yellow machinery on a **non-NCA instalment sale**, end to end. Staff (and authorised directors or trustees in the portal) onboard the entity and its people. The system classifies the NCA regime, captures the asset and supplier, structures the deal (deposit, balloon, seasonal or skip weights, fixed or reference-linked rate), records a credit memo and decision, and issues the VAT tax invoice. Agreement, suretyships and resolution are signed (e-sign or wet-ink), the supplier is paid through a gated payout, and the deal is booked as a `Loan` and serviced: receipts, arrears with default interest, reminders, statement. A deal the classifier rules NCA is **refused** in slice 1, not booked.

"Done" for an item means:
- real DB rows written through real API routes with RBAC and `lib/audit.ts`;
- a test that fails when the code is wrong (mutation-verified), with `RUN_DB_IT` integration tests for anything the DB enforces;
- a blind `/review` returning SHIP on the final commit and CI green on its PR;
- where a screen changed, the screen loaded in a browser against a seeded local DB, with a screenshot.

No mock data on any screen. Nothing is merged; Hein merges.

## 2. What already exists — do NOT redo

- **Design:** `docs/asset-finance/DESIGN.md`, on branch `docs/asset-finance-design` (worktree `/home/hein/Workspace/CredaFlow-asset-finance-design`). If it isn't on `origin/main` yet, base your first branch on that branch.
- **Base:** `origin/main` at `ebb0977` or later. Migrations end at `20261012090000_loan_product_amount_bounds`. The baseline's hand-written section holds every trigger and CHECK; new hand-written SQL goes in a new migration and updates `lib/db-baseline.test-helpers.ts` where it reads them.
- **Ledger to reuse:** `Loan` + `RepaymentSchedule`, receipts in `lib/loan/apply-payment.ts` (`applyManualReceipt`), `lib/loan/receipt-allocation.ts` (`allocateReceipt`, s126 order), `lib/loan/balances.ts`. Statements: `lib/pdf/statement.ts`.
- **Do NOT route asset deals through** `app/api/applications/[id]/disburse/route.ts` or `app/api/applications/[id]/decide/route.ts`. Both are built around consumer PASQ, affordability and credit-life evidence. Asset finance gets its own routes under `app/api/asset-finance/`.
- **Calculator:** `lib/loan-calculator.ts` `calculateLoan` produces equal instalments over a term in days. Leave it unchanged; the new solver is `lib/asset-finance/structure.ts`.
- **Things that today ignore NCA applicability and must learn it** (item 4.2):
  - `lib/collections/section129-eligibility.ts` (`evaluateCollectionsEligibility`), which feeds `lib/collections/{queue,escalation,section129-artifact,section129-reporting}.ts` and `app/api/loans/section129/bulk/route.ts`;
  - `lib/loan/nca-fee-cap.ts`, `lib/loan/default-charges.ts`, `lib/loan/charges-switch.ts`;
  - `lib/bureau-submission/` (consumer bureau files must exclude entity borrowers).
- **Feature flags:** Boolean columns on `TenantConfig`, plus `resolveFeatureFlags` / `getTenantFeatures` in `lib/tenant.ts`. A live gate example is `lib/insurance/require-ims-enabled.ts`.
- **RBAC:** permissions go in **both** `lib/permissions.ts` and `lib/auth-guards.ts` (they have drifted; don't fix unrelated drift, but keep yours identical in both). Roles: `UserRole` in `prisma/schema.prisma`.
- **Audit:** `logAudit` / `logAuditStrict` in `lib/audit.ts`; refusals go through `lib/audit-refusals.ts`.
- **Nav:** `staffNavigation` in `lib/navigation.ts`.
- **AVS:** `runAvsCheck`, `evaluateAvsGate` in `lib/avs.ts`.
- **Documents:** `ClientDocument` plus `lib/document-auth.ts`, which writes `DocumentAccessLog` (POPIA; every entity-document read must be logged the same way).
- **Portal:** `app/(portal)/portal/*`; portal identity is a `Client` (see `lib/portal/loan-overview.ts`).
- **No Playwright in this repo.** Browser acceptance uses the Chrome tools (claude-in-chrome or chrome-devtools MCP) against `npm run dev` on a seeded DB, with screenshots saved under `docs/asset-finance/evidence/slice1/`. Do not add Playwright.
- **Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, `npm run claude-md:check && npm run agents:check` (if docs or `.claude.md` changed), and `bash scripts/run-integration-tests.sh` against a throwaway Postgres 16 (see CLAUDE.md). `scripts/integration-baseline.txt` may only shrink.
- **Guards that must keep holding:** the NCA render pins (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`) — consumer NCA documents must render byte-identical. All existing receipt, charges, s129 and bureau-submission tests.

## 2a. Product decisions (already made — Hein, 2026-10-13)

1. All nine design decisions in `DESIGN.md` (D1–D9) are locked.
2. **Capture channel:** staff dashboard **and** client portal. A `Client` linked to the entity as DIRECTOR, TRUSTEE or AUTHORISED_SIGNATORY can view the entity's applications and contracts, upload documents and sign in the portal. SURETY alone grants no access.
3. **Credit assessment:** a manual credit memo. Staff enter AFS figures (turnover, EBITDA, total assets, total liabilities, existing debt service) and a bank-statement summary (average monthly credits, returned debits). The system computes DSCR and gearing and records APPROVE / DECLINE / REFER with mandatory reasons. Every director and trustee gets the existing consumer bureau check. No commercial bureau API.
4. **Arrears on non-NCA deals:** product-configured default-interest margin over the contract rate on overdue amounts, plus a configurable collection fee. No NCA caps and no s129. Reminders reuse the existing messaging pipeline (SMS stays off by policy).
5. **Signing:** both methods. Per-signer e-sign through the existing flow, **or** wet-ink: staff upload the scan and confirm it, which is audited and attributed. Each authorised signatory signs the agreement; each surety signs their suretyship.
6. A deal the classifier rules NCA is refused with a clear reason (slice 2 builds that path). The refusal is audited.

## 3. Rules for this run

- Branch from `origin/main` (or the design branch, see section 2), one worktree per branch, `npm ci --legacy-peer-deps` in each. Recommended PR split (agent may adjust): **PR A** foundation (4.1–4.3), **PR B** engine (4.4, 4.8), **PR C** origination and servicing (4.5–4.7, 4.9–4.13), stacked.
- Never `git add -A`; stage your paths. Never amend or force-push a branch with an open PR; never commit to `main`.
- Max 300 lines per file, no `console.log` (use the logger), no empty catch blocks, full typing, no `any`.
- **Money:** integer cents everywhere; rates as decimals with explicit day-count; rounding rule written down in `lib/asset-finance/structure.ts` and tested; last instalment absorbs rounding.
- Synthetic data only: obviously fake names, registration numbers and VINs (e.g. `TEST0000000000001`).
- Write the failing test first for the solver, classifier, VAT, payout gate and regime gates. Mutation-verify each (break the code, watch it go red, restore).
- Blind `/review` on every PR; `/review-team` for any PR over 500 lines. Fix and re-review until SHIP.

## 4. Work items — what "real" means for each

### 4.1 Schema foundation
- `BusinessEntity` (tenantId, type COMPANY | CC | TRUST | PARTNERSHIP, legalName, tradingName?, registrationNumber, trust Master's reference?, vatNumber?, turnover + totalAssets in cents with financialYearEnd and evidence document ids, address, timestamps). Unique on (tenantId, type, registrationNumber).
- `EntityRelationship` (entityId, clientId, role DIRECTOR | MEMBER | TRUSTEE | AUTHORISED_SIGNATORY | SURETY | BENEFICIAL_OWNER, trusteeKind NATURAL | JURISTIC for trustees, ownershipPct?, active). The same person can hold several roles.
- `LoanApplication` and `Loan`: add `entityId` (nullable FK). `clientId` becomes nullable, with a **CHECK that exactly one of clientId/entityId is set**. Add to `Loan`:
  - `ncaRegime` NCA | NON_NCA, NOT NULL, existing rows backfilled to NCA;
  - `contractType` LOAN | INSTALMENT_SALE | FINANCE_LEASE | OPERATING_LEASE | FULL_MAINTENANCE_LEASE, existing rows backfilled to LOAN;
  - `balloonAmount`;
  - `assetId`.
- Fix every `tsc` error the nullable `clientId` causes, handling entity borrowers explicitly. Never use a non-null assertion to silence one.
- `TenantConfig.featureAssetFinance` (default false), wired through `resolveFeatureFlags` and a `requireAssetFinanceEnabled` gate.
- Integration tests: the XOR CHECK rejects both-null and both-set; backfill values; the uniqueness rule.

### 4.2 Regime gates on existing code
- `evaluateCollectionsEligibility` returns ineligible for SECTION_129 when `ncaRegime = NON_NCA`. The s129 bulk route, queue and escalation therefore never pick it up.
- The fee cap, default-charges caps and the NCA charge switch apply only to NCA loans. NON_NCA uses the product's default-interest margin and collection fee (decision 2a.4).
- Consumer bureau submission excludes loans with an `entityId`.
- Tests: an NCA consumer loan behaves byte-identically to before (existing tests unchanged and green). A NON_NCA loan in 90+ days of arrears is not s129-eligible and is excluded from bureau files. Mutation-verify the discriminator.

### 4.3 NCA classifier
- Pure function `classifyNcaRegime` in `lib/asset-finance/nca-classifier.ts`, rules per `DESIGN.md` D5. Thresholds go in `lib/asset-finance/nca-thresholds.ts` with a Gazette citation comment. If you can't confirm the citation from a primary source, write `// UNTESTED: citation to confirm with legal` and list it in the handoff.
- Table-driven tests cover every branch: trust with 1, 2 or 3 natural trustees; trust with a juristic trustee; company over and under R1m; under R1m with principal over and under R250k; missing or unverified evidence → NCA.
- The snapshot is stored on the application: regime, rule fired, inputs, evidence document ids, classifiedAt and classifiedBy.
- Override route: audited with a reason. NCA → NON_NCA needs a second, different approver with credit permission, enforced in the route and covered by an integration test.

### 4.4 Structure solver and rates
- `lib/asset-finance/structure.ts` is pure. Inputs: cash price, deposit, trade-in, financed fees, balloon, VAT-deferral periods, period weights, start date, and a rate path. Output: schedule rows (principal, interest, fees, total, opening and closing balance) plus the base instalment. Daily accrual is actual/365 on the reducing balance; the solver finds B by closed form or bisection, to the cent.
- Presets MONTHLY, ANNUAL_SEASONAL(month), BIANNUAL(months), SKIP_N, STEP_UP as weight generators.
- `ReferenceRate` (tenant, basis PRIME | REPO | JIBAR | ZARONIA | LENDER_BASE, effectiveDate, ratePct). `ContractRate` history (loanId, effectiveDate, basis, margin or fixedRate, resultingRate).
- Repricing: one function re-solves the remaining PENDING rows on a reference change, keeping term and balloon. It runs from a `CRON_SECRET`-gated route and is idempotent per (loan, effectiveDate). It is audited and sends the borrower a new-instalment notice.
- Tests:
  - an **independent oracle**: a test-only, brute-force day-by-day simulation that the solver's schedule must match to the cent for every preset, plus a balloon and a skip case;
  - repricing mid-term;
  - a property test that the closing balance equals the balloon.

### 4.5 Entity onboarding (staff + portal)
- Staff pages under `app/(dashboard)/` (new "Asset Finance" nav group, flag-gated): create and edit entity, add related people (existing `Client` or a new one via the existing client creation), upload documents (CIPC/CoR, trust deed, Letters of Authority, resolution, AFS).
- Entity documents need a home. Either extend `ClientDocument` with an `entityId` under the same XOR rule, or add a sibling model. **[agent decides]** Either way, every read goes through `lib/document-auth.ts` and writes `DocumentAccessLog`.
- Portal: authorised parties (decision 2a.2) see an entity switcher, the entity's applications and contracts, document upload and signing. Authorisation is checked server-side on every route; an integration test proves a SURETY-only or unrelated client gets 404.

### 4.6 Asset register, valuations, suppliers
- `FinancedAsset`:
  - class (VEHICLE, TRACTOR, TLB, EXCAVATOR, OTHER_YELLOW, …) [agent decides list];
  - make, model, year, serial/PIN, VIN?, engineNumber?, registrationNumber?, hours?, odometer?;
  - cashPrice ex-VAT, VAT, residual;
  - natisTitleholder?, trackerProvider + trackerId?, insurer + policyNumber + lenderNotedConfirmed.
- `AssetValuation`: dated, source DEALER | AUCTIONEER | ASSESSOR | INTERNAL, valuer name, amount, document.
- **Book-wide duplicate check:** a partial unique index on (tenantId, serial) and (tenantId, VIN) over assets on non-closed deals, with an integration test.
- `Supplier` + `SupplierBankAccount`. A bank-account change creates a pending record that a second, different user must approve before it can be paid. AVS runs on approval.

### 4.7 Deal application, credit memo, decision
- An asset-finance application for an entity: asset, supplier, structure (4.4 preview live in the UI), rate basis, product, sureties.
- `EntityFinancials` + credit memo (decision 2a.3). Directors and trustees get the existing consumer bureau check, triggered from the deal.
- Decide route: credit permission, reasons mandatory, audited. Classifier runs first; NCA → refused (2a.6).

### 4.8 VAT module and inception tax invoice
- `lib/vat/`: per-tenant `VatConfig` (vendor number, registered name) and a date-effective `VatRate` table (seed 15% from 2018-04-01).
- `TaxInvoice` / `TaxInvoiceLine` / `CreditNote`: sequential numbering per tenant with no gaps (DB sequence or counter row, integration-tested under concurrency). They carry the content SA tax invoices require [agent verifies the list from SARS guidance and cites it]. A **DB trigger blocks UPDATE/DELETE** on issued invoices, with an integration test.
- At booking an instalment sale issues one tax invoice: cash price ex-VAT plus VAT. Interest is never a VAT line. A PDF renders with `pdf-lib`.
- Mark VAT supply timing `// UNTESTED: tax memo pending` (Confirmation Gate 6.3 covers shipping, not building).

### 4.9 Documents and signing
- Instalment sale agreement, suretyship, and a resolution template rendered from `pdf-lib`. Legal text is **placeholder** with a diagonal `DRAFT — NOT FOR EXECUTION` watermark, controlled by a tenant flag that stays off until legal approves (Confirmation Gate 6.2). The schedule, parties, asset and pricing are real data.
- Signing: per-signer e-sign through the existing flow, or wet-ink upload plus staff confirmation (2a.5). The contract can't proceed until every required signer, determined from authorised signatories and sureties, is satisfied. Integration test.

### 4.10 Payout gate and booking
- `PayoutChecklistItem` per deal, with required items per product per DESIGN D8. Each records confirmedBy, confirmedAt and evidence document; confirming is audited.
- `Payout` to a verified supplier account only. Creation is **refused by the DB** (trigger or constraint) unless every required item is confirmed; integration test. Above `TenantConfig.assetPayoutDualApprovalCents`, a second, different approver is needed.
- Booking happens in one transaction: create the `Loan` (entityId, ncaRegime NON_NCA, contractType INSTALMENT_SALE, balloon, assetId), the `RepaymentSchedule` rows from the solver, the `ContractRate` row and the tax invoice. Mirror the race-safety patterns of the existing disburse route (pinned status updates), not its consumer gates.

### 4.11 Servicing
- Receipts through the existing `applyManualReceipt` work for entity loans.
- Arrears accrue product default interest plus a collection fee (4.2).
- Reminders go through the messaging pipeline to the entity's authorised contacts.
- Statement PDF shows the entity as borrower.
- Settlement quote includes the balloon.
- Integration test: book → miss an instalment → receipt → balances correct.

### 4.12 Portal views
- The entity contract page shows the schedule, balance, next payment, statement download, tax invoice download and documents.
- Load it in the browser as an authorised director and as a SURETY-only client (denied); screenshots of both.

### 4.13 Seed and acceptance fixture
- Extend `prisma/seed.ts` (synthetic only), behind the flag on the demo tenant: one trust (2 natural trustees → classifier NCA → refused) and one company (Pty) Ltd with an excavator on ANNUAL_SEASONAL + 20% balloon, prime-linked, booked and part-paid.
- `lib/asset-finance/__fixtures__/acceptance-deals.ts`: a slot for the client's anonymised deals. The test asserts each to the cent and is **skipped with a clear message while the slot is empty** — not faked. Fill it with 3 hand-verified synthetic deals whose figures you derive independently (spreadsheet-style working in comments).

## 5. Success criteria (all with evidence)

- [ ] 4.1 XOR CHECK, backfill and uniqueness proven by `RUN_DB_IT` tests; `tsc` clean with no non-null assertions added.
- [ ] 4.2 Existing NCA tests unchanged and green; NON_NCA exclusions from s129, caps and bureau are mutation-verified.
- [ ] 4.3 Every classifier branch is tabled; dual-approval override is integration-tested.
- [ ] 4.4 Solver matches the brute-force oracle to the cent on all presets plus balloon and skip; repricing is idempotent.
- [ ] 4.5 / 4.12 Portal authorisation is integration-tested; screenshots of staff entity pages and portal (allowed and denied).
- [ ] 4.6 Duplicate serial/VIN rejected by the DB; supplier bank change needs a second approver (tested).
- [ ] 4.7 NCA-classified deal refused and audited; approve and decline need reasons.
- [ ] 4.8 Invoice immutability trigger and gap-free numbering under concurrency, integration-tested; invoice PDF screenshot.
- [ ] 4.9 Every required signer is enforced; DRAFT watermark visible in the rendered PDF (screenshot).
- [ ] 4.10 Payout refused by the DB with any checklist item open; dual approval above threshold; booking is atomic.
- [ ] 4.11 Book → arrears → receipt → balances integration test.
- [ ] 4.13 Seed runs via `npx prisma migrate reset`; end-to-end browser walk-through of the company deal with screenshots in `docs/asset-finance/evidence/slice1/`.
- [ ] NCA render pins unchanged. All gates in section 2 green. Blind review SHIP on every PR; CI green.
- [ ] Handoff written to `.claude/handoffs/` listing every `// UNTESTED:` marker and open item.

## 6. Confirmation gates — STOP and ask Hein

1. Applying any migration to a database that is not a throwaway local or docker Postgres.
2. Turning the agreement DRAFT watermark off, or writing anything presented as final legal wording.
3. Shipping VAT supply-timing logic as final (tax memo pending). Building it is fine.
4. Any new third-party integration, credential or paid service (commercial bureau, eNaTIS, tracker APIs, IsaFlow).
5. Merging, deploying, or pushing to `main`.
6. Any change to consumer NCA document output or the NCA render pins.
