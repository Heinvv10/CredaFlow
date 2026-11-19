# /goal — Statement AI: advisory summary, flag explanations and "ask the statement" (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-17-statement-ai-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then post the evidence on the PRs, queue them with mq, write a handoff and stop.`

## 1. Mission

Build a paid, per-lender **Statement AI** option on the statement insights a credit officer
already sees. There are three features:

- **A.** A narrative statement summary.
- **B.** A plain-language explanation for each credit-check flag.
- **C.** "Ask the statement": the officer asks a question, the model chooses read-only queries
  over the parsed transactions, code computes the figures, and every figure shows its query
  and matching rows.

Tamper triage (§6) comes last. The model categoriser is NOT part of this goal: it stays
`MODEL_LABELS.enabled = false` until it passes the §6.4 gate.

The rules stay the credit decision. Every AI output is **advisory**: it is stored, audited and
shown beside the rules' panel, never instead of it. It never sets, clears, softens or
re-orders a flag, and it never feeds `run-checks.ts`, `recompute.ts` or the decide route
(POPIA s71). "Built" means:

- real DB rows and real API routes, with RBAC;
- a TenantConfig flag;
- the real local model at `VLM_API_URL`, used after hours only;
- mutation-verified tests;
- a logged-in browser check.

## 2. What already exists — do NOT redo

- Insights pipeline: `lib/statement-analysis/insights.ts` (`computeInsights`),
  `lib/credit-checks/statement-insights.ts` (`applicationStatementInsights`, persisted
  reads only), `app/api/applications/[id]/statement-insights/route.ts`,
  `components/applications/StatementInsightsPanel.tsx`.
- Flags and evidence: `lib/credit-checks/run-checks.ts`, `evidence.ts`, `policy.ts`, `types.ts`.
- Model plumbing: `lib/vlm-extract.ts` (`getVlmConfig`, `parseVlmResponse`). Background-only
  model use is in `lib/statement-analysis/persist.ts` and `model-labels.ts`. Copy their
  rules: the model is never called inside a staff request, one run per process, and output is
  versioned by a prompt-version constant whose hash is pinned in a test.
- Privacy precedent: `model-labels.ts` sends only `counterpartyKey()` masked keys (digits → 9,
  first three words). The model never sees a client name, ID number, account number or
  reference number. Keep that boundary for every feature here.
- Feature flags: `TenantConfig` in `prisma/schema/tenancy.prisma` (`featureAssetFinance`
  pattern, line ~215), `resolveFeatureFlags` in `lib/tenant.ts`.
- Audit actions registry: `lib/registry/audit-actions/030-credit-checks.ts` and its
  snapshot `lib/registry/__snapshots__/audit-actions.json`.
- Module rules: `lib/statement-analysis/.claude.md`. Read it first.

## 2a. Product decisions (already made by Hein, 2026-10-17 grill)

1. Scope: A, B and C are all in, built fully. Tamper triage comes last. The categoriser is excluded.
2. **The model never does arithmetic.** In A and B it writes prose around figures it is
   given. In C it chooses queries and code computes them.
3. **Numbers post-check:** every number, amount, percentage and date in any model output must
   equal a supplied fact or a query result. If any doesn't, the output is discarded and stored
   as `REJECTED` with the reason, and the officer sees "Summary unavailable". An unchecked
   output is never shown.
4. **No contradicting a flag:** an output that calls a flagged item acceptable, normal or
   resolved is rejected. Write a deterministic check against the flag list. Prompts alone
   aren't enough.
5. Inference runs only on a model we control: the self-hosted `VLM_API_URL` today, and a rented
   cloud GPU later through the same env var. **Never a third-party API.** No new outbound
   host.
6. Per lender: a new `TenantConfig.featureStatementAi Boolean @default(false)`. Only a
   SUPER_ADMIN can switch it, and the change is audited.
7. Pricing is **per statement analysed**. This goal only *meters* it (§5). No billing.

## 3. Feature A — statement summary

- **Input:** the insights figures plus the flag list with evidence-row counts, plus masked
  counterparty keys for the top merchants. Nothing else.
- **Generation:** a background job when a statement read lands or the flag set changes, and
  only for tenants with the flag on. Store it in a new `StatementAiOutput` model in
  `prisma/schema/credit-checks.prisma`, with these fields:
  - tenantId, applicationId, kind (SUMMARY | FLAG_EXPLANATION | ANSWER), flagCode?, input hash,
    promptVersion, status (OK | REJECTED | FAILED), rejectReason?, text, citations Json, createdAt.
  - A unique key on (tenantId, applicationId, kind, flagCode, inputHash, promptVersion).
  - The migration is additive and nullable-safe.
- **Display:** an "AI summary — advisory" card beside the insights panel. Show its input hash
  and generated time; when facts change, show it as stale.

## 4. Feature B — flag explanations

- One explanation per raised flag. It cites the flag's evidence rows (by row reference, never
  raw text) and the policy threshold from `policy.ts`.
- The same post-checks as A apply, plus one more: it must name the flag's actual code and
  direction, and must not state a threshold other than the policy value.

## 5. Feature C — ask the statement

- A staff POST route (LOAN_ADMIN and CREDIT_OFFICER; READONLY can read past answers but cannot
  ask), rate-limited per user and per tenant.
  - The route **enqueues** the question; it does not call the model inside the request.
  - The answer is polled.
  - Exception path, `[agent decides]`: if the queue makes it unusable, a separate worker is
    acceptable. A model call inside a Next.js request handler is not.
- Tools the model may call, all read-only over that application's persisted transactions and
  scoped by tenantId and applicationId:
  - sum/count/avg by filter (category, masked key, date range, sign, amount range);
  - group by month or by masked key;
  - list matching rows (row references plus masked key, date and amount).
  - No free-form SQL; the model never builds SQL text. Use typed tool arguments validated
    with zod.
- Every figure in the answer must come from a tool result in that run. Enforce it with the §2a.3
  post-check. Store each tool call and its result as citations, and have the UI show
  "how this was computed" with the matching rows.
- **Metering:** a `StatementAiUsage` row per model call (tenantId, kind, tokens in/out if the
  server returns them, latency ms). Add a per-tenant monthly count query. It is used for
  pricing later; it never blocks a call.

## 6. Tamper triage (last; build only if A–C are merged)

This only *points at* existing rule evidence (`document-authenticity.ts`, `pdf-revisions.ts`,
balance-check results), in plain words. It never says "tampered" or "genuine" on its own
authority. A vision read is never tamper evidence (module rule). If time is short, record it as
the next goal and stop.

## 7. Guards that must keep holding

- `MODEL_LABELS.enabled === false`. The categoriser accuracy gate and corpus rules in
  `lib/statement-analysis/.claude.md` stay unchanged.
- There are no imports from the new module into `run-checks.ts`, `recompute.ts`, the decide route or
  `load-facts.ts`. Add a static import-graph test **and** mutation-verify it.
- Document access: showing citations that reference statement rows goes through the same
  document-access logging as the insights panel (`lib/document-auth.ts` / `DocumentAccessLog`).
- Cross-tenant: a question or output for tenant A can never read tenant B's rows. Write a
  real-PG test.
- Corpus (real client data) is never used to build or evaluate these features. Fixtures are synthetic.
- vLLM work (dev runs, evaluations) happens only after 17:00 SAST on weekdays, or at weekends, and
  only with no demo bake running. Check with a script:
  `pgrep -f '^(timeout [0-9]+ )?bash scripts/demo/bake\.sh'` and `'^node .*scripts/demo/simulate\.ts'`.
  Unit tests mock fetch.

## 8. Success criteria (all with evidence)

1. Prisma migration for `featureStatementAi`, `StatementAiOutput` and `StatementAiUsage`. It
   applies cleanly on a disposable PG (`scripts/it-db.sh`, teardown with `docker rm -fv`).
2. Post-check tests:
   - an altered number, an extra date and a "this flag is fine" sentence are each rejected;
   - remove the check (the mutation) and each test goes red;
   - record the mutations in the PR.
3. A real-PG test per feature: flag off means no generation and a 404/feature-off from the
   routes; flag on means stored rows. Cross-tenant isolation. READONLY cannot ask.
4. An evaluation set of ≥30 synthetic applications with known figures and ≥30 questions with
   known answers. Feature C's answers are numerically exact on ≥95% (min of 3 runs), and the
   post-check rejected the rest (nothing wrong was shown). Score A/B on 0 wrong numbers shown.
   Report rejection rates.
5. Measured latency and tokens per statement on the local model. Put the numbers in the PR;
   they are the pricing input.
6. A browser check on a seeded local DB as LOAN_ADMIN and as READONLY. Cover:
   - the summary card, flag explanations, and an asked question with its "how computed" rows;
   - dark and light, desktop and 375px;
   - screenshots in the scratchpad only.
7. `npm run ci:quality` and `npm run ci:integration` exit 0. `agents:mirror`, then
   `claude-md:check` and `agents:check`. Add a short `lib/statement-ai/.claude.md` (or the
   module name you choose) with the advisory rules.
8. Review: run `/review` (blind) and a separate breaker writing repros in a temp clone. Attack
   surfaces:
   - prompt injection via transaction descriptions and masked keys;
   - a number that slips past the post-check (formatting such as "R1 2k", words, percentages);
   - cross-tenant leakage;
   - a model call inside a request;
   - an advisory output influencing a decision.
   Fix loop until both say SHIP. Stop rule: if rounds 2 and 3 together exceed round 1, stop
   and record the scope.
9. PRs merged via `mq add` only (never `gh pr merge`). Write a handoff and point
   `.claude/handoffs/LATEST.md` at it (your own line only). Update memory
   `project_credaflow_sacrra.md` (the AI tier section).

Split into PRs that each pass the gates: schema+flag+post-check core → A+B → C → triage.

## 9. Confirmation gates (stop and ask Hein)

- Any third-party model API or new outbound host.
- Turning `featureStatementAi` on for any tenant on a live demo stack (demo.credaflow.com and
  fairscore.credaflow.com). Local seeded DBs are fine.
- Any change to a credit-check rule, policy threshold, NCA document text or the categoriser gate.
- Prices, billing, or customer-facing copy that states what the feature does. UI labels are fine.
- Production deploys (none exist; don't create one).
