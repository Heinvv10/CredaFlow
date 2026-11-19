# /goal — Expense-gate follow-ups: 2 small code fixes + a handoff (run autonomously until DONE)

> **How to use:** start a fresh session in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-18-expense-followups-goal.md to completion. Work autonomously through Spec → Build (TDD) → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§5). Loop until every Success Criterion (§4) is proven with evidence, then queue the PR with mq, write a handoff and stop.`

## 1. Mission

These are leftovers from the 2026-10-16 expense-gate retry (#133) and the 2026-10-17 GPU window. Both code items are dormant: `MODEL_LABELS.enabled` and `EXPENSE_UNDERSTATED_ENABLED` stay **false**. Ship one small PR with both fixes, then update the handoff.

## 2. What already exists — do NOT redo

- **#133 merged (ad3acd34):** the 3-run vote, abstention, `NEVER_APPLIED`, `runOrder`, and exact-model-version stored labels.
- **#160 merged:**
  - `Insights.aboveDeclared`, a hint that blocks nothing, in `StatementInsightsPanel`.
  - `understated()` lives in `lib/credit-checks/policy.ts`.
- **#165 closed (NSI brand dictionary):** it added only +0.1% coverage, and its generic/person-like forms caused OTHER→LIVING errors. Don't reopen it.
- **2026-10-17 GPU results (model alone, dev keys, same prompt):** current 30B 79.2%, Mistral-24B 72.2%, Qwen2.5-32B 46.9%. Bigger models don't help, so don't re-test models.
- **HunyuanOCR on GPU:** closing balance 13/13, but rows 7/13 and totals 4/13. Its AUP also bars automated credit decisions. Not to be integrated.
- **The one third held-out run Hein approved is still unspent.** Nothing in this goal uses it.

## 3. The work

### A. Omitted-key veto (`lib/statement-analysis/model-labels.ts`, `parseLabels`)

- **Today:** `parseLabels` writes `out[key]` for every requested key. A key the model left out of an otherwise valid `labels` object becomes `"UNCATEGORISED"`, which `vote()` counts as a real vote against.
- **Fix:** set only the keys the model echoed. An omitted key is then absent from that run, so it abstains. That matches how a refused or garbage batch already abstains.
- **Keep:** an echoed key with an unknown or invalid category still maps to `UNCATEGORISED`, which is a real answer.
- **Version:** bump `MODEL_LABEL_PROMPT_VERSION`, e.g. `labels-p3x3a`, and re-pin the prompt hash test in `model-labels.test.ts`. Update the test files that pin the version string (grep for `labels-p3x3`).
- **TDD:**
  - Write a failing test first: 3 runs where 2 answer FOOD and 1 omits the key → FOOD. Today that is UNCATEGORISED, because living needs unanimity among those who answered.
  - Also test that an echoed invalid value is still a vote for UNCATEGORISED.
  - Mutation-verify: revert the fix and the new test goes red.
- **Docs:** update the `vote()` / `labelOnce` comments, and `lib/statement-analysis/.claude.md` if it describes abstention.

### B. Comment nit (`lib/credit-checks/policy.ts`, the `EXPENSE_UNDERSTATED_ENABLED` comment, ~line 160–178)

- **The problem:** the 2026-10-16 figures (91.5/91.5/91.4%) were scored before abstention and the v3 word removals.
- **The fix:** say so, as `model-labels.ts` already does.
- **Also add one line:** 2026-10-17, larger local models (Mistral-24B, Qwen2.5-32B) score worse than the 30B model alone on dev, so model labels are not the route to the gate.
- This is a comment only. Don't change any code.

### C. Handoff

- Write `.claude/handoffs/2026-10-18-expense-followups-done.md` and prepend a pointer to `LATEST.md`.
- It must also cover 2026-10-17: #160 merged, #165 closed, the GPU-window results, and how the GPU window was opened (below).

## 4. Success criteria

- [ ] New tests are red before the fix and green after, and mutation is verified.
- [ ] `npx tsc --noEmit`, `npm run lint`, the full `npm test`, `npm run claude-md:check` and `npm run agents:check` all pass.
- [ ] `npm run ci:full` is green on the final head. If a 5 s timeout fails under load, re-run it, and report every run honestly.
- [ ] A blind `/review` of the PR returns APPROVED or SHIP, with every finding fixed or reconciled on the PR.
- [ ] The PR is queued with `mq add <pr>`, and the handoff is written.

## 5. Confirmation gates (ask Hein)

- Spending the third held-out run, lowering or redefining the §6.4 gate, or turning on either flag.
- Deleting client data:
  - the corpus;
  - `~/secure/ocr-bakeoff/` (8.3 GB of page renders from Ndzinga statements, no longer needed);
  - `~/secure/own-statements/` (whose are the "MVV PB1" statements?);
  - the statement zips in `~/Downloads`.
- Any GPU window (stopping `vllm-qwen`).
  - The velo cron `health-check.sh` restarts vLLM every 5 min.
  - `systemctl mask --runtime` does NOT work, because the unit lives in /etc.
  - The block that worked is a runtime drop-in, `/run/systemd/system/vllm-qwen.service.d/zz-gpu-window.conf` containing `[Service]` + `ExecStartPre=/bin/false`, then `daemon-reload`.
  - Coordinate with the IsaFlow sessions, and run nothing beside the 30B: a 3.5 GB neighbour OOM-killed it on 2026-10-17.

No corpus or model runs are needed for this goal.
