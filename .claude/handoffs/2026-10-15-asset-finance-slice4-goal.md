# /goal — Asset finance slice 4: recovery, remarketing, litigation (4a) + journal export & IsaFlow push (4b) (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-15-asset-finance-slice4-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then queue the PRs with mq, write a handoff and stop.`

## §1 Mission

Build slice 4 of the asset finance module (`docs/asset-finance/DESIGN.md`, D3 and the slice list).

- **4a — start now.** Three parts:
  - One **recovery pipeline** that every route back to the asset feeds into: s127 voluntary surrender, s131 attachment, non-NCA voluntary handover, non-NCA court order.
  - **Remarketing** with sale controls, a **recovery cost ledger**, the **VAT** on repossession and resale, and the **post-sale account** (shortfall or surplus).
  - A light **legal matter** (litigation tracker) per loan.
- **4b — gated.** Asset-finance money events in PR #89's journal engine (`lib/accounting/`), plus an **IsaFlow draft-journal push**. Start 4b only once #89 is merged to `main`. If it is not merged when 4a is done, write the handoff and stop.

"Built" means:
- real Postgres rows, with every money rule enforced in the database;
- real API routes with RBAC and `lib/audit.ts`;
- staff (and, where stated, portal) screens;
- tests that fail when the code is wrong (mutation-verified), including a `RUN_*_IT` integration test per DB rule;
- a browser acceptance run with screenshots.

Mock data on a screen is not done.

## §2 What already exists — do NOT redo

- **Main:** `origin/main` = 72bf6215 or later. Slices 1–3 are merged: #48/#50/#59, #65/#66, #77/#85/#90. Read `docs/asset-finance/DESIGN.md` and `lib/asset-finance/.claude.md` (if present) first, plus root `CLAUDE.md`.
- **s127 surrender** (slice 2), to be **extended, not duplicated**:
  - `SurrenderRequest` (schema) with states REQUESTED → VALUED → VALUATION_NOTICE_ISSUED → PROCEEDS_CREDITED → FINAL_NOTICE_ISSUED.
  - `lib/asset-finance/surrender-store.ts`, `surrender-calculation.ts` (gross proceeds against settlement; shortfall/refund UNTESTED), `documents/nca/surrender-pdf.ts`.
  - Routes: `app/api/asset-finance/surrenders/[id]/{valuation,valuation-notice,proceeds,final-notice,documents/[kind]}/route.ts`.
  - It does not record costs, change asset status, record a sale or handle the shortfall.
- **Asset and valuations:**
  - `FinancedAsset` has `lessorStatus` (`RETURNED_TO_STOCK | SOLD_TO_LESSEE`). The schema comment says RETURNED_TO_STOCK is "ready for slice-4 remarketing".
  - `AssetValuation` (`ValuationSource` DEALER/AUCTIONEER/ASSESSOR/INTERNAL) is shared by surrender and lease end-of-term. A current-valuation rule already exists: `checkPurchaseValuation` / `bestMarketValuation` in `lib/asset-finance/lease-term-end.ts`. Reuse it.
- **Reusable pieces:**
  - Lease return inspection: `LeaseEndOfTerm`, `lease-end-of-term.ts`, `lease-end-invoice.ts`, `LeaseDamageItem`.
  - Payout checklist: `PayoutChecklistItem`, `lib/asset-finance/payout-checklist*.ts`, `payout.ts`. Two approvers and a DB checklist.
  - `Supplier` and `SupplierBankAccount`.
  - Immutable, gap-free `TaxInvoice` / `CreditNote`.
  - `EntityRelationship`: directors, trustees, sureties.
  - `CoiDeclaration` (staff conflicts).
  - Staff bell: `lib/notifications/bell.ts`.
  - Write-off with approval: `app/api/loans/[id]/write-off/route.ts`, `LoanStatus.PENDING_WRITE_OFF`.
  - `lib/crypto/secret-box.ts`.
- **Collections:**
  - `lib/collections/section129-eligibility.ts` refuses s129 for NON_NCA. `escalation.ts` gates legal steps on NCA.
  - `CollectionsStage.ATTORNEY_REFERRED` exists. There is no s130/s131 handling anywhere.
- **Bureau:**
  - L (handover) exists, emitted only with a `BureauAdverseConfirmation` (`lib/bureau-submission/map-loan.ts`, `.claude.md`).
  - Entity loans and operating/FML leases are never in the consumer file.
- **Accounting:** nothing on main. PR #89 (`feat/w6-accounting-payouts`, another session) adds the following. It is consumer loans only today: no asset finance, no IsaFlow.
  - Models: `AccountingExportBatch`, `AccountingLedgerEntry`, `AccountingJournalLine`, `AccountingAccountMapping`, `XeroConnection`, `AccountingXeroPush`, …
  - Code: `lib/accounting/` (`sources.ts` desired vectors, `derive.ts` posts the delta, `reconcile.ts` independent tie-out, SAST months DB-locked when closed, `accounts.ts` roles), CSV export and a Xero draft-journal push.
- **Acceptance fixtures:**
  - `lib/asset-finance/__fixtures__/acceptance-deals.ts`: SYN-1..3 plus an empty `CLIENT_DEALS` slot.
  - `acceptance-lease-deals.ts`: LSE-1..3.
  - Asserted by `lib/asset-finance/acceptance-deals.test.ts`.
  - **The client deal pack has not arrived.** Use synthetic deals worked independently of the code.
- **Guards that must stay green and unmodified:**
  - surrender tests (`surrender-calculation.test.ts`, `documents/nca/surrender-pdf.test.ts`, the surrender ITs);
  - `lib/collections/section129-eligibility*.test.ts`, `escalation.test.ts`;
  - `lib/bureau-submission/map-loan.test.ts`;
  - `acceptance-deals.test.ts`;
  - NCA PDF render pins (`scripts/nca-pdf-fingerprint.ts`).
- **Process:**
  - Merge only via `mq add <pr>`. The guard blocks `gh pr merge`.
  - Never push `fork/main` or `whitelabel/*`.
  - Own worktrees, each with `npm ci --legacy-peer-deps` inside.
  - IT containers via `scripts/it-db.sh` with a unique name, torn down with `docker rm -fv`.
  - Load is often 60–130: a timeout counts only if the test also fails when run alone.
  - New migrations must be additive. Enforcement migrations ship with their code.

## §2a Product decisions (made by Hein, 2026-10-15 grill — build against them, don't re-litigate)

1. **Split:** 4a now. 4b only after #89 merges, built **on** #89's engine. No second journal system.
2. **Litigation tracking is in scope** (the full scope), but light: see §4.
3. **One recovery pipeline for all routes:** s127 surrender, s131 attachment, non-NCA voluntary, non-NCA court order. s131 sells under the s127(2)–(9) procedure, so the existing surrender valuation/notice/proceeds steps become that pipeline's NCA path.
4. **Costs:** an immutable cost ledger per recovery (type, amount, VAT split, supplier invoice ref), shown on the final notice.
   - **NCA:** only sale-related costs are deducted from proceeds. Legal costs go through a separate "taxed/agreed costs" entry that needs a court-order or settlement reference.
   - **Non-NCA:** contractual costs are charged to the account.
   - The cost-type allow-list per regime lives in tenant config, marked `// UNTESTED:` for legal sign-off.
5. **VAT:** build all three paths.
   - A lease asset resale is an ordinary taxable supply.
   - Instalment sale and finance lease repossession records an immutable, dated adjustment event: the debtor's VAT-vendor status at repossession, the VAT Act s8(10) deemed-supply value and the input-tax claim. This is the source for 4b's journal lines.
   - A resale tax invoice is always issued through the existing immutable `TaxInvoice` numbering.
   - The whole path is `// UNTESTED:` until the tax adviser memo.
6. **Sale controls:**
   - The channel is recorded (AUCTION / DEALER / PRIVATE_TENDER / DEBTOR_OR_SURETY).
   - The sale needs a current **independent** valuation (not INTERNAL), using the existing age rule.
   - A price below the highest current valuation needs a second approver plus a written reason, **DB-enforced**.
   - The buyer is screened against `CoiDeclaration` and the deal's `EntityRelationship` parties and the debtor. A match means second approver plus an audit flag.
   - One completed sale per recovery, immutable.
   - Proceeds go through a real `Payment`, not a typed figure.
7. **After the sale:**
   - **Shortfall:** the account enters a recovered-shortfall state. Charges are frozen until the final-notice deadline: s127(8) 10 business days for NCA, the contract demand period from tenant config for non-NCA. After the deadline, interest runs at the contract rate within the existing NCA caps, and the account goes to collections and the legal matter.
   - **Write-off** stays a separate manual approval (existing route), never automatic.
   - **Surplus:** a refund liability, released through the payout checklist (verified bank account, second approver).
8. **Bureau:**
   - Appointing an attorney on a legal matter **proposes** an L through the existing `BureauAdverseConfirmation` flow. Nothing is sent automatically.
   - No SACRRA repossession code in this slice (the letter is unconfirmed).
   - The shortfall reports as arrears through the normal monthly file.
9. **IsaFlow (4b):**
   - One **draft** journal per closed month per tenant via IsaFlow's REST journal endpoint (not MCP), `external_ref` = CredaFlow batch id, never auto-posted.
   - A per-tenant connection whose credentials are sealed with `lib/crypto/secret-box.ts`, or W0's sealed-credential helper if #83 has merged; use whichever is on main. It is connected only by a TOTP-verified SUPER_ADMIN.
   - Account codes are validated against IsaFlow's chart before any push.
   - Proven against an IsaFlow **dev** company only.
10. **Slice-3 rulings (also 2026-10-15):** the trust lease seed stops at RETURN elected; an elected purchase re-bases to the highest current valuation; cross-tenant document probes are audited in the actor's tenant; legal/tax gates wait for the first client. DRAFT watermark stays on.

## §3 4a-1 — Recovery pipeline `[agent decides exact names]`

**Recommended shape:** a `Recovery` model (tenant-scoped, one OPEN per loan via a partial unique index).
- **Route:** `NCA_S127_SURRENDER | NCA_S131_ATTACHMENT | NON_NCA_VOLUNTARY | NON_NCA_COURT_ORDER`.
- **Fields:** an optional `surrenderRequestId` (the existing surrender becomes the s127 route's sub-record; do not migrate its data destructively), an optional `legalMatterId`, recovered-on date, yard/location, condition, an optional inspection meter reading (`AssetMeterReading`), and status.
- **Status flow:** RECOVERED → VALUED → (NCA: VALUATION_NOTICE_ISSUED) → LISTED → SOLD → PROCEEDS_APPLIED → (NCA: FINAL_NOTICE_ISSUED) → SHORTFALL_OPEN | SURPLUS_HELD → CLOSED, plus WITHDRAWN (asset released back, e.g. a settlement).
- **Transitions:** DB-guarded (a trigger, like the lease end-of-term transitions). Route-specific rules:
  - s131 needs a legal matter with an attachment order step;
  - s127 keeps today's surrender behaviour exactly;
  - NON_NCA never issues NCA notices.
- **Asset status:** add repossession states to the asset (recommended: extend `AssetLessorStatus` or add an `assetRecoveryStatus`; agent decides, additive only). The asset is RECOVERED while in the yard and SOLD after the sale. A recovered asset can't be on a new deal until it is sold or released.
- **Loan state:** recommended is to keep `LoanStatus` untouched and carry the recovered-shortfall state on `Recovery` plus a charge-freeze field the nightly charge job reads. A new `LoanStatus` value touches collections, bureau and reports. If you add one anyway, prove every `LoanStatus` switch handles it.
- **Tests:**
  - IT per DB rule: one open recovery per loan, transition order, route rules, frozen charges up to the deadline then interest.
  - The existing surrender suite is unchanged.
  - A pure-function test for the deadline calculation (use `addSouthAfricanBusinessDays` in `lib/compliance/sa-business-days.ts`).

## §4 4a-2 — Legal matter (litigation tracker)

**Recommended shape:**
- **`LegalMatter`:** loan, attorney (`Supplier`), case number, court, status OPEN/CLOSED.
- **`LegalMatterStep`:** immutable and dated. The kind is from a fixed set:
  - LETTER_OF_DEMAND
  - S129_SENT (links the existing s129 record, NCA only)
  - SUMMONS_ISSUED
  - SUMMONS_SERVED
  - JUDGMENT
  - ATTACHMENT_ORDER
  - SHERIFF_RETURN
  - ASSET_RECOVERED (creates/links the `Recovery`)
  - SETTLED
  - WITHDRAWN
- **Document upload per step:** through the existing `ClientDocument` / `lib/document-auth.ts` path, so access is logged (POPIA).

**Ordering (DB-enforced):**
- For NCA, SUMMONS_ISSUED is refused before s129 delivery + 10 business days. Reuse `section129-eligibility.ts` facts; don't fork them.
- For NON_NCA, a LETTER_OF_DEMAND is needed before summons.
- Steps are append-only; a correction is a new step that references the old one.

**Other behaviour:**
- Next-step reminders go to the staff bell (`lib/notifications/bell.ts`).
- Appointing the attorney sets `CollectionsStage.ATTORNEY_REFERRED` and proposes an L (decision 8).
- Legal costs go to the cost ledger (§5).

**Out of scope:** court e-filing, attorney logins, attorney billing.

## §5 4a-3 — Costs, VAT, sale, post-sale

- **Cost ledger:** a `RecoveryCost` row per cost (type, net, VAT, supplier, invoice ref, approved by), immutable once recorded.
  - NCA deduction rule per decision 4. The taxed/agreed legal cost needs a JUDGMENT or SETTLED step reference.
  - Shown on the final notice.
  - **The surrender final-notice PDF is NCA wording.** Adding a cost table changes the render, so:
    - re-pin with a proof of what changed;
    - keep the DRAFT watermark;
    - leave the existing wording untouched;
    - add new lines only, marked for legal sign-off.
- **VAT:** decision 5. A pure function per deal type, with an independent worked example per path (deal-type × debtor vendor/non-vendor) in tests. The adjustment event is immutable (trigger), and so is the resale `TaxInvoice` to the buyer.
- **Sale:** `RemarketingSale`, with the decision 6 controls. The DB enforces the second approver below valuation and on a related-party match, and one completed sale per recovery.
  - The buyer can be a person or an entity. Related-party screening compares normalised names and ID/registration numbers against the deal's debtor, `EntityRelationship` parties and `CoiDeclaration`.
  - Store the screening result. Never log names or ID numbers (`lib/bureau-submission/.claude.md` style).
  - Proceeds: a real `Payment` posted the way `creditSurrenderProceeds` does today.
- **Post-sale:** decision 7. Net proceeds go against settlement, then the outcome:
  - shortfall → charge freeze to the deadline, then collections;
  - surplus → refund liability, released through the payout checklist.
  - Write-off is untouched (manual route).
- **Portal (borrower):** the recovery status, the notices already issued, and the final shortfall or surplus with its cost lines. No sale buyer details.

## §6 4b — Asset-finance journal export + IsaFlow push (ONLY after #89 is on main)

- **Pre-check:** `gh pr view 89 --json state` must say MERGED. If not, stop after 4a.
- **Extend #89's engine; don't fork it.** Read its `lib/accounting/.claude.md`, `sources.ts`, `derive.ts`, `reconcile.ts` and `accounts.ts`.
- **Add sources and roles** `[agent decides role names]`:
  - inception tax invoice on the full cash price (instalment sale and finance lease: receivable / output VAT / deferred finance income or equivalent);
  - lease rentals per tax invoice;
  - maintenance fund movements;
  - residual/balloon;
  - recovery costs;
  - the repossession VAT adjustment;
  - remarketing sale proceeds;
  - shortfall/surplus;
  - refund payout.

  Every month must tie out through `reconcile.ts`, extended with independent SQL for the new sources.
- **IsaFlow target:** decision 9. Mirror #89's Xero push shape (`AccountingXeroPush` → an IsaFlow push table).
  - Idempotent on `external_ref`, with a read-back before a retry.
  - Refuse to push when any role has no mapped IsaFlow account code.
  - The IsaFlow repo is at `/home/hein/Workspace/IsaFlow`. Read its `docs/mcp/CONTRACTS.md` §7 and `pages/api/accounting/journal-entries*.ts` for the contract. Do not edit IsaFlow.
- **Proof:** an integration test against a fake IsaFlow server, plus one live draft push to an IsaFlow **dev** company (Confirmation Gate §8: Hein provides the dev company and OAuth app).
- **CSV:** the asset-finance lines appear in #89's existing CSV export too.

## §7 Success criteria (all with evidence)

1. **Recovery pipeline:**
   - Each route runs end to end in an IT: recover → value → (notices) → sell → apply → shortfall/surplus → close.
   - The existing surrender suite is unchanged and green.
   - Each DB rule is mutation-verified (remove it, see the IT go red).
2. **Legal matter:**
   - The s130-before-s129+10bd refusal and the NON_NCA demand rule are proven by IT.
   - ASSET_RECOVERED creates the recovery.
   - The bell reminder fires.
   - An L is proposed, never auto-sent: the bureau tests are unchanged.
3. **Costs/VAT/sale:**
   - Independent worked examples to the cent for at least 2 synthetic deals per route (add them next to `acceptance-deals.ts`; `CLIENT_DEALS` stays empty).
   - DB-enforced below-valuation and related-party approvals, mutation-verified.
   - Immutable sale, costs and VAT event (IT).
4. **Post-sale:** charges frozen until the deadline, then accruing (IT with a clock); the surplus refund goes through the payout checklist (IT); write-off is not triggered.
5. **Browser acceptance** on a seeded local DB (LOAN_ADMIN, TOTP), on staff screens in light and dark mode, desktop and 390 px, plus the portal recovery view:
   - legal matter → attachment → recovery → valuation → sale below valuation (second approver) → shortfall notice.
   - Screenshots go in `docs/asset-finance/evidence/slice4/` with a README, as slice 1 did.
6. **The seed** gains one recovered NCA instalment-sale deal and one non-NCA lease recovery. It runs twice cleanly.
7. **4b (if #89 merged):** month tie-out passes with asset-finance sources; the fake-IsaFlow IT proves idempotency and refuses unmapped roles; the live dev-company push is done or explicitly blocked on Hein (Gate).
8. **Every PR:**
   - `npm run ci:quality` and `npm run ci:integration` green (or load-timeouts shown passing alone);
   - a blind `/review` plus a breaker (a separate agent writing repros in a temp clone; neutral wording, "tester checking edge cases") to SHIP. The breaker targets:
     - selling below value without a second approver;
     - hiding a related buyer;
     - deducting legal costs without a court reference;
     - unfreezing charges early;
     - a cross-tenant recovery;
     - pushing twice to IsaFlow;
   - merged via `mq add`. The stop rule from earlier goals applies: if rounds 2+3 find more than round 1, record the scope boundary and move on.
9. **Wrap-up:**
   - `// UNTESTED:` markers on every legal/tax rule;
   - DESIGN.md slice-4 section updated;
   - handoff written and LATEST.md pointed at it;
   - memory `project_credaflow_asset_finance.md` updated.

Suggested PR stack:
- `feat/af-slice4-recovery` (§3 + §5 core)
- `feat/af-slice4-legal` (§4)
- `feat/af-slice4-screens` (UI, portal, seed, evidence)
- later `feat/af-slice4-journals` (§6)

## §8 Confirmation gates — STOP and ask Hein

- Changing any **existing** NCA document wording (the s127 notices, s129) beyond adding new marked lines; any re-pin without a proof.
- A destructive or non-additive migration, or editing an applied migration.
- Creating IsaFlow credentials, an OAuth app, or pushing to any IsaFlow company other than the dev company Hein names. Anything touching IsaFlow production.
- Emitting any bureau status automatically, or adding the SACRRA repossession code.
- Sending any real message (email/WhatsApp/SMS) to a borrower, attorney or buyer.
- Starting 4b while #89 is unmerged, or editing #89's branch (another session owns it).
- Production deploys, demo/Fairscore rebuilds (after hours, Hein approves), anything on Ndzinga production.
