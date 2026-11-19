# Handoff: labeller v3 (2026-10-16 evening): closed for #133

**Goal:** /goal "categoriser past §6.4 with a deterministic labeller". Run in worktree `CredaFlow-labeller-v3`, branch `feat/categoriser-labeller-v3`.

## Outcome
- **PR #134 CLOSED, not merged (Hein's choice).** Another session ran the same goal in parallel as **PR #133** (`feat/categoriser-vote`, worktree `CredaFlow-catv3`), opened 2 minutes earlier. Both PRs rewrite `model-labels.ts`; Hein picked #133.
  - #133's reviews, gates and mq add belong to that session.
- **The §6.4 gate FAILED.** Both flags stay OFF on both branches.
- **Held-out runs for #134** (frozen at 1e91e6f4: labels-p3, majority of 3, credit and gambling unanimous): 92.5%, 91.8%, 91.4%. Rules alone: 90.2%.
  - The credit mislabel is fixed.
  - LIVING → OTHER, 265 rows: unchanged.
  - OTHER → LIVING, 28–74 rows: still varies from run to run.
- **Dev:**
  - Rules + model: 99.8%.
  - Model alone: 91.7% → 96.5–96.7%.
  - Between runs, 1–2 keys change label.
- **v1 flag digest:** 606 flags, `071317c651365047`, the same as main's.
- **Coverage:** rules + model not measured. I stopped my corpus labelling run so it would not compete with #133's run on the shared model.
- **Review:** blind reviewer and breaker both SHIP on 412b5d0f (rounds 5 → 1 → 0).
- **Gates:** `ci:quality` and `ci:integration` exit 0.
- All the numbers are posted on #134.

## Findings worth keeping
- **The 265 living rows are not a labeller problem.** Both independent attempts left the same 265 living rows missed. On dev the rules are at 100%, so the dev split cannot show what generalises. The next attempt needs new dev signal: relabel or re-split, or a bigger merchant list. Prompt and vote changes won't move it. That is Hein's call.
- **Two sessions ran the same goal** (`2026-10-16-expense-gate-retry-goal.md`, plus this one from a /goal prompt). Check `gh pr list` and `git worktree list` for a sibling before starting a goal.

## Cleanup (ask Hein)
- **Worktree:** `/home/hein/Workspace/CredaFlow-labeller-v3`, remove it.
- **Branch:** `feat/categoriser-labeller-v3`, already pushed.
- **Label outputs:** `/home/hein/secure/ndzinga-corpus-derived/model-labels-v3/`. The held-out files there are unopened; never open them.
