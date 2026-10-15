<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: credit-checks
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Decision ASSIST: checks over statements, payslip, declared debts/expenses and
bureau accounts raise REFER flags (`ApplicationCheckFlag`) an officer clears with
a reason. Never approves, declines or scores; bureau/affordability stay the gates.

## Critical Rules
- **Every threshold and list lives in `policy.ts`**, each with its reason.
- **Checks are pure** (one file per check, wired in `run-checks.ts`): facts in,
  `FlagCandidate[]` out. DB access is `load-facts.ts` and `recompute.ts` only.
- **Fingerprint = check|code|key** (`run-checks.ts`). Keys use the statement's
  document id + content hash (`statementKey`), so a new upload is new evidence
  while a re-read of the same bytes (parser bump) keeps clearances.
- **Flags never vanish uncleared** (`recompute.ts`): an OPEN flag no longer
  raised supersedes only when absent evidence arrived, the document it could
  not read has been read, or (LIVING_SPEND_ABOVE_DECLARED) its successor is
  raised (`maySupersede`). Deletion, client edits and parser bumps leave it OPEN (deleted documents raise *_DELETED). The DB trigger `ApplicationCheckFlag_guard_record`
  holds the record: born OPEN, no delete/truncate, fixed identity, only
  OPEN<->SUPERSEDED and OPEN->CLEARED. Recompute runs only before a decision,
  reloading persisted facts under the row lock (`FOR NO KEY UPDATE`) that the
  clear route and the approval also take, and on upload once a read lands.
- **Consent:** a statement a client uploaded without POPIA consent is never
  read here either (NOT_READ_NO_CONSENT), matching the upload path.
- **Open flags block approval three times**: the decide route's recompute,
  a re-count inside the approve transaction (which also refuses if the
  payslip/statement snapshot the recompute returned has changed), and the trigger
  `LoanApplication_a0_guard_open_check_flags` (migration 20261013120000;
  also covers INSERT and a jump to DISBURSED).
  The clearance CHECK `ApplicationCheckFlag_clearance_complete` holds
  `CLEAR_REASON_MIN_LENGTH`; change both together
  (`credit-checks-migration.test.ts` pins them).
- **Clearing** (`app/api/applications/[id]/checks/[flagId]/clear`) is
  LOAN_ADMIN + TOTP (waived only on a TOTP-free demo, `demoStaffWithoutTotp`),
  audited with the reason via `logAuditStrict` in the same transaction.
- **An agreeing adjacent statement is a hint, never a clearance** (`statement-chain.ts`).
- **Showing evidence rows is document access**: `evidence.ts` returns every
  document id a flag cites, and the GET route logs them through
  `logDocumentContentAccess` (`lib/document-auth.ts`).
- **Payslip money is used only when validated and the payslip names the
  client** (PAYSLIP_UNVALIDATED / PAYSLIP_NOT_CLIENTS otherwise); income for
  the gambling share is the lower of payslip and declared.
- **Bureau accounts:** `obligations.accounts` (`lib/compliance/bureau-review.ts`). **EXPENSE_UNDERSTATED**
  is off (`EXPENSE_UNDERSTATED_ENABLED`) until the categoriser passes its accuracy
  gate. A stored 0 is declared only with `Client.monthlyExpensesDeclaredAt` (`declaredExpenses`). Insights and export read the checks' statements (`statement-insights.ts`).

## Tests
Per-check units on synthetic facts; `tamper-fixtures.test.ts` (real PDFs);
`RUN_CREDIT_CHECKS_IT=1` for `db-enforcement`, `recompute` and `expense-understated`.
