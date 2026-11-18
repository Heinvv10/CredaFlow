# /goal — Statement analysis: switch EXPENSE_UNDERSTATED on + 3 engineering follow-ups (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-15-statement-v2-followups-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Measure → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§7) or a genuine external blocker. Loop until every Success Criterion (§6) is proven with evidence, then queue the PRs with mq, write a handoff and stop.`

## §1 Mission

Two deliverables.

**A.** Raise the statement categoriser to the §6.4 accuracy gate (≥ 95% on held-out merchant keys; it scores 90.2%
today) using deterministic rules **plus labels from the local vision-language model (vLLM)**. If the gate passes,
switch `EXPENSE_UNDERSTATED_ENABLED` on in the same PR. If an honest attempt cannot reach 95%, merge the gains
with the flag still off and report.

**B.** Close three engineering follow-ups: FNB's duplicate word-box helpers, bank detection that only looks at
markers in the statement header, and the flaky `scripts/demo/restore.test.ts`.

"Done" means:
- real code on `main`, merged through `mq`;
- tests that fail when the code is wrong (mutation-verified);
- the gate measured on the real corpus, with numbers posted on the PR;
- a browser check of any UI change;
- a blind review plus a breaker on every PR.

## §2 What already exists — do NOT redo

- **`main` = 93f28b01 or later.**
  - **Statement v2 (2026-10-14):** #72 added the Nedbank, ABSA, Standard Bank and Discovery readers; #73 added the
    categoriser, the insights panel, the xlsx export and EXPENSE_UNDERSTATED.
  - **Follow-ups merged 2026-10-15:**
    - #95: Word's hybrid-xref trailer no longer counts as INCREMENTAL_UPDATE (`lib/statement-analysis/pdf-revisions.ts`, `pdf-object-headers.ts`).
    - #96: an agreeing adjacent statement **annotates** FIRST/LAST_ROW_UNVERIFIED (`chainedWith`) but never clears it (`lib/credit-checks/statement-chain.ts`).
    - #98: the EXPENSE switch-on prerequisites are built:
      - a newer LIVING_SPEND_ABOVE_DECLARED supersedes the older OPEN one;
      - the decide route returns 409 `checks_stale_expenses`;
      - `Client.monthlyExpensesDeclaredAt` exists, and an explicit R0 is signalled by the Reg 23A justification.
- **Flag:** `lib/credit-checks/policy.ts:161` `EXPENSE_UNDERSTATED_ENABLED = false`, used in
  `lib/credit-checks/run-checks.ts:24`. Per its comment, the only remaining prerequisite is the §6.4 gate.
- **Categoriser:**
  - `lib/statement-analysis/categorise.ts` is a pure function, computed on read and never stored, versioned by
    `CATEGORISER_VERSION = "categoriser-v1"`.
  - Supporting files: `merchants.ts`, `categories.ts`, `insights.ts`.
  - Tests are in `categorise.test.ts` and `insights.test.ts`.
- **Gate tooling:**
  - `scripts/statement-categoriser-accuracy.ts <keys.tsv> <labels.tsv> [--show]`. `--show` is for the dev set only.
  - `scripts/statement-categoriser-corpus.ts coverage|longtail`.
  - `scripts/statement-merchant-keys.ts`.
  - Definition: §6.4 of `.claude/handoffs/2026-10-14-statement-analysis-v2-goal.md`. Read §6 in full before
    starting.
- **Corpus (real client data, off-repo):**
  - Statements are in `/home/hein/secure/ndzinga-corpus`.
  - `/home/hein/secure/ndzinga-corpus-derived/` holds `merchant-keys{,.dev,.heldout}.tsv`,
    `merchant-keys.{dev,heldout}.labels.tsv` and `holder-salt`.
  - The held-out labels are ground truth: a fresh subagent labelled them blind.
  - Rules in `lib/statement-analysis/.claude.md` apply: masked shapes and counts only; never print names, ID or
    account numbers, or transaction text. The masked merchant-key files are the one readable exception.
  - No model other than the local `VLM_API_URL` may see corpus text.
- **Measured baseline:** held-out gate 90.0 / 90.5 / 90.2 / 90.2%. Coverage is 31.4% of debit value. 187
  model-"living" rows are uncategorised, mostly P2P. The v1 corpus flag set has 484 flags, digest `1c37d2e49fe12bd2`.
- **Background-read pattern:** `lib/statement-analysis/persist.ts` (`allowVlm`, `retryFailed`). The vision reader
  is never called inside a staff request, and runs one vision read at a time per process. The model client is in
  `lib/statement-analysis/vlm-reader.ts` and `lib/vlm-extract.ts`.
- **Process facts:**
  - **Merging:** go through the central merge queue. Run `mq add <pr>`, watch with `mq status`. Don't run
    `gh pr merge`; the guard hook blocks it.
  - **Branches:** never push to `fork/main` or `whitelabel/*`. Work in your own worktrees, and run
    `npm ci --legacy-peer-deps` inside each.
  - **Load:** the box is often at load average 60–110. A test that times out at 5 s under that load counts only if
    it also fails when run alone.
  - **Integration containers:** use unique names and abort if `docker run` fails. Always tear down with
    `docker rm -fv`.

## §2a Product decisions (already made by Hein, 2026-10-15)

1. **Lift method:** use rules **plus local vLLM labels**. Rules come from the dev split only, and the held-out
   split stays blind.
2. **If the gate passes:** flip `EXPENSE_UNDERSTATED_ENABLED = true` in the same PR, then review and merge
   normally.
3. **If the gate misses after an honest attempt:** merge the gains, keep the flag off, report the best held-out
   score and what blocks it, and stop. Do not lower the gate. Do not tune against held-out keys.
4. **AI pricing-tier planning:** excluded from this goal. It needs a live grill-me with Hein.
5. **Corpus deletion:** excluded from this goal and gated (§7). Hein kept the corpus for this work.

## §3 A — Categoriser to the gate, then the flag

### A1. Rules first `[agent decides details]`

Iterate `merchants.ts` and `categorise.ts` against the **dev** set:
`npx tsx scripts/statement-categoriser-accuracy.ts <dev keys> <dev labels> --show`.

- Patterns, not lookups of individual keys.
- Bump `CATEGORISER_VERSION`.
- Never open held-out keys or held-out disagreements. Score held-out only through the script without `--show`.
- **Guard:** the existing check tests stay unmodified and green, and the v1 corpus flag digest is unchanged.

### A2. Model labels for what the rules leave UNCATEGORISED

What "real" means:

- **When it runs:** a background step after a successful read, like the vision path. It is never inside a staff
  request.
- **What the model sees:** each distinct transaction description the rules leave UNCATEGORISED. It sees the
  description only: no client name, no amounts.
- **Prompt:** constrained to the `Category` enum, at temperature 0. Anything outside the enum becomes
  UNCATEGORISED.
- **Model:** only `VLM_API_URL` / `VLM_MODEL`.
- **Concurrency:** the existing one-at-a-time-per-process guard applies.
- **Storage `[agent decides exact shape]`:** store the labels as model output keyed by description. A suggested
  shape is an additive, nullable `StatementAnalysis.modelCategories Json?` plus `modelCategoriesVersion String?`
  (model id + prompt version). Categories stay **computed on read**: rules first, then the stored model label for a
  rule-UNCATEGORISED row. So `categorise` stays pure given its inputs. Update the `.claude.md` rule that says
  categories are never stored, to describe exactly what is stored and why.
- **Privacy:** P2P descriptions contain people's names. Labels are stored per StatementAnalysis (tenant-scoped,
  deleted with it), never in a cross-tenant or global table.
- **Visibility:**
  - Any figure or flag evidence that used a model label says so ("model-assigned").
  - The LIVING_SPEND_ABOVE_DECLARED evidence lists which rows were model-labelled, so the officer can check them.
  - The flag still only routes to an officer and never declines (POPIA s71).
- **Failure:** model unavailable means no model labels. Rules alone apply, the panel says why, and nothing throws
  into a request.
- **Tests:**
  - a mocked model client, including off-enum, garbage, timeout and "unavailable" outputs;
  - the rules-first precedence;
  - the background-only invariant: a staff-request path never calls the model;
  - a real-PG integration test that the column round-trips and that the recompute uses it.

### A3. Measure the gate (after 17:00 SAST on weekdays only)

The model is shared with the demo bakes. Check that no demo bake is running first (memory:
project_credaflow_demo_simulator / fairscore). Never run a vLLM corpus job concurrently with one.

- **Score:** rules + model on held-out keys. The model labels the masked held-out keys blind, with the same prompt
  as tuned on dev.
- **Repeats:** run ≥ 3 times. **The gate passes only if the minimum run is ≥ 95%.**
- **Also report:** coverage (share of debit value) before and after, the dev score, and the long-tail agreement
  (informative only).
- **Post:** the numbers go on the PR as counts only.

### A4. Switch on (only if A3 passes)

- Flip the constant, and update the `policy.ts` comment to cite the measured runs.
- Run the RUN_CREDIT_CHECKS_IT suite with the check **on**: an OPEN flag blocks approval through the trigger, and
  clear-then-approve succeeds.
- Do a browser check on a seeded local DB (LOAN_ADMIN with TOTP):
  - an application whose statements exceed the declared expenses shows the flag with model-labelled rows marked;
  - check light and dark mode, desktop and 375 px;
  - screenshots go in the scratchpad and are not committed.

## §4 B — Engineering follow-ups (one small PR, or three)

- **B1:** `lib/statement-analysis/fnb.ts` keeps its own copy of the word-box helpers. Move it onto the shared ones
  in `word-table.ts`.
  - Guard: the FNB corpus TEXT reads stay 100% (corpus runner `lib/statement-analysis/accuracy/`, TEXT only).
  - Readers' tests must stay green.
  - No `PARSER_VERSION` bump unless the output changes, and then prove why.
- **B2:** `detect-bank.ts` matches bank markers over the whole text, where a payee can name another bank. Match
  header markers in the header region only.
  - Guard: every bank's corpus TEXT result is unchanged.
  - Add a synthetic test where an FNB statement has a payee "ABSA …" and it still routes to FNB.
- **B3:** `scripts/demo/restore.test.ts` flakes at high load ("DEMO_CLEAR_STAFF_TOTP … status expected 0, got 1").
  - Find the cause with instrumentation before proposing a fix: a timeout, a lock, or shared state.
  - Fix it so it passes 10/10 inside a full parallel `npm test`.
  - Other demo/lender tests flaked the same way today (`scripts/demo/specimens/specimens.test.ts`, `kits`,
    `scripts/lender/scripts-hardening.test.ts`, `scripts/__tests__/run-integration-tests-opt-in.test.ts`). If they
    share the cause, fix them in the same PR.

## §5 Review and merge process

- **Before each PR:** `npm run ci:quality` exits 0, or every failure is shown to pass when run alone. Run
  `npm run ci:integration` if the DB is touched. Run `npm run claude-md:check && npm run agents:check` (after
  `npm run agents:mirror`) when you edit a `.claude.md`.
- **Review:** run `/review` (a blind reviewer) plus a separately spawned **breaker** that writes repros in a temp
  clone. For A, the breaker targets these questions:
  - Can a hostile description inject into the prompt and steer a category?
  - Can a model label hide living spend?
  - Can the model be called inside a request?
  - Can labels leak across tenants?
- **Fix loop:** fix every finding and re-confirm with the same reviewer on the new head.
- **Stop rule:** if two rounds together produce more findings than round 1, stop hardening. Write down the scope
  boundary and move on.
- **Record and merge:** post the review outcome on the PR, then `mq add <pr>`.

## §6 Success criteria (all with evidence)

1. **A:** dev and held-out gate numbers (≥ 3 held-out runs) are posted on the PR, and the v1 flag digest is
   unchanged.
   - **Gate passed:** the flag is ON, the IT suite runs with the check on, and the browser screenshots have been
     viewed.
   - **Gate missed:** the flag is OFF, and the report shows the best score and the blockers.
2. **A2 invariants:** each one is mutation-verified (background-only, rules-first, off-enum → UNCATEGORISED,
   tenant-scoped storage).
3. **B1–B3:** merged. Corpus TEXT results are unchanged for B1/B2, and B3 passes 10/10 in full parallel runs.
4. **Every PR:** reviewed to SHIP or APPROVED by both the reviewer and the breaker, merged via `mq`.
5. **Wrap-up:** handoff written, with `.claude/handoffs/LATEST.md` pointing to it, and the memory
   `project_credaflow_decision_engine.md` updated.

## §7 Confirmation gates — STOP and ask Hein

- Any vLLM or vision corpus run during 08:00–17:00 SAST Mon–Fri, or while a demo bake is running.
- Deleting the corpus, or copying corpus-derived data outside `/home/hein/secure/`.
- Sending corpus text to any model other than the local `VLM_API_URL`.
- Lowering the 95% gate, changing its definition, or reading held-out disagreements.
- A destructive or non-additive migration.
- Anything touching Ndzinga production (72.61.197.178), `ndzinga-lms`, or a production deploy.
