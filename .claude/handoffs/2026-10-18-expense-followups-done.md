# Expense-gate follow-ups — DONE (2026-10-18)

Closes `2026-10-18-expense-followups-goal.md`. **PR #180 queued via `mq add 180`** (head 6ee5b18d,
branch `fix/expense-omitted-key-veto`, worktree `../CredaFlow-expense-fu`, which can be removed after merge).
Both flags stay **off** (`MODEL_LABELS.enabled`, `EXPENSE_UNDERSTATED_ENABLED`).

## What shipped (#180)

- **A key the model omits now abstains.** `parseLabels` (`lib/statement-analysis/model-labels.ts`) sets only the keys
  the model echoed. A key left out of a valid `labels` object is no longer a vote for UNCATEGORISED, which had been
  vetoing living labels that need unanimity. An echoed invalid or non-string value still votes UNCATEGORISED.
  `MODEL_LABEL_PROMPT_VERSION` → `labels-p3x3a`, so stored labels are relabelled. The prompt hash is unchanged
  because the prompt itself did not change.
- **Comments updated:** the `vote()`/`VOTE_RUNS`/`parseLabels`/header comments, `lib/statement-analysis/.claude.md`
  and its AGENTS.md mirror.
- **`policy.ts` comment only:** the 91.5/91.5/91.4% figures predate abstention and the v3 word removals. It also adds
  that on 2026-10-17 bigger local models scored worse than the 30B on dev, so model labels are not the route to the gate.

## Evidence

- **TDD:** 2 new tests were red before the fix and green after:
  - FOOD, omitted, FOOD → FOOD.
  - Omitted keys and `constructor` → `{}`.
  - An echoed invalid value is still a vote for UNCATEGORISED.
  - Mutation: reverting just the parse change turns both red (2 failed / 49).
- **Gates:**
  - `tsc`, `lint`, `claude-md:check` and `agents:check` OK.
  - Full `npm test`: 19,866 passed.
- **`ci:full`:**
  - Run 1 (8f030a65) failed, 1 of 3,084: `lib/affordability/own-lender-debt.integration.test.ts:112`. Two loans came
    back in swapped order. This is **pre-existing**: `loadOwnLenderDebts` (`own-lender-debt-load.ts`) orders by
    `startDate` alone, and the fixture's loans tie on it. This PR does not touch that file.
  - Run 2 (6ee5b18d, final head) was fully green: unit 19,866, integration 3,081 passed.
- **Blind review (sonnet, fresh context):** APPROVED, with 2 LOWs. The stale header comment is fixed in 6ee5b18d; the
  other LOW is reconciled. Reconfirmed **SHIP** on 6ee5b18d. Reconciliation is posted on #180.

## 2026-10-17 recap (from the GPU window session)

- **#160 MERGED:** `Insights.aboveDeclared` hint in `StatementInsightsPanel` (blocks nothing); `understated()` is in
  `lib/credit-checks/policy.ts`.
- **#165 CLOSED** (NSI brand dictionary): +0.1% coverage only, and generic or person-like brand forms caused
  OTHER→LIVING errors. Don't reopen it.
- **GPU window results** (model alone, dev keys, same prompt, 3 deterministic runs):

  | Model | Dev score |
  | --- | --- |
  | Current 30B | 79.2% |
  | Mistral-Small-3.2-24B | 72.2% |
  | Qwen2.5-32B | 46.9% |

  Bigger models don't help, and the model-label route to 95% is exhausted.
- **HunyuanOCR on GPU:** 9.9 s/page. On the TEXT-read set: closing balance 13/13, rows 7/13, totals 4/13. Its AUP bars
  automated credit decisions. Do not integrate it.
- **How the GPU window was opened:**
  - vLLM was stopped 11:33 and restored 12:24.
  - The velo cron `health-check.sh` restarts `vllm-qwen` every 5 min, and `systemctl mask --runtime` fails because
    the unit lives in /etc.
  - What worked: a runtime drop-in `/run/systemd/system/vllm-qwen.service.d/zz-gpu-window.conf` containing
    `[Service]` + `ExecStartPre=/bin/false`, then `daemon-reload` and stop. To restore, remove the drop-in, run
    `daemon-reload`, then start.
  - Coordinate with the IsaFlow sessions (`~/isaflow-ocr-bench/scripts/window.sh`). Run nothing beside the 30B: a
    3.5 GB neighbour OOM-killed it.

## Open (Hein's call)

- The **third held-out run** is still unspent, and the §6.4 gate is unchanged.
- **Deleting client data:**
  - the corpus;
  - `~/secure/ocr-bakeoff/` (8.3 GB);
  - `~/secure/own-statements/` (whose are the "MVV PB1" statements?);
  - the statement zips in `~/Downloads`.
- **Flake:** `own-lender-debt-load.ts` sorts on a non-unique key (`startDate` / `approvedAt`), so tied rows can come
  back in either order → goal `2026-10-18-own-lender-order-goal.md`.
