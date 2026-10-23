<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: valuation guides (spec: docs/asset-finance/SLICE5.md Part C)
<!-- summary: provider-read DRAFT guides, four-eyes publish, immutable rows, GUIDE valuations never independent -->

- **A provider reads a whole guide, never a live value.** `ValuationProvider.readGuide` → a
  DRAFT `ValuationGuide` (`guide-store.ts`), published by a second person. Every lookup
  (`lookup.ts`) reads PUBLISHED rows, whatever the provider. A new feed is a provider in
  `registry.ts`; a simulated one is guarded by `lib/integrations/simulation-guard.ts`
  (`simulated-valuation-guide`) at read, publish and record, and stored `simulated`.
- **The database owns the rules:** `guardValuationGuide` (status moves, nothing else
  changes), `ValuationGuide_four_eyes`, `ValuationGuide_one_current_per_name`,
  `ValuationGuide_live_file`, the deferred `ValuationGuide_successor_published`,
  `guardValuationGuideRow` (rows only into a DRAFT) and `guardAssetValuationGuide`
  (a GUIDE valuation: published guide, today, the asset's make/model/year, trade value,
  snapshot written by the database). TS answers first with a reason; the proofs are the
  `RUN_ASSET_FINANCE_VALUATION_IT` suites here, each rule taken out and shown to matter.
- **GUIDE is never an independent valuation.** `NOT_INDEPENDENT_SOURCES`
  (`lib/asset-finance/asset-input.ts`) and `guardRemarketingSale` exclude it with
  INTERNAL; a lease purchase admits only ASSESSOR and DEALER. A new check of "independent"
  valuations names both, and gets a case in `not-independent.integration.test.ts`.
- GUIDE is never typed in: `VALUATION_SOURCES` and the manual forms leave it out.
- Guide values are VAT-inclusive; LTV is the goods advance (cash price incl. VAT less
  deposit and trade-in) over trade and retail, display only (`ltv.ts`).
- **GUIDE is never a statutory valuation** until counsel decides: the s127
  surrender and recovery VALUED guards refuse it (patched in `20261021090200`).
- **One case fold, PostgreSQL's `lower()`**: matching is SQL (`lookup.ts`,
  `revaluation-store.ts`), and the store re-checks a file's keys with it
  (`case-fold.ts`). Do not add a JS-side match.
- The database dates guide moves (`clock_timestamp()` in the guard); callers do not pass times.
- The 409s mapped from guard refusals match the sentences in `db-refusal.ts`; `migration.test.ts`
  pins them to the guards. Reword a guard and its constant together.
