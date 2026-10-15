<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: screening
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
PEP / sanctions / adverse-media screening of a client, or an entity and its
related people. Adapters implement `ScreeningProvider` (`lib/screening/types.ts`)
and register in `lib/screening/registry.ts`, keyed by
`TenantConfig.screeningProvider` (null = off, approval not gated). Only the
simulated provider exists so far. FIC registers live in `lib/fic/`.

## Critical Rules
- **A run is bound to the identity it screened** (`subjectFingerprint`, from
  the SQL function `screeningCurrentFingerprint` — never computed in TS; each
  field length-prefixed). A name, ID number or date-of-birth change makes it
  NOT_SCREENED, and a clearance never carries across identities.
- **Blocks are sticky.** A confirmed sanctions match or a REJECTED decision
  raises a `ScreeningBlock` in the database; a later clear run does not end it.
  Only a SUPER_ADMIN with TOTP lifts one, with a reason (`blocks.ts`).
  REJECTED is never carried. A confirmed sanctions match is never cleared.
- **Carry-forward** (`carry.ts`, DB `guardScreeningCheckRecord`): same result
  level only (POSSIBLE→POSSIBLE, CONFIRMED→CONFIRMED), never upward, never for
  SANCTIONS; from an identical FALSE_POSITIVE/ACCEPTED (type, entry ids,
  versions, matched names — not scores) within `CARRY_MAX_AGE_DAYS`, by a
  reviewer still holding the role. No ids, no carry.
- **Maker-checker** is per lender (`TenantConfig.requireSecondReviewer`,
  default on; DB trigger `enforceSecondReviewer`, on insert and update):
  whoever started a run never decides it, and whoever decided a match the
  screening relies on (carried decisions traced) never approves. Off: gate
  runs are system runs and neither rule applies.
- **Entity borrowers:** a block on any person screened for the entity
  (`contextEntityId`) or ever related to it blocks the entity, even after the
  relationship is deactivated or deleted, until a SUPER_ADMIN lifts it — and
  that lift clears the person everywhere, not just for this entity.
- **State = latest run** (`state.ts`); the SQL `screeningSubjectRefusal` holds
  the same rule. Change both together (`screening-migration.test.ts`).
- **A provider failure or timeout is an ERROR row (INCOMPLETE), which blocks.**
  The gate retries at once; the cron retries with exponential backoff.
- **Simulated results are evidence only where simulation is permitted**
  (`lib/integrations/simulation-guard.ts`, key `screening`).
- **Run, review, lift and the approval re-check share the subject's advisory
  lock** (`lockSubjectScreening`). Keep any new writer inside it.
- **Audit rows carry types and results, never the matched list entries.**
- **Submit-time screening (`on-submit.ts`) never blocks**; the approval gate
  (`gate.ts`) binds. No vendor monitoring webhooks yet: the cron (`refresh.ts`).

## Tests
Pure: `state.test.ts`, `carry.test.ts`, `simulated-provider.test.ts`,
`on-submit.test.ts`. Real Postgres with `RUN_SCREENING_IT=1`:
`screening-workflow`, `breaker-repros`, `rescreen`, `db-enforcement`,
`db-enforcement-round1` (and `lib/fic/db-enforcement.integration.test.ts`).
