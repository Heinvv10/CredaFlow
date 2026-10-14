<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: collections-engine
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Provider-agnostic DebiCheck / debit-order collections: mandate lifecycle,
instructions planned from the instalment schedule, batch submission (sync or
file-based rails), result ingestion, review queue. Adapters live in
`lib/integrations/collections/`. Dark per tenant behind `collectionsEngineEnabled`.

## Critical Rules
- **Scheme rules live in `lib/collections-engine/scheme-rules.ts` only**, marked
  unverified against a provider rulebook. Cap and tracking window are also DB
  CHECKs; change both together (`lib/collections-engine/migration.test.ts`).
- **The presentment cap is per instalment, across mandates.** A fresh mandate
  never resets it (planner and the DB unique both key on the instalment).
- **The database enforces the hard rules** (migration
  `20261014150000_collections_engine`). Only the `RUN_COLLECTIONS_ENGINE_IT`
  suites prove them.
- **Money goes through `applyManualReceipt`** (`lib/collections-engine/allocate.ts`),
  idempotency key = result id. A PAID instruction is never moved by a later
  UNPAID/DISPUTED: that is a review item, not an NPF.
- **Never re-send what may have reached the bank.** Only `definitelyNotSent`
  releases work; stuck submissions are looked up or become NEEDS_REVIEW, which
  only staff resolve (`lib/collections-engine/review.ts`).
- **Derive, don't trust events:** stop rules, unbooked PAID results, closed
  loans and provider cancellations are re-checked on every cron run.
- **Every mandate status write goes through `transitionMandate`** (audited).
- The engine never moves `Loan.collectionsStage` and sends no borrower message.

## Key Files
| File | Purpose |
|------|---------|
| `lib/collections-engine/mandate-lifecycle.ts` | Status writer, claimed submission, retries |
| `lib/collections-engine/schedule.ts` | Pure planner, action dates, submit window |
| `lib/collections-engine/submit.ts` | Batch submission |
| `lib/collections-engine/reconcile.ts` | Load reports, stuck submissions |
| `lib/collections-engine/results.ts` | Result ingestion |
| `lib/collections-engine/stop-rules.ts` | Scheme stop rules, re-derived |
| `lib/collections-engine/mandate-sweeps.ts` | Closed loans, provider cancellation |
| `lib/collections-engine/cron.ts` | Runner for `app/api/cron/collections-submit` / `app/api/cron/collections-results` |

---
<!-- Hand-written 2026-10-14, round-1 review fixes. Refresh via /kb when files change. -->
