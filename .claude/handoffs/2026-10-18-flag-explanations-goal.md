# /goal: flag explanations, shown once and in the right place (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-18-flag-explanations-goal.md to completion. Work autonomously through Spec → Build (TDD) → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§7) or a genuine external blocker. Loop until every Success Criterion (§6) is proven with evidence, then post the evidence on the PR, queue it with mq, write a handoff and stop.`

## 1. Mission

Statement AI feature B (flag explanations) says the same thing up to three times. Each
explanation card in the AI card (`components/applications/StatementAiCard.tsx`) has:

1. a heading with the flag code;
2. a first line that repeats the code: `GAMBLING (RISK_BEHAVIOUR): …`;
3. an "Evidence rows: S1-R2 … S1-R8 …" sentence, which repeats the "Rows cited" table.

The whole "Flags explained" list also repeats the **Credit checks** panel higher up the same
page (`components/applications/CreditChecksPanel.tsx`). That panel already shows each flag's
code, status, summary and evidence rows (`Evidence`).

**Target:** each flag's explanation appears once, inside that flag's row in the Credit checks
panel, as a collapsible "Why this was raised" block. It holds:
- what the rule checks;
- when it is raised;
- the policy threshold;
- the evidence figures (amount a month, monthly income, row total and so on).

It does not repeat the code, the check name or the rows, which the panel row already shows.
The "Flags explained" section leaves the AI card. The AI card keeps the summary (A) and
"Ask the statement" (C).

## 2. What exists: read before building

- Explanations are written by code, with **no model**:
  - `renderExplanation` is in `lib/statement-ai/render.ts`;
  - the facts come from `lib/statement-ai/facts.ts` and `flag-specs.ts`;
  - the plan is built in `generate.ts` (`buildPlans` gives `explanations[]`, figure-checked).
  - They are served by `GET /api/applications/[id]/statement-ai`, via `views.ts` `applicationAiView`.
  - Module notes: `lib/statement-ai/.claude.md`. Read it first.
- Who sees what:
  - The Statement AI GET is CREDIT_OFFICER+ and 404s when the tenant's `featureStatementAi` is off.
  - READONLY never sees Statement AI output (#178, Hein's decision).
  - The Credit checks panel mounts for `canReadChecks` (CREDIT_OFFICER+, page.tsx:250).
- Recent context:
  - #185 (merged 2026-10-18) added `lib/statement-ai/words.ts`, shared by the server and the browser.
  - #185 also added the phone layout (date and row under the payee) and `StatementAiAnswer.tsx`.
  - Evidence page for the earlier work: https://claude.ai/artifact/7aGUEwUyWPkMBHwvTcU85L
- Seeded check app: the Acme tenant, application with 5 flags: BALANCE_MISMATCH, GAMBLING,
  NO_PAYSLIP, RUNNING_BALANCE_BREAK and UNDISCLOSED_DEBIT_ORDER. Recreate it on a disposable DB
  (`scripts/it-db.sh up`, seed, set `featureStatementAi` on locally, upload the synthetic
  statement). The old `cf-ui-stmtai3` container has been removed.

## 3. Product decisions (made; do not reopen)

- One place per flag: the Credit checks panel row. Nothing about a flag is said twice on the page.
- The explanation stays **advisory and deterministic**:
  - No model is involved.
  - It never changes a flag, its status or the clear flow.
  - It never feeds `run-checks`, `recompute`, `load-facts` or `decide`.
  - `advisory-boundary.test.ts` must still pass.
- The explanation stays behind `featureStatementAi`, and READONLY never sees it.
  - Making it free for every lender is a pricing decision (§7).
  - With the flag off, or for READONLY, the panel looks exactly as it does today.
- The text is still written in `render.ts` and still figure-checked before it is shown.
  - Change `renderExplanation` so it no longer writes the code, check or row list.
  - Do not hide parts of the stored text in the browser.
- No credit-check rule, threshold, flag summary text or clear flow changes.

## 4. Build notes

- **Data:** the panel needs the explanation per flag code. Either:
  - fetch the Statement AI GET from the panel (only when the role allows; treat a 404 as "none"), or
  - add the explanations to the panel's own data behind the same flag and role check.

  Pick the one with fewer moving parts and say why in the PR.
- **Flags without an explanation:** a flag that has no explanation (a superseded flag, an
  explanation REJECTED by its figure check, a code with no spec) shows no block. It never shows
  "unavailable" noise in the checks panel.
- **Stale output:** if the explanation's facts are stale relative to the flag, follow the
  existing `stale` handling. Don't show a mismatched explanation silently.
- **AI card:** remove the "Flags explained" section and anything it alone used (`Rows cited`
  for explanations). Keep the summary's "Flags raised by the credit checks" claim.
- **Size and style:** files stay under 300 lines; use tokens, not hex; check light and dark at
  375 px with no sideways scroll.
- **Eval:** `scripts/statement-ai/eval.ts` checks B (57 explanations). Update its expectations
  to the new text and keep 0 rejected.

## 5. Guards that must keep holding

- Every figure in an explanation passes `checkFigures`; the raised-flags contradiction check still runs.
- READONLY: no explanation in the HTML and none from any API (403/404). Prove it in a real-PG IT test and in the browser.
- Flag off: no explanation anywhere, and the panel is unchanged. Cover this with a test.
- Cross-tenant: there is no path to another tenant's explanation.
- `DocumentAccessLog` and audit behaviour of the Statement AI GET are unchanged.

## 6. Success criteria (all with evidence)

1. In the browser, as LOAN_ADMIN, each of the 5 flags in the Credit checks panel has a
   collapsible "Why this was raised". The AI card has no "Flags explained" section. Nothing is
   repeated: the code once, the check once, the rows once. Screenshots: light and dark, desktop
   and 375 px.
2. As READONLY: no explanation anywhere, and the API refuses (403/404). Screenshots.
3. With the flag off: the panel is unchanged from main, and the AI card is absent.
4. Unit tests:
   - the new `renderExplanation` text has no code, check or row list, and still passes `checkFigures`;
   - the panel renders the block only when an explanation is present.
   Each new guard turns a test red when it is removed (mutation run recorded in the PR).
5. Real-PG IT suites (`RUN_STATEMENT_AI_IT=1`) cover the role and flag-off rules: all pass.
6. `npm run ci:quality` exits 0 on the final head. Run `npm run ci:integration` if any route or DB read changed.
7. Eval B: 57/57 OK, 0 rejected. There is no model call for B, so this can run any time. A–C are untouched, so no model eval is needed. If anything in A or C changes, model time is after 17:00 SAST on weekdays or at weekends, and never during a demo bake (`pgrep -af bake.sh`).
8. Blind `/review` SHIP. A breaker pass on the role and flag-off paths SHIPs.
9. Evidence is posted on the PR and added as a section to the evidence page above. The PR is queued with `mq add`. `.claude/handoffs/2026-10-17-statement-ai-done.md`, its LATEST.md line (own line only) and memory are updated.

## 7. Confirmation gates (stop and ask Hein)

- Making flag explanations visible without `featureStatementAi`, or to READONLY, which is a pricing or role decision.
- Any change to a credit-check rule, threshold, flag summary text, the clear flow, or NCA document text.
- Customer-facing copy that states what the feature does. UI labels are fine.
- Turning `featureStatementAi` on for a tenant on a live demo stack (demo.credaflow.com, fairscore.credaflow.com).
- Any third-party model API or new outbound host. Production deploys (none exist).

## 8. Gotchas from the last session

- Run the UI on `127.0.0.1`, not `localhost`: another app's auth cookie clashes there.
- Worktrees have no `.env`. Set `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`, `NEXT_PUBLIC_TENANT_SLUG=acme` and, if the model is needed, `VLM_API_URL` + `VLM_MODEL` (the id `/v1/models` serves).
- Use puppeteer from node_modules for screenshots. The Chrome extension times out on long pages. The theme key is `lms-theme`.
- Don't edit files while `ci:quality` runs: the result no longer counts.
- Merge only via `mq add <pr>`. Remove your worktree and IT container after the merge.
