# Handoff: expense gate retry (2026-10-16 evening): gate MISSED, #133 MERGED (ad3acd34)

Goal file: `.claude/handoffs/2026-10-16-expense-gate-retry-goal.md`. PR: **#133** `feat/categoriser-vote`, worktree `/home/hein/Workspace/CredaFlow-catv3`, head 4dd78773.

## Outcome
- **The §6.4 gate missed.** Held-out ran on config 5a661d3b (rules v3 + labels-p3x3 vote): **91.5%, 91.5%, 91.4%**.
  - Rules alone: 90.2%.
  - Confusions on the minimum run: LIVING → OTHER 265 rows, CREDIT → OTHER 58, OTHER → LIVING 9.
- **Both flags stay OFF:** `MODEL_LABELS.enabled` and `EXPENSE_UNDERSTATED_ENABLED`.
- **A parallel session ran the same goal** and opened #134 (92.5 / 91.8 / 91.4). Hein picked #133, and #134 is closed. See `2026-10-16-labeller-v3-closed.md`.
- **The held-out budget is spent:** each PR scored one configuration, so two in total. **Do not score held-out again** without Hein.

## What #133 merges (all dormant)
- **Vote:** `VOTE_RUNS` = 3, each run in its own `runOrder`.
  - Living needs every answering run to agree; other categories need a majority.
  - A refused or garbage batch abstains, and a key needs answers from at least 2 of the 3 runs.
- **`NEVER_APPLIED`:** the model's CREDIT_INSTALMENT and GAMBLING answers are never stored or applied.
- **`storedModelLabels`:** needs the configured model's exact version.
- **Prompt labels-p3 and categoriser-v3:** general-knowledge names, with the generic words removed after the breaker's review.

**Evidence:**
- Coverage: rules 31.2%, rules + labels 35.0%.
- v1 flag digest `071317c651365047`, 606 flags, unchanged.
- 18/18 invariant mutants red.
- Blind reviewer and breaker (both Opus) SHIP on 4dd78773.
- Local `ci:full` on 4dd78773: run 1 green; run 2 red on an unrelated 5 s timeout (`lender-api-hardening.integration.test.ts` B1, 5046 ms under load); runs 3 and 4 green (2746 passed, integration OK), then `mq add 133`. Hosted CI green.

## Why it can't pass this way
- The dev split is 100% by rules alone, so dev evidence cannot point at the rows still missed. Two independent sessions' prompt and vote designs both landed at a 91.4% minimum.
- **The next attempt needs new dev signal:** a re-split, relabelling, or a wider merchant list. That is Hein's decision.

## Follow-ups
- **Omitted-key veto** (breaker, LOW, fails closed): a labels object that leaves out a key counts as a vote for UNCATEGORISED. Fix: `parseLabels` sets only the keys the model echoed.
- `policy.ts` comment nit: the gate figures there also predate abstention (`model-labels.ts` says so).
- **Off-repo artefacts:** `/home/hein/secure/ndzinga-corpus-derived/model-labels-p3/`. The `heldout-c1-*.tsv` files contain held-out keys: never open them.
- **Corpus deletion:** still Hein's call.
- **Worktrees to remove** (ask first): `CredaFlow-catv3`, `CredaFlow-labeller-v3`.
