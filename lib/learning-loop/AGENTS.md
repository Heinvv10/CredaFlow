<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: learning-loop
<!-- summary: append-only decision log + derived outcomes; PII allow-list; a gap is never a good outcome -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
One `CreditDecisionRecord` per decision event (approve, decline, return,
flag cleared, asset-finance decide, approved terms, PASQ issued), so its later
repayment outcome can be joined back to it. Design: `docs/learning-loop/DESIGN.md`.

## Critical Rules
- **Allow-list only.** Builders (`lib/learning-loop/records.ts`,
  `lib/learning-loop/records-asset-finance.ts`) read named fields; never spread a row
  into a snapshot. No ID numbers, names, contacts, bank details, bureau
  payloads, exact amounts or decline/return reason text in a stored column:
  amounts are bands, evidence is a reference (id or fingerprint).
  `records.test.ts` salts inputs with synthetic PII and must stay green.
- **Append-only.** The table refuses UPDATE, DELETE and TRUNCATE (migration
  `20261021090000_credit_decision_record`). Never add an update path; a
  correction is a new row. Test teardown deletes under
  `session_replication_role = replica`.
- **A person decides.** The record says what the gates said
  (`recommendation`) and what the named staff user decided; going against a
  gate is `overridden` with the reason (DB CHECK: reason exactly when
  overridden, ≥ 10 code points, which a route counts as `[...s].length`). A decision the code takes alone is
  `actorType: "SYSTEM"` (POPIA s71) and must be flagged, never dressed up
  as a staff decision.
- **Same transaction, fail closed, for credit decisions and offers**: pass
  the route's `tx` to `recordDecisions`. Collection actions (not hooked yet)
  must never be blocked by the log: write after the action and log a
  failure, never swallow it.
- `inputsHash` is unkeyed sha256: never treat it as hiding the exact
  values (DESIGN.md §2.3; HMAC is a follow-up).
- **No probability is invented.** `predictedProbability` stays null until a
  model produces one; the bureau score is an ordinal band, not a PD.
- **Outcomes are derived, never authored** (`lib/learning-loop/outcomes/`):
  pure definitions over source-neutral facts; change one → bump
  `OUTCOME_DEFINITION_VERSION`. A window is PENDING until elapsed; a missing
  history day makes "did not happen" UNOBSERVABLE, never false. Only OBSERVED
  rows carry a value (DB CHECK). No learning claims: v1 proves plumbing.
- `bureauBlockCode` (`lib/learning-loop/bureau-code.ts`) mirrors the order of
  `evaluateBureauGate` (`lib/decision/bureau-gate.ts`); change both together.
  The route's own gate verdict is authoritative.

## Key Files
| File | Purpose |
|------|---------|
| `lib/learning-loop/decision-log.ts` | writer, hashes, bands |
| `lib/learning-loop/records.ts` | consumer decision and offer builders |
| `lib/learning-loop/records-asset-finance.ts` | asset-finance deal decision builder |
| `lib/learning-loop/decision-log.integration.test.ts` | `RUN_DECISION_LOG_IT`: trigger, CHECKs, RLS |
| `lib/learning-loop/outcomes/job.ts` | nightly outcome job (`/api/cron/decision-outcomes`) |
| `lib/learning-loop/outcomes/outcomes.integration.test.ts` | `RUN_DECISION_OUTCOMES_IT`: idempotency, key, RLS |
| `app/api/applications/[id]/decide/decision-log.integration.test.ts` | `RUN_DECISION_LOG_IT`: approve/decline through the route under RLS |
