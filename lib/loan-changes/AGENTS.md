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
- **A change never re-plans what has fallen due or accrued.** Paid rows and rows already due stay as they are, and stay owed. Only
  rows not yet due change (`plan.ts`): priced from the principal on them, from the last due date, and whatever they held above a
  fresh pricing of the same rows on the old terms (a deferred fee, grace or holiday interest, an earlier carry, a single payment's
  whole periods gone by) is carried, spread, never capitalised. Same terms move nothing, to the cent (`plan-fuzz.test.ts`). FLAT
  prices on the original principal. Money paid ahead on a row not yet due is principal. With no row left to change, refuse.
- **RESCHEDULE is the one change that moves arrears** (`plan-reschedule.ts`): at the amount owed, no new interest on periods gone by;
  rows not yet due keep their amounts and move. A later date earns simple interest. It is what cures a DEFAULTED loan. The arrears
  principal is marked (`carriedPrincipalDue`, even when it is all that is left) and bears no interest from then on; interest and fees carried are marked too, and a
  later change never reduces them, floored per component, whatever the pricing says.
- The rows always add up to `Loan.principal`: `assertLoanChangeReconciles` at commit.
- **History**: `LoanChange.scheduleBefore` keeps every row as it stood; the live `RepaymentSchedule` holds only the schedule in
  force, so no reader has to skip superseded rows. A replaced row's ledger entry reverses by itself (`deriveEntries`).
  `LoanTerms` is appended; a loan with no terms row gets its origination written first (`productVersionId` null).
- **New loan** (TOP_UP, REFINANCE, CONSOLIDATION): principal = settlement + new money. Each old loan closes through
  `applyManualReceiptInTx` with method `LOAN_SETTLEMENT` for exactly `loanSettlementFigures().totalToSettle`: never compute a
  settlement here. The receipt is non-cash (`CASH_RECEIPTS`), never reversed (route and trigger). The application names the
  request (`loanChangeRequestId`, insert-only, opened UNDER_REVIEW), which is the only thing that steps past the key facts gate.
- **A new loan is new credit** (`approval.ts`, the `approvalGate` hook): the lender's approval matrix and committee run on its
  application, the request stays SUBMITTED while levels record, the last completes through the maker-checker approval, and the
  database's chain guard holds. Rejecting or withdrawing cancels the application. Screening, KYC (`okForOrigination`), deceased and
  `product.active` are read at submit and again at approval. A change in place is not new credit: one second person.
- **The ledger moves only new money**: the new loan credits PAYOUT_CLEARING for the settled part, the receipts debit it.
- **Bounds**: maturity stays inside `maxTermDays`, a new loan inside `maxAmount`, no rate above the product's and the loan's own.
- **Signed paper**: `SIGNED_DOCUMENT_TYPES`, the borrower's, not deleted; the checker opens it from the proposal.
- **A bounced receipt on a settled loan** reverses: the settlement stands and exactly that amount is owed on the old loan, due at once.
- **Book as at a past date** (`lib/reports/book-as-of.ts`): a change after that date is read through `scheduleBefore` and `before`.
- **`Loan.status` is never RESTRUCTURED**: eight receipt, mandate and reminder paths need ACTIVE or DEFAULTED. A forbearance sets
  `Loan.restructuredAt`; IFRS 9 reads it (`restructuredInForce`, `lib/ifrs9/staging.ts`), and `defaultedAtRestructure` keeps a loan in default (the lender's `defaultDpd`) at Stage 3 through its clock, sticks across later changes and passes to a replacement loan until a MONTHLY run has staged it; each restructure restarts the clock. The three in-place distress types always
  mark; any other change marks when a loan is in arrears. A replacement loan inherits the worst prior stage (`inheritPriorStaging`).
- **Refused on purpose**: default charges in place (the replay would re-derive them from the new rows: refinance settles them),
  daily accrual, credit life, debit orders, debt review, attorney, a live arrangement (`eligibility.ts`).
- Under the lock `apply.ts` computes again: a receipt after submission is honoured; another change makes it STALE (`baseRef`).

## Known limits
A top-up's payout is manual, recorded by reference. No affordability re-run, commission or initiation fee on a new loan.
On early settlement s125 pricing rebates carried interest in rows not yet due. A holiday's deferred interest accrues in IFRS 9
with the row that carries it, not through the holiday. Nothing is sent to the borrower. A new loan's open application shows in
the staff application lists, not to the borrower, and takes no slot in the one-open-per-product index; only its change request decides it (`/decide` answers 409).

## Tests
Pure: `plan`, `payload`, `eligibility`, `form`. `RUN_LOAN_CHANGES_IT=1`: `loan-changes*.integration.test.ts`, real routes on throwaway LS and ZA databases.
