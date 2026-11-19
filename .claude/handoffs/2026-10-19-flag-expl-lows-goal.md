# Goal: resolve the flag-explanation leftovers (2026-10-19)

Follow-up to #188 (flag explanations in the Credit checks panel, MERGED 032e7a62).
Background: `.claude/handoffs/2026-10-17-statement-ai-done.md` (2026-10-19 section).
Work autonomously: Spec → Build (TDD) → blind /review → Fix, loop until each item
below is proven, then post evidence on the PR, `mq add <pr>`, write a handoff and stop.

## Items

1. **Error log in the checks GET.** `app/api/applications/[id]/checks/route.ts`
   `explanationsFor` logs the whole error object on failure. Log only
   `error.name` (as `lib/statement-analysis/model-labels.ts` does), keeping the
   200-with-no-explanations fallback. Unit test plus a mutation.
2. **Specs that restate the flag summary.** Some `lib/statement-ai/flag-specs.ts`
   entries (e.g. NO_PAYSLIP) say in other words what the flag's summary in the row
   already says. Rewrite only the spec text so the "Why this was raised" block adds the
   rule and its reason, not a repeat. Do NOT change any credit-check rule, threshold or
   flag summary text (gate). Eval B must stay 57/57 (`scripts/statement-ai/eval.ts --only-b`),
   and `render.test.ts` stays green.
3. **Measure the checks GET cost.** With `featureStatementAi` on, the checks GET also
   runs `flagExplanations` (loads the insights). Measure p50/p95 on a seeded local DB,
   flag on vs off, and record the numbers. Optimise only if the cost is material
   (>~100 ms or >2× off); otherwise just record it.
4. **Reshoot the AI card with a real model.** The evidence page
   (https://claude.ai/artifact/7aGUEwUyWPkMBHwvTcU85L, section "Flag explanations in
   the credit checks panel (PR #188)") used a local stand-in for the summary. Reshoot with
   the real model and replace those screenshots (LOAN_ADMIN, light and dark, desktop and 375 px).
   - The main tree's `.env.local` points `VLM_API_URL` at Anthropic (`claude-sonnet-5-5`)
     with `VLM_API_KEY`, `VLM_ALLOW_HOSTED=true` and `DEMO_MODE=true` (#190, #192). Copy it into the worktree.
   - Hosted use needs `DEMO_MODE=true` and no corpus env vars set.
   - Synthetic seed data only. Run the UI on 127.0.0.1.
   - Seed with `EXPERIAN_DRY_RUN=true`.

## Gates (ask Hein)

- Any rule, threshold, flag summary, clear-flow or NCA text change.
- Turning `featureStatementAi` on for a live demo stack.
- Pointing a demo stack at the hosted model.

## Constraints

- Worktree plus a branch, never main.
- `scripts/it-db.sh` for the DB; `docker rm -fv`.
- No pattern kills.
- Don't edit files while ci:quality runs.
- Remove the worktree and containers at the end.
