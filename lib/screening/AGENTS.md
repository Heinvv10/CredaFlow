<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: screening
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
PEP / sanctions / adverse-media screening of borrowers. Provider-agnostic:
adapters implement `ScreeningProvider` (`lib/screening/types.ts`) and register
in `lib/screening/registry.ts`, keyed by `TenantConfig.screeningProvider`
(null = not configured: nothing screened, approval not gated). Only the
simulated provider exists until a vendor is contracted. FIC registers (CTR,
STR, RMCP) live in `lib/fic/`.

## Critical Rules
- **A confirmed sanctions match is never cleared.** No decision can be written
  to it (CHECK `ScreeningCheck_sanctions_never_cleared`), and a sanctions
  match is never ACCEPTED. Do not add an override path.
- **The state of a client is the state of their LATEST run**
  (`lib/screening/state.ts` `deriveScreeningState`). The SQL trigger
  `guardLoanApplicationScreening` holds the same rule for APPROVED and
  DISBURSED; change both together (`lib/screening/screening-migration.test.ts`).
- **A provider failure is a recorded ERROR row (state INCOMPLETE), which
  blocks.** Never read "could not screen" as clear.
- **Simulated results are evidence only where simulation is permitted**
  (`lib/integrations/simulation-guard.ts`, key `screening`). The simulated
  provider refuses on a deployed build unless listed in SIMULATED_INTEGRATIONS.
- **Run, review and the approval re-check share the client's advisory lock**
  (`lockClientScreening`). Keep any new writer inside it.
- **Decisions carry forward only for identical matches** (same type and
  `matchFingerprint`); a new list entry is referred again.
- **Audit rows carry types and results, never the matched list entries.**
- **Submit-time screening (`on-submit.ts`) never blocks a submission**; the
  approval gate (`gate.ts`) is the binding one and re-runs a stale run.

## Tests
Pure: `state.test.ts`, `simulated-provider.test.ts`. Real Postgres with
`RUN_SCREENING_IT=1`: `screening-workflow`, `db-enforcement` (and
`lib/fic/db-enforcement.integration.test.ts`).
