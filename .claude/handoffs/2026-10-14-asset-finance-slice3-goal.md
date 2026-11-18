# /goal — Asset finance slice 3: operating and full-maintenance leases, 12 work items (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-14-asset-finance-slice3-goal.md to completion. Work autonomously through Spec -> Build (TDD) -> Integrate -> Acceptance -> Review -> Fix loops for each work item in section 4, in order. Do not stop to ask, except at a Confirmation Gate (section 6) or a genuine external blocker. Loop until every Success Criterion (section 5) is proven with evidence, then publish the evidence, open the PRs, write a handoff and stop.`

Read first: `docs/asset-finance/DESIGN.md` (locked D1–D9),
`.claude/handoffs/2026-10-14-asset-finance-slice2-servicing.md` (slice-2 state and
legal markers), `CLAUDE.md`, `docs/ARCHITECTURE.md`, `lib/collections/.claude.md`,
`lib/pdf/.claude.md`, `lib/messaging/.claude.md`, `lib/bureau-submission/.claude.md`.

---

## 1. Mission

Build the **operating lease** and the **full-maintenance lease (FML)** end to end, on top of slices 1 and 2.

The lender buys the asset and keeps ownership. The lessee pays a rental each period. On an FML, part of the rental funds a maintenance fund, and staff approve claims against that fund. Each rental gets its own tax invoice. At the end of the term the lessee returns the asset, extends the lease, or buys the asset at market value. An inspection bills excess hours or km and damage. Early termination is supported.

The lessee can be a juristic entity or a sole proprietor (`Client`). The Consumer Protection Act's fixed-term rules apply where the CPA applies.

"Done" for an item means:
- real DB rows written through real API routes, with RBAC and `lib/audit.ts`;
- a test that fails when the code is wrong (mutation-verified), plus `RUN_*_IT` integration tests for anything the DB enforces;
- a blind review returning SHIP on the final commit, with CI green on its PR;
- where a screen changed, the screen loaded in a browser against a seeded local DB, with a screenshot in `docs/asset-finance/evidence/slice3/`.

No mock data on any screen. Nothing is merged; Hein merges.

## 2. What already exists — do NOT redo

- **Slices 1 and 2 are merged on `main`** (#48, #50, #59, #65, #66, plus demo fixes #68–#71). Start from the current `origin/main`.
- **Enum values already exist.** `ContractType.OPERATING_LEASE` and `FULL_MAINTENANCE_LEASE` are in `prisma/schema.prisma` and the foundation migration. Code paths still refuse them:
  - `lib/asset-finance/deal-input.ts` `ASSET_CONTRACT_TYPES`
  - `lib/asset-finance/deal-form-body.ts`
  - `lib/asset-finance/booking-load.ts:91`
  - `lib/asset-finance/payout-checklist.ts:78`
  - `lib/asset-finance/nca-*.ts` (these refusals stay: leases have no NCA documents)
- **Reuse these; don't rebuild them:**
  - **Pricing:** structure solver `lib/asset-finance/structure.ts` with presets in `structure-presets.ts` and the oracle in `lib/asset-finance/__tests__/structure-oracle.ts`.
  - **Rates and repricing:** `rates.ts`, `reprice-loan.ts`, `reprice-batch.ts` and the cron `app/api/cron/asset-finance-reprice/route.ts`.
  - **VAT:** `lib/vat/tax-invoice.ts` (`issueTaxInvoice`, `computeTaxInvoice`) and `lib/vat/credit-note.ts`. `TaxInvoice` is immutable and numbered gap-free per tenant by trigger. `TaxInvoice.loanId` is not unique, so a loan can have many invoices.
  - **Assets and valuations:** `FinancedAsset` (has `residualCents`) and `AssetValuation`.
  - **Suppliers:** `Supplier` and `SupplierBankAccount` (AVS, four-eyes bank changes).
  - **Payout:** `Payout` and `PayoutChecklistItem`.
  - **Signing:** `signing-*.ts` (e-sign and wet-ink).
  - **Booking:** `booking.ts` and `booking-plan.ts`. A deal books to a `Loan` plus `RepaymentSchedule`.
  - **Receipts:** `lib/loan/apply-payment.ts` and `lib/loan/receipt-allocation.ts`.
  - **NON_NCA arrears:** `non-nca-charges.ts`.
  - **Portal:** `app/(portal)/portal/business/...` plus the `portal-*.ts` modules.
  - **Seed:** `prisma/seed/asset-finance*.ts`, checked by `prisma/seed-asset-finance.integration.test.ts`.
  - **Acceptance fixtures:** `lib/asset-finance/__fixtures__/acceptance-deals.ts`.
- **Guards that must keep holding:**
  - Every existing asset-finance, consumer, s129 and charges test passes unchanged.
  - Consumer NCA render pins are unchanged (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`).
  - `scripts/integration-baseline.txt` may only shrink.
- **Gates:**
  - `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
  - `npm run claude-md:check && npm run agents:check` if docs or `.claude.md` changed.
  - `bash scripts/run-integration-tests.sh` on a throwaway Postgres 16. Tear it down with `docker rm -fv`.
- **Browser:** the repo has no Playwright. Use the chrome-devtools MCP, or puppeteer-core from a scratch dir under `/tmp` (never a repo dependency), exactly as slices 1 and 2 did.

## 2a. Product decisions (already made — Hein, 2026-10-14)

1. **Lessees:** juristic entities **and sole proprietors** (`Client`). CPA applicability is decided per deal (C1); where it applies, the CPA s14 fixed-term rules are built.
2. **The maintenance-fund risk model is chosen per deal:**
   - `LENDER_RISK`: the lender keeps a surplus and absorbs a deficit. The fund is only reported.
   - `LESSEE_SETTLED`: at the end of the term the surplus is refunded to the lessee, or the deficit is billed to them.
3. **End of term:** return, extend (month to month), **or purchase**.
   - The purchase price is fair market value from a dated `AssetValuation`. It is never a price fixed in the agreement.
   - Mark the purchase option `// UNTESTED: tax/legal — must not recharacterise as a finance lease`.
4. **Early termination:** the amount is:
   - the present value of the remaining **rental-only** portions (maintenance excluded), discounted at the contract rate;
   - plus arrears;
   - plus a tenant-configurable penalty %.

   The asset comes back. No credit is given for its resale value. Mark it `// UNTESTED: legal`.
5. **Defaults the agent applies.** Flag each in the handoff; Hein may override.
   - **NCA regime:** operating leases and FMLs book `ncaRegime NON_NCA` with classifier rule `LEASE_NOT_CREDIT_AGREEMENT`. Ownership never passes, so the NCA "lease" definition is not met. Mark `// UNTESTED: legal`. No s129, no NCA caps, no NCA documents.
   - **Consumer bureau:** lease contracts are excluded from consumer bureau files, including sole-proprietor leases. Mark `// UNTESTED: legal`.
   - **Rental pricing** uses the existing solver:
     - The financed amount is the cash price less the deposit or advance rental. The residual is the balloon, and the lessee never pays it.
     - `rentalTiming` is ADVANCE or ARREARS.
     - An annual escalation % is expressed as weights.
     - The rate is fixed or reference-linked. Repricing keeps the term and residual unchanged (D4).
   - **Maintenance component:** a monthly ex-VAT amount with its own annual escalation %. Contracted usage is an annual hours or km allowance plus an excess rate (cents per hour or km).
   - **Tax-invoice timing:** one invoice per rental, with time of supply being the earlier of the due date and the date the payment is received. Mark `// UNTESTED: tax memo pending`. Rental and maintenance are standard-rated lines.
   - **No inception tax invoice for leases.** The supplier invoices the lender; the lender does not invoice the lessee for the cash price.
   - **Maintenance claims are recorded, not paid.** CredaFlow approves a claim and records its payment reference. Money moves outside the system, as `Payout` does today.

## 3. Rules for this run

- **Branching:** branch `feat/asset-finance-slice3` off `origin/main`. Recommended stacked split (the agent may adjust):
  - **PR F:** C1–C4 (products and CPA scope, pricing, booking, per-rental invoices).
  - **PR G:** C5–C8 (maintenance fund, usage, end of term, early termination).
  - **PR H:** C9–C12 (documents, portal, collections, seed and evidence).
- Never `git add -A`; stage paths. Never amend or force-push a branch with an open PR. Never commit to `main`. Use a worktree (`../CredaFlow-af-slice3`) and run `npm ci --legacy-peer-deps` in it.
- **Code limits:** max 300 lines per new file; no `console.log`; no empty catch; full typing; no `any`; no non-null assertions.
- **Money and rates:** money is integer cents. Rates are decimals with an explicit day-count. Synthetic data only.
- **Test first:** write the failing test first for rental pricing, invoice timing, the fund balance, excess usage, the early-termination amount, the CPA classifier and every status transition. Mutation-verify each.
- **SQL rules:** every new hand-written SQL rule (trigger, CHECK, partial unique) gets a `RUN_*_IT` case that goes red when the rule is removed. Before adding SQL, read the hand-written sections of the slice 1 and 2 migrations; the DB rules there survived many breaker rounds, so follow their patterns. These include tenant-safe composite FKs, immutable rows and sequencing guards.
- **Review:** use `/review-team` (quality, security, TDD, architecture/absence, breaker, browser) on every PR over 500 lines, and `/review` otherwise. Fix and re-review until SHIP. Slice 2's blind review never ran, so don't skip it here.

## 4. Work items — what "real" means for each

**C1 Lease products and CPA scope.**
- `deal-input`, `deal-form-body` and the new-deal form accept `OPERATING_LEASE` and `FULL_MAINTENANCE_LEASE` for an entity or a `Client` lessee.
- Lease deals skip the NCA classifier and snapshot `NON_NCA` / `LEASE_NOT_CREDIT_AGREEMENT`.
- New pure function `lib/asset-finance/cpa-scope.ts` `classifyCpaScope(input) → { applies, rule, evidence }`:
  - a natural person → applies;
  - a juristic person with turnover or asset value below the CPA threshold → applies;
  - unproven → applies.
- The threshold lives in config with its Gazette citation, marked `// UNTESTED: citation to confirm with legal`.
- The result is snapshotted on the deal and the loan, enforced by a DB CHECK: non-null for lease contract types and null otherwise.
- Table tests; an IT for the CHECK.

**C2 Rental pricing.** A pure `lib/asset-finance/lease-pricing.ts` built on `structure.ts`. Inputs:
- cash price, deposit or advance rental, residual, term;
- ADVANCE or ARREARS timing, escalation %, rate;
- maintenance monthly amount and its escalation (FML only).

It outputs the per-period rental and maintenance ex-VAT, VAT and total. An independent oracle calculation agrees to the cent, including for advance timing (annuity due). The structure preview on the deal page shows the lease schedule. Property tests and mutation-verified.

**C3 Booking and the lease ledger.**
- A lease books a `Loan` (`contractType` OPERATING_LEASE or FULL_MAINTENANCE_LEASE, NON_NCA) plus `RepaymentSchedule` rows whose `totalDue` is the period's rental plus maintenance, VAT included. Receipts, bank sync, arrears, reminders and statements therefore keep working.
- Each period also gets a new `LeaseRental` row with these fields:
  - `loanId`, `scheduleId` (unique), `periodNo`, `dueDate`;
  - `rentalExclVatCents`, `maintenanceExclVatCents`, `vatCents`, `totalCents`;
  - `taxInvoiceId` (unique, nullable until issued).

  Tenant-safe FKs. The amounts are immutable after booking (trigger), except through a reprice.
- `[agent decides]` how the rental maps onto `principalDue` / `interestDue` / `feesDue` and `Loan.principal` / `outstandingPrincipal`. The constraint: the staff loan page, portal contract, statement, arrears and settlement figures are all correct for a lease, proved by tests. HP and consumer figures stay unchanged. Document the mapping in DESIGN.md.
- The payout checklist gets lease items: the eNaTIS **owner** and titleholder are the lender, and the lender's insurance is noted.
- Booking a lease does not issue an inception tax invoice.
- Lease fields on `AssetFinanceDeal`: `rentalTiming`, `escalationRate`, `maintenanceMonthlyExclVatCents`, `maintenanceEscalationRate`, `maintenanceRiskModel`, `usageAllowancePerYear`, `usageUnit` (HOURS | KM), `excessRateCents`, `earlyTerminationPenaltyRate`. CHECKs make the FML-only fields null on an operating lease and required on an FML.

**C4 Per-rental tax invoices.**
- A cron route `app/api/cron/asset-finance-lease-invoices/route.ts`, gated by `CRON_SECRET`, issues one tax invoice per `LeaseRental` once its due date is reached.
- A receipt that arrives earlier issues the invoice at receipt, from the receipt path.
- The invoice has a rental line and, on an FML, a maintenance line. Each goes through `issueTaxInvoice`.
- **Idempotent:** a DB unique on `LeaseRental.taxInvoiceId`, with concurrent runs proven by an IT that races two issuers.
- Staff and the portal can download each invoice (`app/api/portal/asset-finance/loans/[loanId]/tax-invoice/route.ts` today serves only the inception invoice, so extend or add a route).

**C5 Maintenance fund and claims (FML).**
- `MaintenanceFund` (one per FML loan) and `MaintenanceFundMovement` (CONTRIBUTION, CLAIM, SETTLEMENT_REFUND, SETTLEMENT_BILLED). Movements are immutable (trigger), and the balance is derived from them.
- A contribution is written when a rental's invoice is issued, for that rental's maintenance ex-VAT amount.
- `MaintenanceClaim`:
  - fields: the provider (`Supplier` with a verified bank account), the provider's invoice document, the meter reading, the amount, the description;
  - status flow SUBMITTED → APPROVED → PAID (payment reference recorded) or REJECTED;
  - four-eyes approval above a tenant threshold, enforced by the DB;
  - no claims after the lease ends.
- The fund may go negative.
- End-of-term settlement follows `maintenanceRiskModel`:
  - `LENDER_RISK`: the surplus or deficit is reported only;
  - `LESSEE_SETTLED`: a surplus is refunded (credit through the receipt pipeline, or a recorded refund; `[agent decides]`, justified), and a deficit is billed on a tax invoice.
- IT for each model.

**C6 Meter readings and excess usage.**
- `AssetMeterReading` with: asset, reading date, value, unit, source (STAFF | PORTAL), and an optional evidence document.
- Readings must be monotonic per asset (DB-enforced).
- Excess = (final reading − start reading − allowance × term in years) × the excess rate, never below zero. It is billed once at the end of the term on a tax invoice.
- An interim projected-excess figure is shown on the staff loan page.

**C7 End of term.** A `LeaseEndOfTerm` record per loan.
- **Expiry notice:** for CPA lessees, the CPA s14 expiry notice is generated 40–80 business days before expiry. A daily cron queues it through the messaging pipeline (respect `lib/messaging/.claude.md`; SMS is off). Mark `// UNTESTED: legal`.
- **RETURN:**
  - An inspection report records the condition and damage items with assessed amounts. Excess usage (C6), damage and any `LESSEE_SETTLED` deficit are billed on one end-of-term tax invoice.
  - The asset is marked returned to the lender's stock, ready for slice 4 remarketing. Add the asset-status field this needs.
  - The loan closes once the balance is zero.
- **EXTEND:** month to month at the last rental (and the last maintenance amount). New schedule and `LeaseRental` rows are appended one period at a time by the cron. Either party can end it with notice.
- **PURCHASE:**
  - The price must be at least an `AssetValuation` dated within a tenant-set number of days.
  - A sale tax invoice is issued for the asset.
  - Ownership transfer is recorded, and the eNaTIS change is a checklist item.
  - The loan closes.
- Status transitions are DB-guarded: no purchase or extension after a return, and no second outcome.

**C8 Early termination.**
- A quote route computes the 2a.4 amount, valid for a tenant-set number of days.
- **CPA lessees:** the quote also honours CPA s14 cancellation on 20 business days' notice. The penalty is limited to a "reasonable cancellation penalty" (Reg 5); show the basis. Mark `// UNTESTED: legal`.
- **Acceptance:**
  - bills the amount on a tax invoice (`// UNTESTED: tax memo`);
  - starts the RETURN inspection (C7);
  - stops future rentals and invoices;
  - closes the loan when paid.
- Table tests for the amount, and an IT for the full quote → accept → pay → close flow.

**C9 Documents.** New, under `lib/asset-finance/documents/lease/`:
- the operating-lease agreement;
- the FML agreement with a maintenance-and-usage annexure;
- the CPA expiry notice;
- the early-termination quote;
- the inspection report.

Real figures; placeholder legal text with the DRAFT watermark; deterministic output, so the sha256 binds what was signed. Signing reuses the slice 1 flow. NCA documents and consumer `lib/pdf` are untouched.

**C10 Staff UI and portal.**
- **Staff:**
  - the lease deal form and preview;
  - a lease panel on the loan page: rentals, invoices, the fund (FML), claims, readings, the end-of-term workflow and the early-termination quote.
- **Portal (authorised parties only; reuse the `portal-access` rules):**
  - rentals and per-rental tax invoices;
  - the fund and claims history (FML);
  - submit a meter reading;
  - request an early-termination quote;
  - choose the end-of-term option where offered.

  Light and dark, desktop and mobile.

**C11 Collections.** Lease arrears use the NON_NCA charges (`non-nca-charges.ts`) and the existing reminders. There is no s129 and no NCA caps. IT: book → miss → default interest → receipt → balances. Existing s129 and charges tests stay unchanged.

**C12 Seed, acceptance and evidence.**
- **Seed:** synthetic, written through the real lib functions:
  - a company FML on a TLB (`LENDER_RISK`) with two claims and readings;
  - a sole-proprietor operating lease on a bakkie (CPA applies) with an early-termination quote;
  - a trust FML (`LESSEE_SETTLED`) at end of term with a RETURN inspection.

  `npx prisma migrate reset` runs the seed twice cleanly.
- **Acceptance fixtures:** 3 more synthetic lease deals in `acceptance-deals.ts`, with independent working for rental, VAT, escalation and early termination asserted to the cent.
- **Browser walkthrough:** screenshots in `docs/asset-finance/evidence/slice3/`, plus a README.
- Update `docs/asset-finance/DESIGN.md` (slice 3 built; the C3 ledger mapping) and the memory file.

## 5. Success criteria (all with evidence)

- [ ] C1 lease deals accepted for an entity and a `Client`; the CPA scope is snapshotted and its CHECK has an IT.
- [ ] C2 lease pricing matches the oracle to the cent (advance and arrears, escalation, FML); mutation-verified.
- [ ] C3 a lease books a `Loan` + `LeaseRental` rows; staff, portal, statement and arrears figures are correct; HP and consumer tests unchanged.
- [ ] C4 exactly one tax invoice per rental under concurrent issuers (IT); early receipt issues it at receipt.
- [ ] C5 fund movements are immutable; four-eyes claims are enforced by the DB; both settlement models have an IT.
- [ ] C6 readings are monotonic (IT); excess billed once to the cent.
- [ ] C7 return, extend and purchase each run end to end (IT); transitions are DB-guarded; the purchase price is ≥ a fresh valuation.
- [ ] C8 quote → accept → pay → close (IT); the CPA cancellation basis is shown for CPA lessees.
- [ ] C9 lease documents render with real figures and the DRAFT watermark (screenshot); consumer render pins unchanged.
- [ ] C10 staff and portal screens are exercised in a browser, with screenshots in both themes and at mobile width.
- [ ] C11 lease arrears → default interest → receipt (IT); no s129 for leases.
- [ ] C12 the seed runs twice; acceptance fixtures pass; the evidence README exists.
- [ ] Every PR: blind review SHIP and CI green.
- [ ] Handoff `.claude/handoffs/2026-10-xx-asset-finance-slice3-done.md` lists every new `// UNTESTED:` / `// PARTIAL:` marker and every 2a.5 default.

## 6. Confirmation gates — STOP and ask Hein

1. Applying any migration to a database that is not a throwaway local or docker Postgres.
2. Turning off any DRAFT watermark, or writing anything presented as final legal wording.
3. Shipping VAT supply timing, CPA thresholds and rules, the early-termination formula or the purchase option as final. Building them is fine.
4. Any new third-party integration, credential or paid service (telematics and valuation feeds are slice 5).
5. Merging, deploying, or pushing to `main`; force-pushing any branch.
6. Any change to consumer NCA document output or the NCA render pins.
7. Changing an existing HP, finance-lease or consumer flow's behaviour beyond what leases need. If a shared trigger or allocation rule must change, the existing tests stay unchanged and green, and the reason goes in the PR.
8. Sending any real message. The expiry-notice cron queues only to synthetic seed contacts in local runs.
