# Statement AI goal: DONE through A–C, #163 MERGED 2026-10-17 14:20 UTC (2026-10-17 ~16:10 SAST)

Goal: `.claude/handoffs/2026-10-17-statement-ai-goal.md`. This replaces `2026-10-17-statement-ai-stopped.md`.
Worktree: `/home/hein/Workspace/CredaFlow-stmt-ai`, branch `feat/statement-ai-ask`.

## State

- **PR #163** (head `4819be1c`) MERGED via mq, 2026-10-17 14:20 UTC (merge `5711f533`).
  - #159 and #161 were closed; #163 replaces them, and the stack became one PR after the redesign.
  - Evidence: PR comment 6234847845.
- The feature flag `TenantConfig.featureStatementAi` defaults to off. No demo stack was touched and there is no deploy.
- **Design (Hein's choice after the stop rule):** structured outputs.
  - A: the model chooses claims and `render.ts` writes them.
  - B: deterministic; no model call.
  - C: the model plans typed queries and code computes the results.
- **Review:** reviewer **SHIP** and breaker **SHIP** on `4819be1c`, after rounds 4–5 and three confirm rounds.

## Evidence (detail in the PR comment)

- **Eval at `7fce3f8a`** (30 synthetic apps, 60 questions, 3 runs):
  - C exact 100/100/100;
  - 0 wrong figures shown;
  - A and B 0% rejected.
- **Latency per call:** summary 0.38 s median, ~836 tokens in / 22 out. Answer 0.63 s median, ~551 in / 38 out.
- **Gates:**
  - `ci:quality` exit 0 on `4819be1c`;
  - `ci:integration` exit 0 on `9d115786`;
  - statement-ai real-PG suites 13/13 on `4819be1c`.
- **Mutations:** every new guard fails a test when removed, except S3, the answer render guard, which only guards render.ts's own output.
- **Browser check** on `9d115786`, as LOAN_ADMIN and READONLY, dark and light, desktop and 375 px.
  - A local stand-in replaced the model's API because a demo bake held vLLM.
  - Screenshots are in the session scratchpad (`ui2-*.png`).

## Open

1. **Eval re-run on merged main `45609da5` DONE (2026-10-18):** C exact 100/100/100, 0 wrong shown, A 30/30 and B 57/57 OK; summary 0.39 s / answer 0.69 s median. Posted on #163.
2. **Tamper triage (§6): DROPPED (Hein, 2026-10-18).** Every tamper signal is already a DOCUMENT_AUTHENTICITY flag (BALANCE_MISMATCH, RUNNING_BALANCE_BREAK, INCREMENTAL_UPDATE, PRODUCER_UNEXPECTED, MODIFIED_AFTER_CREATION, HOLDER_NAME_MISMATCH, STALE_STATEMENT), and B already explains each one deterministically with its evidence rows. `pdf-revisions.ts` only counts saves; it does not record what a save changed. So §6 as written ("point at existing rule evidence in plain words") is what B does. New value would need new evidence (e.g. which pages or objects a later save changed), which is a detector change: a credit-check rule, gate §9.
3. **READONLY (Hein, 2026-10-18): hidden.** PR #178 makes the GET route CREDIT_OFFICER+ and mounts the card only for those roles. Blind review APPROVED, then SHIP on `643e5c02`; ci:quality exit 0; real-PG 13/13; mutation red. MERGED via mq 2026-10-18 06:14 UTC.
4. **Documented LOW limits:**
   - The payee word filters are blocklists. Quoting makes leftover words read as names.
   - Masking over-withholds some real merchants (SEVEN ELEVEN, TWO OCEANS).
   - Client-name masking is best effort.
5. **Pricing input:** the latency and token table above. Prices are Hein's to set (gate §9).

Infrastructure note: the IsaFlow OCR bench session stops `vllm-qwen` during its windows, and demo bakes hold it. Check both before any eval.

## 2026-10-18: browser check with the real model (Hein: "show me it's done")

- **Merged main failed in the browser.** "Ask the statement" with the real model returned "Answer unavailable" for per-month or per-payee breakdowns: the planner dropped `measure`. "Largest" lists were the first rows by date. Any list cut at its limit was refused, because the figure check did not know the "N rows match in all" count. The #163 eval asked no breakdown or list questions.
- **PR #181 fixes it** (head `e5ba383d`, MERGED 2026-10-18 10:14 UTC, 760dc199): planner example and prompt `ask-plan-3`; retry with the refusal reason; `list.order` (date/latest/largest); no payee filter on `groupByPayee`; `matchedRows` allowed by the figure check; eval breakdown questions added.
- **Guided decoding** (vLLM `json_schema`) was tried and dropped. It made the model fill in filters nobody asked for (84–87%).
- **Eval:** C exact 96.7/96.7/97.8% (min of 3 runs), 0 wrong shown; A 30/30; B 57/57. Answer median 0.84 s.
- **Gates:** ci:quality exit 0; real-PG 13/13. Blind review SHIP after 2 rounds.
- **Evidence page (screenshots, LOAN_ADMIN and READONLY, dark/light, desktop/375):** https://claude.ai/artifact/7aGUEwUyWPkMBHwvTcU85L
- **Gotchas:**
  - Another app on `localhost` overwrites the auth cookie ("no matching decryption secret"). Run the UI check on `127.0.0.1`.
  - The Chrome extension's screenshots time out on long pages. Use puppeteer (in node_modules).
- **Open:**
  - A two-part question can carry the first part's filter into the second (the answer is labelled with what it computed).
  - Old answers stay listed beside new ones.
  - Pre-existing on main: the stepper labels overlap at desktop width.

## 2026-10-18 afternoon: card layout (#185 MERGED 12:49 UTC, 909af281)

- Branch `feat/statement-ai-presentation`, head `705bfede`; worktree `/home/hein/Workspace/CredaFlow-ai-ui`.
- **What changed:**
  - Breakdowns and lists show as tables.
  - "How this was computed" is in words.
  - The summary is one claim a line (`summary-claims-4`) and shows as a list.
  - The input hash and the `[q1]` label on a one-query answer are gone.
  - Amounts read "R… out".
  - A failed answer is hidden once a newer answer to the same question succeeds.
  - On phones the date and row sit under the payee.
- **Card answer splitting:** the card splits an answer only when its text is exactly render.ts's `[qN] …` form; anything else shows as written.
- **Gates:** ci:quality exit 0. Blind review was NO-SHIP in round 1 (the splitter could drop text), then SHIP in round 2.
- **Browser check with the real model, after the fairscore bake:** 2 new questions were answered correctly, and the summary regenerated. Evidence page v2 has the screenshots.
- **Open:** flag explanations still repeat the code on their first line (Hein to decide).
- **Gotcha:** the worktree has no `.env`, so the dev server needs `VLM_API_URL` and `VLM_MODEL` set (the model id is the one `/v1/models` serves). Without them every ask FAILs as "model unavailable".
- **Cleanup:** done; the worktree and the container `cf-ui-stmtai3` are removed.

## 2026-10-19: flag explanations, once, in the Credit checks panel (#188 MERGED 032e7a62)

- **Goal:** `.claude/handoffs/2026-10-18-flag-explanations-goal.md`. Branch `feat/flag-explanations-in-checks`, head `e874c037`, worktree `/home/hein/Workspace/CredaFlow-flag-expl`.
- **What changed:**
  - Each open flag's explanation rides on the checks GET as `explanation`, behind `statementAiEnabled` and CREDIT_OFFICER (`views.ts flagExplanations`). It is matched by flag row id and shows as "Why this was raised" in that row.
  - `renderExplanation` writes no code, check, row list or row count that the table shows.
  - The AI card lost "Flags explained" and "Rows cited"; the Statement AI GET no longer returns `explanations`.
  - A failed explanation read degrades to no explanations, logged. The breaker found this case.
  - The eval has `--only-b` (no model, any time) and counts a text that repeats its row as not OK.
- **Gates on e874c037:**
  - ci:full exit 0 (20,103 unit; 368/370 integration suites passed, 2 opt-in).
  - Statement AI real-PG 17/17. Eval B 57/57. 15 mutations, each red.
  - Blind review SHIP. The breaker returned SHIP after round 1 (fixed in a14d89e0).
- **Browser** (local seeded Acme, doctored Capitec fixture, 7 flags including the goal's 5):
  - LOAN_ADMIN: the block shows on 7/7 flags, each code once per row, in light and dark at desktop and 375 px.
  - READONLY: no explanation anywhere; both APIs return 403.
  - Flag off: the panel DOM is byte-identical to the flag-on panel minus the blocks.
  - Evidence page v4: https://claude.ai/artifact/7aGUEwUyWPkMBHwvTcU85L
- **Gotchas:**
  - `prisma db seed` fails locally at the asset-finance trust deal unless `EXPERIAN_DRY_RUN=true`.
  - The per-email login rate limit trips after about 12 puppeteer logins; use the second LOAN_ADMIN seat.
  - Making a flag SUPERSEDED in a test: create it OPEN, then `updateMany` with `tenantId` (the trigger refuses an insert as SUPERSEDED).
- **Open (LOW, not done):**
  - The fallback logs the whole error (repo convention; there is no logger module).
  - Some specs (NO_PAYSLIP) restate the flag summary in other words.
  - The checks GET now also loads the insights for a Statement AI lender. This is not measured.
- **Cleanup:** done; worktree, branch and the containers `cf-it-flagexpl` / `cf-ui-flagexpl` are removed.

## 2026-10-19: flag explanation leftovers (#200 queued via mq, head 0ddc8e5f)

- **Goal:** `.claude/handoffs/2026-10-19-flag-expl-lows-goal.md`, all 4 items done. Branch `fix/flag-expl-lows`.
- **Changes:**
  1. The checks GET fallback logs only `error.name`.
  2. 16 specs in `flag-specs.ts` now give the rule and its reason instead of restating the summary. `flag-specs.test.ts` raises 26 flags through `runChecks`. It fails on ≥50% word overlap with the summary and runs every spec through the language and figure checks: "none", "one" and "single" are figure words, and buildPlans withholds a text that uses them.
  3. Checks GET cost: Statement AI on p50/p95 61/74 ms vs off 48/59 ms. That is +13 ms (1.27×), recorded and not optimised.
  4. Real-model reshoot. The hosted path from #190/#192 had never worked against the real API:
     - Anthropic 400s on `temperature`, so `sampling()` in `vlm-extract.ts` now sends none to a hosted model.
     - Sonnet reasons for about 252 tokens before its JSON on an unreconciled statement, so the summary cap went from 200 to 600 and the version to `summary-claims-5`.
- **Gates:**
  - ci:full exit 0: 20,135 unit; integration 368/370 files.
  - Real-PG Statement AI 19/19. Eval B 57/57 ×3. Hosted eval: A 2/2, C 6/6.
  - Blind review: REQUEST_CHANGES (spec accuracy, no retry of rejected summaries), then SHIP on 0ddc8e5f.
- **Evidence page v6:** https://claude.ai/artifact/7aGUEwUyWPkMBHwvTcU85L
- **Open (not done):**
  - On an unreconciled statement the model may pick the "money" claim, which renders as "money in R0.00". The renderer could drop that claim when nothing reconciles.
  - The real-model reshoot covers LOAN_ADMIN only; the READONLY and flag-off shots are still from 18 Oct, and nothing in those paths changed.
  - Demo stacks are untouched. Turning Statement AI on or pointing a stack at the hosted model is Hein's gate. Once #200 is live, every summary regenerates once (version bump).
- **Gotchas:**
  - `next start` warns under `output: standalone` but serves fine for local checks.
  - The hosted model ignores the shared-model window, but the eval still needs `ALLOW_MODEL_WINDOW=1`.
- **Cleanup:** done; worktree, local branch and containers `cf-ui-flaglows` / `cf-it-flaglows` are removed.

## 2026-10-19 evening: unreconciled summary (#211 queued via mq, head e88c9ad6)

- **Change:** when no statement reconciles, the money, months, salary, living, categories, uncategorised and payees claims render nothing. Coverage always leads with "No statement reconciles, so no money in, money out, salary or spend is counted from them." Version `summary-claims-6`.
- **Gates:**
  - ci:quality exit 0 (20,217 unit).
  - Mutations red: the null branch, and unshift changed to push.
  - Blind review SHIP.
- **Browser check:** local Acme with `capitec-balance-not-fixed.pdf` and hosted Sonnet. The card read flags, then the coverage reason, then balances, with no R0.00.
- **Open (LOW):**
  - With zero statements, the coverage line says "them".
  - FROM_RECONCILED is not type-tied to the claim union.
  - The READONLY and flag-off reshoots are still from 18 Oct.
- **Cleanup:** done; worktree and container `cf-ui-unrec` removed.
