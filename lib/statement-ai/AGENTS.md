<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: statement-ai
<!-- summary: Advisory statement summary, flag explanations and answers: the model chooses, code writes, never a decision input -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Advisory text from the self-hosted model beside the statement insights, sold
per lender (`TenantConfig.featureStatementAi`, SUPER_ADMIN only, audited):
a summary, an explanation per raised flag, and answers to an officer's
question. Goal: `.claude/handoffs/2026-10-17-statement-ai-goal.md`.

## Critical Rules
- **Advisory only.** Output is stored, audited and shown beside the rules'
  panel. It never sets, clears, softens or re-orders a flag, and nothing the
  decision runs on imports this module (`advisory-boundary.test.ts` walks the
  import graph from run-checks, recompute, load-facts and the decide route).
- **The model writes no sentence** (Hein, 2026-10-17, after review rounds
  showed free prose can contradict a flag in allowed words). It picks summary
  claims (A) and typed queries (C); code writes every sentence (`render.ts`).
  Flag explanations (B) use no model. Never return model prose to a user.
- **A sentence states only what its facts state** (`render.ts`): a figure in
  its own role (monthly vs period, in vs out, net with its sign), reconciled
  statements only, every raised flag listed and explained one by one. Payee
  names are client-written text: always quoted, and withheld when they read
  as a figure, a verdict or a note on the checks (`facts.ts safeKey`).
- **`checkFigures` checks every rendered text** (`post-check-figures.ts`):
  each figure must be a given one, as written. It guards render bugs; a stored
  output is also re-checked against today's flags before it is shown.
- **The model sees masked keys only** (`payeeOf`: first three words, none
  with a digit), never one sharing a word with the client's name (accents
  removed, prefixes and endings matched: best effort, a nickname is not caught),
  nor one the language lists would flag; never an ID, account or reference number, nor a
  flag's summary text (it can quote the client's name). Third-party payee
  names do reach the model, as in `model-labels.ts`.
- READONLY reads asked answers only; the summary and explanations restate the
  statement insights and need CREDIT_OFFICER, like the insights route.
- **Questions (C) use typed tools only** (`ask/tools.ts`, zod): sum, count,
  average, group by month or payee, list, over the application's counted rows
  (`insights.ts distinctRows`). No SQL from model text. A payee the rows do not
  have refuses the plan (`resolvePayee`): a filter that matches nothing still
  reads as an answer. Each result is written labelled with its query and filter.
- **Never call the model inside a request.** Routes enqueue; the in-process
  worker (one call at a time) generates; the UI polls.
- **Only the model at `VLM_API_URL`.** No third-party API, no new outbound host.
- **Metering never blocks**: `recordUsage` logs a failed write and carries on.
- Dev runs and evaluations against the shared model: after 17:00 SAST on
  weekdays or at weekends, with no demo bake running. Unit tests mock fetch.
- Synthetic fixtures only; the statement corpus is never used here.
