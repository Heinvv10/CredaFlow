# Handoff: statement v2 follow-ups goal (2026-10-15, done)

Goal file: `.claude/handoffs/2026-10-15-statement-v2-followups-goal.md`.

## Outcome
- **#106 MERGED.** B1: FNB uses the shared `word-table.ts` helpers. B2: `detectBanks` ranks the header's banks first, then every other marked bank.
  - The corpus TEXT accuracy report is byte-identical to main.
  - The breaker caught a regression in the first version: a header naming the wrong bank hid footer-only ABSA and Discovery. It is fixed and tested.
- **#107 MERGED.** B3: the root cause was a real SIGPIPE race, not load.
  - `grep -q` in a `docker inspect | grep` pipeline under `set -o pipefail` failed intermittently. In production it would have silently skipped the TOTP clear.
  - Fixed everywhere it occurs: restore.sh, upgrade-stack.sh (including the `docker port | grep -m1` race), it-db.sh port check, smtp-sink, lender lib, run-integration-tests.
  - Deterministic tail-output tests cover it (`/bin/sleep` in the stubs). The other demo test flakes had measured timeouts.
  - 10/10 full parallel `vitest run` green.
- **#108 MERGED (2026-10-15 21:55 SAST).** A: the §6.4 gate **FAILED**.
  - **Held-out (blind, counts only), rules + local model:** 90.3%, 67.1%, 67.1% (prompt labels-p2). Rules alone: 90.2%.
  - **Dev:** rules + model 98.9%, model alone 94.9%.
  - **Blockers:**
    - Qwen3-VL-30B is **not deterministic at temperature 0**.
    - In runs 2 and 3 it put a 1,375-row non-credit key in CREDIT_INSTALMENT.
    - The LIVING → OTHER misses (about 255 rows) remain.
  - **Ships dormant:** `MODEL_LABELS.enabled = false` in `lib/statement-analysis/model-labels.ts`. Nothing is asked or queued, and stored labels feed nothing. `EXPENSE_UNDERSTATED_ENABLED` stays false; `policy.ts` cites the runs.
  - **What merged:**
    - nullable `StatementAnalysis.modelCategories/Version/At` (migration `20261015500000`);
    - the background label step;
    - insights, flag evidence, panel and export marking of model-assigned rows;
    - `statementSnapshot` keyed by labelling time;
    - the gate scripts (`scripts/statement-categoriser-model-labels.ts`, `--model-labels` on accuracy and coverage).
  - **Coverage:** rules 31.1% of debit value; rules + model 36.4%.
  - **Long tail** (informative): 292/490 gate-class agreement.
- **v1 corpus flag set:** 606 flags, digest `071317c651365047`, identical to main. Main's own figure moved from 484/`1c37d2e49fe12bd2` with #95/#96.

## Not done / open
- **EXPENSE_UNDERSTATED is still off.** To turn it on, a categoriser must pass the gate. The next tries are a deterministic model or majority-of-3 voting, or a larger model. Score only via `scripts/statement-categoriser-accuracy.ts --model-labels`. Never read held-out disagreements.
- **The flag-ON browser check (A4) and the IT suite with the check on were not run,** because the gate failed.
- **Off-repo artefacts:** model label outputs are in `/home/hein/secure/ndzinga-corpus-derived/model-labels-*` (held-out label files: do not open).
- **Demo stacks** were not rebuilt with #106/#107/#108.

## Gotchas learned
- **"No bake running" check:** use `pgrep -f '^(timeout [0-9]+ )?bash scripts/demo/bake\.sh'` from a script file. A `ps | grep` in an inline command matches its own shell.
- **Another session merged main into feat/categoriser-model-labels at 18:22 (merge-queue tooling).** Fetch before pushing; never force.
- **Main split the Prisma schema into `prisma/schema/*.prisma`** (b5713196).
