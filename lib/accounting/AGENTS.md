<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: accounting
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Double-entry journals derived from money events, closed one SAST month at a
time, exported as CSV (generic, Sage-style) or pushed to Xero.

## Critical Rules
- **Derived, never hand-entered.** `lib/accounting/sources.ts` says what each
  source should have posted by a date; `lib/accounting/derive.ts` posts the
  difference from the ledger. A later change is an adjustment in the next open
  month, never an edit of a closed one. `(tenantId, eventKey)` is unique.
- **One loan-book receivable**; income when due; receipts credit it whole
  (no receipt principal/interest split exists to export).
- **A month may close only** once ended, after an ADMIN confirmed the mapping
  (any mapping change withdraws it), in order from `AccountingSettings.goLiveMonth`,
  and when every loan's journal book ties to `lib/accounting/reconcile.ts`
  (independent SQL). `lib/accounting/plan.ts` decides; refusals are audited.
- **Go-live**: history before the month is one OPENING entry plus
  `AccountingOpeningPosition` rows; bank and P&L history nets to opening equity.
- **Payout channel**: a loan with payout attempts books against
  PAYOUT_CLEARING; BANK moves only on PAID (back on RETURNED). An approved
  disbursement reversal zeroes the loan's sources; money paid out after it (a
  recovery case, `lib/payouts/recovery.ts`) stays in clearing until recovered.
- **Credit-life binder assumption**: premium is payable to the insurer as it
  falls due; on write-off the share not collected AS AT the write-off is
  reversed out of the payable: receipts then fill instalments earliest first,
  each interest, then fees, then principal, with the premium taken pro rata
  within the fees (no record says which). Confirm with the insurer's binder.
- **VAT is split only** when the lender is VAT-registered AND a fee role is
  marked VAT-inclusive (default off). A tax code on a mapping goes to Xero as
  tax-inclusive; never both (refused). VAT credit notes are not exported yet.
- **Closed is final (DB-enforced)**: guards in the 20261015090000 and
  20261015120100 migrations. Prisma does not report COMMIT errors:
  `closePeriod` runs `SET CONSTRAINTS ALL IMMEDIATE`, keep it.
- **Accounting tables are NOT tenant-scoped**: pass `tenantId` by hand.
- **Xero is unproven**: built to the public API, tests stub fetch. A push is
  claimed first; a stale or unknown one is NEEDS_REVIEW, never resent. BANK
  must be mapped (Xero refuses manual journals to bank accounts). Tokens move
  to W0's tenant-credentials store once W0 lands; until then they are sealed
  in `XeroConnection` under `WABA_ENC_KEY`.
- Consumer loans only (`contractType LOAN`); asset finance is not exported yet.

## Key Files
| File | Purpose |
|------|---------|
| `lib/accounting/plan.ts` | What a close would post, and whether it may |
| `lib/accounting/generate.ts` | `closePeriod`: lock, plan, store, seal |
| `lib/accounting/opening.ts` | Go-live opening entry and positions |
| `lib/accounting/xero/push.ts` | One DRAFT manual journal per closed month |
