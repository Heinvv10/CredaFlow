<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: approval
<!-- summary: multi-level approval matrix, delegated authority, TAT escalation and credit-committee decisions; the maker never approves -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
A lender's own approval chain: how many levels (by role) must approve an application, by amount,
product, risk grade and branch; delegated authority; escalation when a level is overdue; the credit
committee's pack and recorded decisions. **No enabled matrix = today's single-approver flow, unchanged.**
The matrix is versioned (`ApprovalMatrixVersion`) and changes only through `lib/maker-checker/`
(kind `APPROVAL_MATRIX`; a change that loosens it, a rule needing 0 levels or the matrix off, needs a
SUPER_ADMIN to approve).

## Critical Rules
- **The gate** (`chain.ts` `gateApproval`, called by `decideApplication`'s approve branch) plans each
  attempt (`plan.ts`, pure): the engine may approve only where 0 levels are required; the maker (anyone
  in `inputStaffIds`) never approves; one person approves once per case; levels go in order, each by
  someone whose authority (role level, or delegation up to its amount and dates) reaches it. A level that
  is not the last is recorded and the application stays UNDER_REVIEW; the last approval runs the real
  approval, writing its step in the same transaction (`recordFinalStep`).
- **The database enforces it** (migration 20261030100000): `LoanApplication_y_guard_approval_chain`
  refuses APPROVED while an open case's chain is incomplete (or its requirement was never set), closes the
  case when the application leaves review, and refuses a disburser who approved at ANY level; steps are
  in order, from active non-system non-maker staff, append-only; a case's requirement is set once.
- **A case freezes its requirement and levels** at the first approval attempt (`requiredLevels`,
  `levelsSnapshot`): a later matrix change never moves a case in flight. The clock starts at review
  start (`openApprovalCaseSafely`); each level's SLA sets `dueAt`.
- **Escalation** (`escalation.ts`, cron `approval-escalations`, every 15 min, claimed by `dueAt`, not
  `singleRun`): overdue level -> notify the next level up, record it, climb again each SLA; at the top
  level the approvers are reminded.
- **Committee**: the committee's level (the last, flagged) waits for an APPROVED `CreditCommitteeDecision`
  (conditions ride on the step); DEFERRED/DECLINED block it; the latest decision counts. A decline is
  still the normal decline. Viewing the pack (`pack.ts`, personal data) is audited.
- **Delegation** (`delegations.ts`): from the delegator's own role level only (never re-delegated), to a
  LOAN_ADMIN or above, at most 90 days, never backdated; ends by revocation, never edited. A delegator
  who has lost the level cannot keep passing it on.

## Tests
Pure: `evaluate`, `plan`, `matrix-payload`, `delegation-rules`, `committee-rules`. `RUN_APPROVAL_IT=1`:
`approval.integration.test.ts` (real gates under RLS, every trigger and CHECK); the any-level disburser
rule is also in `lib/security/segregation-of-duties.integration.test.ts`.
