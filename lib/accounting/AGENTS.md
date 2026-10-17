<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: accounting
<!-- summary: GL journals; closed months are final; Xero unproven; IsaFlow vs a fake only -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Double-entry journals derived from money events, closed one SAST month at a
time, exported as CSV (generic, Sage-style) or pushed to Xero.

## Critical Rules
- **Derived, never hand-entered.** `lib/accounting/sources.ts` says what each
  source should have posted by a date; `lib/accounting/derive.ts` posts the
  difference from the ledger. A later change is an adjustment in the next open
  month, never an edit of a closed one. `(tenantId, eventKey)` is unique.
- **One receivable per contract** (`RECEIVABLE_ROLES`); income when due; receipts credit
  it whole (no receipt principal/interest split exists to export).
- **A month may close only** once ended, after an ADMIN confirmed the mapping
  (any mapping change withdraws it), in order from `AccountingSettings.goLiveMonth`,
  and when every loan's journal book ties to `lib/accounting/reconcile.ts`
  (independent SQL). `lib/accounting/plan.ts` decides; refusals are audited.
- **Go-live**: earlier history is one OPENING entry plus `AccountingOpeningPosition` rows; bank and
  P&L history nets to opening equity.
- **Payout channel**: attempts book against PAYOUT_CLEARING; BANK moves only on PAID (back on RETURNED). A
  reversal zeroes the sources; money paid out after it stays in clearing until recovered, else bad debts (`lib/payouts/recovery.ts`).
- **Credit-life binder assumption**: premium is payable as it falls due; on write-off the share not
  collected as at the write-off leaves the payable (receipts fill instalments earliest first: interest,
  fees, principal; premium pro rata within fees). Confirm with the insurer's binder.
- **Consumer VAT is split only** when the lender is VAT-registered AND a fee role is
  marked VAT-inclusive (default off). A tax code on a mapping goes to Xero as
  tax-inclusive; never both (refused). Consumer fees have no credit notes.
- **Closed is final (DB-enforced)**: guards in the 20261015090000 and 20261015120100 migrations.
  Prisma does not report COMMIT errors: `closePeriod` runs `SET CONSTRAINTS ALL IMMEDIATE`, keep it.
- **Accounting tables are NOT tenant-scoped**: pass `tenantId` by hand.
- **Xero is unproven**: built to the public API, tests stub fetch. A push is claimed first; a stale or
  unknown one is NEEDS_REVIEW, never resent. BANK must be mapped (Xero refuses manual journals to bank
  accounts). Tokens are sealed in `XeroConnection` under `WABA_ENC_KEY` until W0's store lands.
- **IsaFlow** (`lib/accounting/isaflow/`, contract refs in `contract.ts`): one DRAFT journal per closed
  month over the MCP endpoint (PAT bound to one company). The request is stored with the SENDING claim and
  resent byte for byte under `credaflow:batch:<batchId>`; IsaFlow is read back before any retry. Refused
  before claim: unmapped/remapped role, tax code, code missing or inactive in IsaFlow. Connect is TOTP
  SUPER_ADMIN (DB-enforced), push ADMIN + TOTP; origin must be in `ISAFLOW_ALLOWED_ORIGINS`. Fake-proven only.
- **Asset finance** (`sources-asset-finance.ts`, `sources-recovery.ts`; the rules are in
  `docs/asset-finance/DESIGN.md`, slice 4b) never uses the consumer sources; its VAT is explicit lines.
  Maintenance CONTRIBUTION_CREDIT reverses income/fund-liability reclassification, never BANK.
  Credit notes post on lease invoices, inception invoices (`AF_PRICE_CREDITS`) and buyer invoices
  (through `RECOVERY_CLEARING`). `reconcile-controls.ts` refuses a close (`AF_CONTROL_FAILED`); a lease
  with a deposit or trade-in, or a credit note on an instalment sale's other invoice, is
  `AF_SOURCE_UNSUPPORTED`. New roles need the mapping confirmed again. `// UNTESTED: tax|accounting`.

## Key Files
| File | Purpose |
|------|---------|
| `lib/accounting/plan.ts` | What a close would post, and whether it may |
| `lib/accounting/generate.ts` | `closePeriod`: lock, plan, store, seal |
| `lib/accounting/opening.ts` | Go-live opening entry and positions |
| `lib/accounting/xero/push.ts` | One DRAFT manual journal per closed month |
| `lib/accounting/isaflow/push.ts` | One DRAFT IsaFlow journal per closed month; `retry.ts` reads back first |
