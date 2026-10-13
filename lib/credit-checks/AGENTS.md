<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: credit-checks
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Decision ASSIST: four evidence checks over an application's statements,
payslip, declared debts and bureau accounts raise REFER flags
(`ApplicationCheckFlag`). An officer clears each with a reason. The engine
never approves, declines or scores; bureau and affordability gates stay the
hard stops.

## Critical Rules
- **Every threshold and list lives in `policy.ts`**, each with its reason.
- **Checks are pure** (`document-authenticity.ts`, `salary-match.ts`,
  `undisclosed-debt.ts`, `risk-behaviour.ts`, `manual-review.ts`): facts in,
  `FlagCandidate[]` out. DB access is `load-facts.ts` and `recompute.ts` only.
- **Fingerprint = check|code|key** (`run-checks.ts`). Keys use the statement's
  document id + content hash (`statementKey`), so a new upload is new evidence
  while a re-read of the same bytes (parser bump) keeps clearances.
- **Flags never vanish uncleared** (`recompute.ts`): an OPEN flag no longer
  raised supersedes only when absent evidence arrived (`SUPERSEDES_ON_ARRIVAL`)
  or its own statement was re-read. A deleted statement or an edited client
  record leaves it OPEN (and a deleted read statement raises
  STATEMENT_DELETED). The DB trigger `ApplicationCheckFlag_guard_record`
  holds the record: born OPEN, no delete/truncate, fixed identity, only
  OPEN<->SUPERSEDED and OPEN->CLEARED. Recompute runs only before a decision,
  reloading persisted facts under the row lock (`FOR NO KEY UPDATE`) that the
  clear route and the approval also take, and on upload once a read lands.
- **Consent:** a statement a client uploaded without POPIA consent is never
  read here either (NOT_READ_NO_CONSENT), matching the upload path.
- **Open flags block approval three times**: the decide route's recompute,
  a re-count inside the approve transaction, and the trigger
  `LoanApplication_a0_guard_open_check_flags` (migration 20261013120000;
  also covers INSERT and a jump to DISBURSED).
  The clearance CHECK `ApplicationCheckFlag_clearance_complete` holds
  `CLEAR_REASON_MIN_LENGTH`; change both together
  (`credit-checks-migration.test.ts` pins them).
- **Clearing** (`app/api/applications/[id]/checks/[flagId]/clear`) is
  LOAN_ADMIN + TOTP-verified session, audited with the reason via
  `logAuditStrict` in the same transaction.
- **Showing evidence rows is document access**: `evidence.ts` returns every
  document id a flag cites, and the GET route logs them through
  `logDocumentContentAccess` (`lib/document-auth.ts`).
- **Payslip money is used only when validated and the payslip names the
  client** (PAYSLIP_UNVALIDATED / PAYSLIP_NOT_CLIENTS otherwise); income for
  the gambling share is the lower of payslip and declared.
- **Bureau accounts:** `obligations.accounts`, from `lib/compliance/bureau-review.ts`.

## Tests
Per-check units on synthetic facts; `tamper-fixtures.test.ts` (real PDFs);
`RUN_CREDIT_CHECKS_IT=1` for `db-enforcement` and `recompute` on Postgres.
