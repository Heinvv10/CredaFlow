<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: loan-changes
<!-- summary: rescheduling, restructuring, top-up, refinance, consolidation, payment holidays, rate and term changes: maker-checker, KEY_FACTS loans only, history kept -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Tender item 2.6.6. One `lib/maker-checker` kind, `LOAN_CHANGE`: a LOAN_ADMIN proposes (`propose_loan_change`), a different
ADMIN approves with step-up TOTP (`approve_loan_change`), and `apply.ts` runs in the approval's transaction. UI:
`components/loans/changes/`; routes: `/api/maker-checker/**`, `/api/loans/[id]/changes` and `/preview`.

## Critical Rules
- **NCA loans are refused, all eight types** (`NCA_REFUSAL`, trigger `guardLoanChange`): the PASQ, agreement and debit order print
  the schedule, and no approved amendment wording exists. Only `disclosureRegime = KEY_FACTS`, contract LOAN, EFT, a client.
- **Never invent wording.** Every proposal names `signedDocumentId`, the borrower's signed variation or agreement on the lender's
  own wording, uploaded to the client. A template for it is the bank's to supply.
- **In place** (RESCHEDULE, RESTRUCTURE, PAYMENT_HOLIDAY, RATE_CHANGE, TERM_CHANGE, `plan.ts`): paid rows stay, a part-paid row is cut
  to what was paid, the rest is replaced. The rows always add up to `Loan.principal`: `assertLoanChangeReconciles` at commit.
  Interest and fees already due are carried and spread (no interest on interest); unearned interest is recomputed from the last
  due date. Money paid ahead on a row not yet due is principal, or the borrower pays that period's interest twice.
- **History**: `LoanChange.scheduleBefore` keeps every row as it stood; the live `RepaymentSchedule` holds only the schedule in
  force, so no reader has to skip superseded rows. A replaced row's ledger entry reverses by itself (`deriveEntries`).
  `LoanTerms` is appended; a loan with no terms row gets its origination written first (`productVersionId` null).
- **New loan** (TOP_UP, REFINANCE, CONSOLIDATION): principal = settlement + new money. Each old loan closes through
  `applyManualReceiptInTx` with method `LOAN_SETTLEMENT` for exactly `loanSettlementFigures().totalToSettle`: never compute a
  settlement here. The receipt is non-cash (`CASH_RECEIPTS`), never reversed (route and trigger). The application names the
  request (`loanChangeRequestId`, insert-only), which is the only thing that steps past the key facts gate.
- **The ledger moves only new money**: the new loan credits PAYOUT_CLEARING for the settled part, the receipts debit it.
- **`Loan.status` is never RESTRUCTURED**: eight receipt, mandate and reminder paths need ACTIVE or DEFAULTED. A forbearance sets
  `Loan.restructuredAt`; IFRS 9 reads it (`restructuredInForce`, `lib/ifrs9/staging.ts`). The three in-place distress types always
  mark; any other change marks when a loan is in arrears. A replacement loan inherits the worst prior stage (`inheritPriorStaging`).
- **Refused on purpose**: default charges in place (the replay would re-derive them from the new rows: refinance settles them),
  daily accrual, credit life, debit orders, debt review, attorney, a live arrangement (`eligibility.ts`).
- Under the lock `apply.ts` computes again: a receipt after submission is honoured; another change makes it STALE (`baseRef`).

## Known limits
A top-up's payout is manual, recorded by reference. No affordability re-run, commission or initiation fee on a new loan.
On early settlement s125 pricing rebates carried interest in rows not yet due. A holiday's deferred interest accrues in IFRS 9
with the row that carries it, not through the holiday. Nothing is sent to the borrower.

## Tests
Pure: `plan`, `payload`, `eligibility`, `form`. `RUN_LOAN_CHANGES_IT=1`: real routes on throwaway LS and ZA databases.
