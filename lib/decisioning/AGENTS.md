<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: decisioning
<!-- summary: business-configurable rules, scorecards and risk grades; auto decisions never bypass the staff decision path -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
A lender's own rules (knock-out, refer, limit cap) and scorecard (points per
bin -> score -> grade band) decide approve / decline / refer with a reason
code, replayable on history, with a challenger. Changes arrive only through
`lib/maker-checker/` (kinds `DECISION_RULE_SET`, `DECISION_ENGINE_CONFIG`).
Default OFF per lender (`DecisionEngineConfig`; no row = off; the row itself can
only be written by an approved request, trigger `guardDecisionEngineConfig`).

## The contract A5 / A6 read: the risk grade (`risk-grade.ts`)
`LoanApplication.riskGrade` (the lender's label, null = not graded), `riskScore`,
`riskGradeRank` (0 = best band; compare by this), `riskPricingTier`,
`riskGradeVersionId`, `riskGradedAt`. Written only by a LIVE run, in the
transaction of what the run did; a SHADOW run records its grade on the run only.
A challenger's grade comes from its own scorecard: compare grades across
applications only for the same `riskGradeVersionId`. `getRiskGrade` reads it.

## Critical Rules
- **Every decision goes through the staff path** (`decideApplication`,
  `app/api/applications/[id]/decide/decide-application.ts`) as the lender's
  system user (`system-user.ts`: inactive, no usable password, one per lender,
  CHECK `User_system_no_login`; provisioned when LIVE settings are approved):
  KYC, bureau, affordability, screening, open credit checks, NCA and the
  optimistic lock all run. A refusal or failure becomes a REFER (`HARD_GATE_*`),
  an application that changed first is left alone. No second decision writer.
- **The run commits with the decision**: `automation.inTransaction` writes the
  `AutoDecisionRun` and the grade inside the staff path's transaction.
- **POPIA s71**: until `s71SignedOffAt` is set (an approved settings change with
  the lender's notice wording) a decline verdict is referred
  (`S71_NOT_SIGNED_OFF`). Automated declines are listed for staff
  (`automated-declines.ts`) and can be reopened (`human-review.ts`). The client
  notice is the lender's own approved text (`notice.ts`); we ship none, only a
  draft prompt that cannot be saved. TODO for the lender's legal team.
- **Digital submissions**: a due row (`AutoDecisionDue`) is written BEFORE the
  after-response task is scheduled; the task or, if it is lost, the sweep
  (`/api/cron/digital-decisions`, every 5 min, rows are claimed) runs the review
  (`digital-due.ts`). Only LIVE reviews (as the system user, unassigned); SHADOW
  rehearses from bureau data already on file (no review, no status change, no paid
  pull; none on file: a `NO_BUREAU` run). Paid pulls are capped per client (3) and per
  address (10) per day: past it the application stays with staff (`RATE_LIMITED`).
- **A person's look-again is final**: `humanReviewRequestedAt` (set by the reopen,
  which also starts a fresh bureau generation and clears the reckless-lending
  attestation) stops the engine deciding that application again. Reopen and the
  client notice apply only while the CURRENT decline is the system user's; the
  notice is the wording stored on that run, not a later edit.
- **SoD for an engine approval**: the people whose attestations it rested on
  (reckless-lending, income, bureau override) cannot disburse it
  (`segregationOfDutiesConflict`, trigger `guardLoanApplicationSegregationOfDuties`).
- The system user is hidden from user lists and refused by every user-write route.
- **Facts** (`facts.ts`, `load-facts.ts`): affordability reuses the approval's own
  arithmetic, unrounded; bureau flags are null (not false) without a bureau
  check; a missing fact matches no comparison (only `isNull`).
- **Rules are data**: every stored set is re-validated before it runs; an invalid
  one is skipped and audited (`AUTO_DECISION_RULE_SET_INVALID`). A cap never trims
  the amount: above it the verdict is REFER. A challenger runs only from its
  effective date. Versions are immutable (trigger).
- **Simulation is read-only and indicative** (`simulate.ts`): affordability from
  recorded snapshots where there are any, the rest from the records now.

## Tests
Pure units beside each file; `auto-engine.test.ts` (mocked controls).
`RUN_DECISIONING_IT=1`: `auto-decision.integration.test.ts` (real gates under
RLS, s71 hold and sign-off, human review, digital submission, shadow, challenger,
simulation writes nothing).
