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
- **Digital submissions** are reviewed and decided after the response
  (`schedule-digital.ts`, `digital-submission.ts`) when the lender covers PORTAL.
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
