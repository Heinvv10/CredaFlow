# /goal — Statement categoriser: third attempt at the §6.4 gate, then EXPENSE_UNDERSTATED on (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-16-expense-gate-retry-goal.md to completion. Work autonomously through Spec → Build (TDD) → Measure → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then queue the PR with mq, write a handoff and stop.`

## §1 Mission

Reach the §6.4 categoriser gate: **≥ 95% on held-out merchant keys, minimum of ≥ 3 runs**. If it passes, switch
`MODEL_LABELS.enabled` and `EXPENSE_UNDERSTATED_ENABLED` on in the same PR.

This is the third attempt. Rules alone score 90.2%. Rules plus model labels scored 90.3%, 67.1% and 67.1%, because
the local Qwen3-VL-30B is not deterministic at temperature 0. Twice it put a 1,375-row non-credit key into
CREDIT_INSTALMENT.

**The strongest argument against this goal:** the gate may not be reachable with this model, and every held-out
scoring leaks a little signal. So the held-out budget is capped (§4), and an honest miss is an acceptable outcome.

## §2 What already exists — do NOT redo

- **Read first:** `.claude/handoffs/2026-10-16-0632.md`, `.claude/handoffs/2026-10-15-statement-v2-followups-done.md`,
  the gate comment on PR #108 (`gh pr view 108 --comments`), §6 of
  `.claude/handoffs/2026-10-14-statement-analysis-v2-goal.md`, and `lib/statement-analysis/.claude.md`.
- **Merged and dormant (#108):**
  - `lib/statement-analysis/model-labels.ts` (prompt `labels-p2`, batches of 20, matches the echoed key);
  - `label-read.ts` (a background step in the persist.ts queue);
  - additive `StatementAnalysis.modelCategories` / `modelCategoriesVersion` / `modelCategoriesAt`;
  - the UI and evidence already mark model-assigned rows;
  - `MODEL_LABELS.enabled = false`; `storedModelLabels` feeds nothing.
- **Flag:** `EXPENSE_UNDERSTATED_ENABLED = false` in `lib/credit-checks/policy.ts`. Every other prerequisite is
  merged (#98).
- **Gate tooling:** `scripts/statement-categoriser-accuracy.ts <keys> <labels> [--show] [--model-labels <file>]`,
  `scripts/statement-categoriser-model-labels.ts`, `scripts/statement-categoriser-corpus.ts coverage|longtail`.
- **Corpus (real client data):** `/home/hein/secure/ndzinga-corpus` and `/home/hein/secure/ndzinga-corpus-derived/`.
  Masked shapes and counts only. Never print names, ID or account numbers, or transaction text. The masked
  merchant-key files are the one readable exception. **Never open `model-labels-p2/heldout-*.tsv`.**
- **Baselines to keep:** v1 corpus flag set has 606 flags, digest `071317c651365047`; coverage is 36.4% of debit
  value with model labels, 31.1% without.

## §3 Approach `[agent decides, from dev evidence]`

Candidates, in rough order of promise. Measure each on **dev** before spending any held-out budget:

1. **Majority vote:** label each key N times (N odd, ≥ 3). Keep a label only when ≥ a threshold of runs agree,
   otherwise UNCATEGORISED. Measure dev agreement across runs first to set N and the threshold.
2. **Guard rails on high-impact categories:** e.g. CREDIT_INSTALMENT, or any category that drives a credit-check
   figure, needs a rule match or a unanimous vote. A model label may never move value into a category that changes
   a decision unless the vote is unanimous.
3. **More dev-derived rules:** patterns, not per-key lookups. Bump `CATEGORISER_VERSION`.
4. **Abstain on value:** keys above a row-count or value threshold are rules-only, because one wrong high-volume key
   costs more than many right small ones.

Combine as dev evidence supports. No other model: only `VLM_API_URL` / `VLM_MODEL` may see corpus text. Bump the
prompt or label version if the stored shape or meaning changes; old stored labels with an old version are ignored.

## §4 Measure (after 17:00 SAST on weekdays only)

- **Before any corpus model run:** confirm no demo bake is running
  (`pgrep -f '^(timeout [0-9]+ )?bash scripts/demo/bake\.sh'` from a script file, not inline).
- **Dev:** tune freely with `--show`.
- **Held-out budget: at most 2 candidate configurations**, each scored ≥ 3 times, without `--show`. Freeze the
  config before scoring it. Record both on the PR, including the one that lost.
- **Gate:** passes only if the minimum of ≥ 3 held-out runs is ≥ 95%.
- **Also report:** dev score, coverage before and after, run-to-run agreement on dev, and the v1 flag digest
  (must be unchanged for the rules part).

## §5 Switch on (only if §4 passes)

- Set `MODEL_LABELS.enabled = true` and `EXPENSE_UNDERSTATED_ENABLED = true`. Update the `policy.ts` comment to cite
  the measured runs.
- Run RUN_CREDIT_CHECKS_IT with the check on: an OPEN flag blocks approval through the trigger, and
  clear-then-approve succeeds.
- Browser check on a seeded local DB (LOAN_ADMIN with TOTP): an application whose statements exceed the declared
  expenses shows the flag with model-labelled rows marked. Light and dark mode, desktop and 375 px. Screenshots go
  in the scratchpad, never committed.
- Update `lib/statement-analysis/.claude.md` for what is now stored and used.

**If §4 misses:** merge the dev-proven gains with both flags off, post the best held-out minimum and what blocks it,
and stop. Do not lower the gate. Do not tune against held-out.

## §6 Review and merge

- `npm run ci:full` green twice in a row on the final head. `npm run agents:mirror` then
  `npm run claude-md:check && npm run agents:check` if a `.claude.md` changed.
- Every new invariant is mutation-verified: vote threshold, high-impact guard rail, version mismatch ignored,
  background-only, rules-first, off-enum → UNCATEGORISED.
- `/review` (fresh Opus reviewer) plus a separately spawned Opus **breaker** working in its own clone. Breaker
  targets: can a hostile description steer a vote; can a model label hide living spend or invent a credit
  instalment; can the model be called inside a request; can a stale label version be used.
- Fix every finding, re-confirm on the new head. Stop rule: if rounds 2+3 together produce more findings than
  round 1, write down the scope boundary and move on.
- Hosted CI green, then `mq add <pr>`.

## §7 Success criteria (evidence for each)

- [ ] Dev numbers and ≥ 3 held-out runs per scored configuration (≤ 2 configurations) posted on the PR as counts
      only; v1 flag digest unchanged.
- [ ] **Passed:** both flags ON, RUN_CREDIT_CHECKS_IT green with the check on, browser screenshots viewed.
      **Missed:** both flags OFF, report of best minimum and blockers.
- [ ] Each invariant in §6 mutation-verified.
- [ ] Reviewer and breaker both SHIP on the final head; merged via `mq`.
- [ ] Handoff written, `.claude/handoffs/LATEST.md` points to it, memory `project_credaflow_decision_engine.md`
      updated.

## §8 Confirmation gates — STOP and ask Hein

- Any corpus model run 08:00–17:00 SAST Mon–Fri, or while a demo bake is running.
- Scoring a third held-out configuration, lowering the 95% gate, changing its definition, or reading held-out
  disagreements or held-out label files.
- Sending corpus text to any model other than the local `VLM_API_URL`, or copying corpus-derived data outside
  `/home/hein/secure/`.
- Deleting the corpus.
- Any non-additive migration.
- Anything touching Ndzinga production, `ndzinga-lms`, the demo/Tsela/Fairscore stacks, or any deploy.

## Rules (from CLAUDE.md, restated)

- Work in a worktree off origin/main; `npm ci --legacy-peer-deps` inside it. Fetch before pushing.
- Never `git add -A`, amend, force-push or push to main, `fork/main` or `whitelabel/*`.
- IT containers: unique names, fail fast, `docker rm -fv`. Kill processes by exact PID only.
- No `console.log`; no empty catch; files under 300 lines; synthetic data only in the repo.
- **DO NOT RESURRECT** model labels ON with the `labels-p2` single-run setup: measured worse than rules alone.
