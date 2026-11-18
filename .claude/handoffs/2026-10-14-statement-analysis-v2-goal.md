# /goal — Statement analysis v2 ("OBSE parity"): 4 bank readers, categoriser + insights + expense flag, Excel export, tamper review (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-14-statement-analysis-v2-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§10) or a genuine external blocker. Loop until every Success Criterion (§9) is proven with evidence, then post the evidence on the PRs, open the PRs, write a handoff and stop.`

---

## §1 Mission

Bring CredaFlow's statement analysis to parity with OBSE (Optimized Bank Statement Extractor), building on
credit checks v1 (PR #54). OBSE offers four things: extraction, financial-health insights, fraud detection, and
integration. This goal builds four pieces:

1. **Text readers** for Nedbank, ABSA, Standard Bank and Discovery. Today these statements go to the vision
   model, which balances only 5 of 79 corpus files, so a person reads them all.
2. **A transaction categoriser.** On top of it:
   - a **financial-health panel** on the application;
   - a new REFER flag, **EXPENSE_UNDERSTATED**.
3. **An Excel export** of the read statement.
4. **A tamper-signal review** of the corpus cases v1 found.

"Built" means:
- real readers on real PDFs (synthetic fixtures in the repo, the Ndzinga corpus off-repo);
- real Postgres rows;
- RBAC, document-access logging and audit;
- panels exercised in a logged-in browser with screenshots;
- no mock data anywhere a user can see it.

The engine still never approves or declines. Every new output is evidence for a credit officer, or a REFER flag
that the officer clears.

**Not in scope:**
- **A machine API for statement data.** It is deferred until a named consumer exists (Hein, 2026-10-14). Do not
  build API keys or partner auth.
- **TymeBank, African Bank, scans and unknown banks.** They stay on the vision reader → MANUAL_REVIEW.

## §2 What already exists — do NOT redo

Base: `origin/main` (≥ `b7b9fa9`). The local main checkout is stale: always branch from `origin/main`, in a
**new worktree**, and run `npm ci --legacy-peer-deps` inside it.

- **Statement reader** `lib/statement-analysis/`. Read `lib/statement-analysis/.claude.md` first; its rules bind.
  - `analyse.ts`: pipeline. `textReader()` is an if/else over `readCapitec` / `readFnb`. `PARSER_VERSION = "statement-v1"`.
  - `detect-bank.ts`: regex markers; `TEXT_READER_BANKS = ["CAPITEC","FNB"]`.
  - `capitec.ts` reads `-layout` text. `fnb.ts` reads word boxes (`pdftotext -bbox`) via `layout.ts`.
  - `vlm-reader.ts` is the fallback. `balance-check.ts` is the oracle. `persist.ts` stores `StatementAnalysis`.
  - Transaction shape `types.ts`: `{date, description, amountCents (signed), balanceCents|null, page, nonPosting?}`. No category.
  - `fixtures/` + `scripts/generate-statement-fixtures.ts`: synthetic genuine and doctored PDFs ("T TESTER"); tests in `readers.test.ts`.
  - Corpus harness `accuracy/` (`README.md`, `run.ts`, `accuracy.integration.test.ts`):
    `RUN_STATEMENT_ACCURACY=1 STATEMENT_CORPUS_DIR=/home/hein/secure/ndzinga-corpus/bank_statement [STATEMENT_ACCURACY_REPORT=…] [STATEMENT_ACCURACY_VLM=1] npx vitest run lib/statement-analysis/accuracy/`.
    `run.ts` hard-codes Capitec + FNB in `textPassRate`.
- **Credit checks** `lib/credit-checks/`. Read `lib/credit-checks/.claude.md` first.
  - `policy.ts`: `DEBIT_ORDER_MARKERS`, `CREDIT_WORD_MARKERS`, `CREDIT_PROVIDERS`, `RETURNED_DEBIT_MARKERS`,
    `GAMBLING_MERCHANTS`, `PAYDAY_LENDERS`, `mentions()`.
  - `undisclosed-debt.ts`: `counterpartyKey()`. Also `risk-behaviour.ts`, `salary-match.ts`,
    `document-authenticity.ts`, `manual-review.ts`.
  - Wiring: `run-checks.ts`, `load-facts.ts`, `recompute.ts`, `evidence.ts`.
  - Approval gate:
    - `app/api/applications/[id]/decide/route.ts` recomputes, refuses with 409 while any flag is OPEN, and
      refuses `checks_stale`.
    - Trigger `LoanApplication_a0_guard_open_check_flags` is the backstop for **any** OPEN flag, so a new check
      code is gated automatically.
  - Schema: `ApplicationCheckFlag` (check `CreditCheck` enum, code, fingerprint, evidence Json).
    `enum CreditCheck { DOCUMENT_AUTHENTICITY SALARY_MATCH UNDISCLOSED_DEBT RISK_BEHAVIOUR MANUAL_REVIEW }`.
    `lib/credit-checks/credit-checks-migration.test.ts` reads the migration statically.
  - Tests: `db-enforcement.integration.test.ts`, `recompute.integration.test.ts` (`RUN_CREDIT_CHECKS_IT`).
- **API + UI**
  - `app/api/applications/[id]/checks/route.ts`: CREDIT_OFFICER, refuses cross-site, calls `logDocumentContentAccess`.
  - `components/applications/CreditChecksPanel.tsx`.
- **Declared expenses:**
  - `Client.monthlyExpenses` (Int, **cents**; the fixture `800_000` = R8,000);
  - `ClientExpenseBreakdown` (housing, transport, food, education, insurance, clothing, entertainment, medical, other).
- **xlsx pattern:** ExcelJS (`exceljs` ^4.4) in `app/api/reports/export/route.ts`.
- **Audit:** `logAudit` / `logAuditStrict` + `AuditAction` in `lib/audit.ts`.
- **Document access:** `logDocumentContentAccess` in `lib/document-auth.ts`.
- **Gates:** `npm run ci:quality`, `npm run ci:integration` (`scripts/ci-local.sh`); `scripts/run-integration-tests.sh`;
  `scripts/integration-baseline.txt` may only shrink.
- **Last v1 corpus numbers:** `.claude/handoffs/2026-10-13-credit-checks-v1.md` (TEXT Capitec+FNB 105/106; VLM 5/79).

## §2a Product decisions (already made by Hein, 2026-10-14 — build them, don't re-ask)

1. **Order and PRs.** Two PRs, each branched from `origin/main`. They are **not stacked**: stacked PRs #48/#50/#59
   piled up unmerged.
   - **PR A** `feat/statement-readers-v2`: the four bank readers, plus the tamper review report.
   - **PR B** `feat/statement-insights`: categoriser, insights panel, EXPENSE_UNDERSTATED flag, Excel export.
   - If PR A has merged when PR B starts, rebase PR B onto it. Otherwise PR B measures on the banks main can
     read and says so.
2. **Reader gates.**
   - Nedbank and ABSA: balance PASS on ≥ 95% of **bank-produced** corpus PDFs, TEXT method.
   - Standard Bank and Discovery: report N/N on every corpus file (only 6–7 each), with no threshold. Mark them
     "limited evidence" in `lib/statement-analysis/.claude.md` until 20+ files have been seen.
3. **Full scope for categories.** Categories feed a new REFER flag, never an auto-decision. They never change the
   affordability figure, and `lib/affordability/` is not touched.
4. **EXPENSE_UNDERSTATED rule.** The flag fires when **both** hold:
   - average monthly categorised *living* spend exceeds `Client.monthlyExpenses` by more than **R1,500**;
   - and the gap is more than **25%** of declared.

   What counts as living spend:
   - **Excluded:** transfers to own accounts, savings and investments, cash withdrawals, credit instalments
     (UNDISCLOSED_DEBT owns those), and uncategorised rows. They are shown in the panel but not counted, so a
     cash-heavy client is never flagged on a guess.
   - **Coverage:** below 28 days of statement coverage, no flag; the panel says why.
5. **Migration approved:** one additive enum value, `CreditCheck.EXPENSE_UNDERSTATED`. It ships in PR B, together
   with the code that writes it, and updates the static test that reads the migration. **No other schema change.**
   Categories are computed on read (a pure function of the stored transactions plus `CATEGORISER_VERSION`) and are
   not persisted. The flag's evidence records the categoriser version.
6. **Export RBAC:** CREDIT_OFFICER and up. Every download writes a `DocumentAccessLog` row (via
   `logDocumentContentAccess`) **and** an audit row (new `AuditAction` value, e.g. `STATEMENT_EXPORTED`).
7. **Ground truth without personal data reaching Claude** (Hein approved; he is Ndzinga's Information Officer). See §6.
8. **Corpus retention** is extended until v2 is accepted. Delete it only when Hein says so.

## §3 PR A — bank text readers

For each of Nedbank, ABSA, Standard Bank and Discovery:

1. **Learn the layout without reading content.**
   - Write a local script (keep it in the worktree under `scripts/`, committed, operating only on
     `STATEMENT_CORPUS_DIR`).
   - It prints **masked shapes only**: letters → `a`, digits → `9`. Column x-positions from `-bbox`, header lines,
     date and amount formats, Cr/Dr conventions, and page counts.
   - Pick `-layout` vs word boxes per bank on evidence. Proportional fonts drift, so prefer boxes (as FNB does).
2. **Synthetic fixture first.**
   - Extend `fixtures/synthetic.ts` / `dataset.ts` with a synthetic statement in that bank's masked shape
     ("T TESTER", invented amounts).
   - Add a genuine variant plus the doctored variants `doctor.ts` already makes, and regenerate with
     `scripts/generate-statement-fixtures.ts`.
   - Tests in `readers.test.ts`, written red first.
3. **Reader** `lib/statement-analysis/<bank>.ts`, ≤ 300 lines.
   - Wire it into `detect-bank.ts` (`TEXT_READER_BANKS`), `analyse.ts` `textReader()`,
     `EXPECTED_PRODUCERS` in `lib/credit-checks/policy.ts`, and `accuracy/run.ts` `textPassRate`.
   - [agent decides] whether a small reader registry replaces the if/else. Only do it if it makes the four
     additions shorter.
4. **Bump `PARSER_VERSION`** to `statement-v2` (the outputs change for the same bytes).
5. **Corpus run** (TEXT any time; VLM after 17:00 only). Report per bank and method.
   - The gates in §2a.2 apply.
   - Capitec and FNB must not regress (stay ≥ 105/106).
   - **Zero** BALANCE_MISMATCH / RUNNING_BALANCE_BREAK on genuine files under TEXT. Any new authenticity signal is
     listed by document ID, not tuned away.
6. **Tamper review** (goes into PR A's description and the handoff, not the code unless evidence says so).
   - For the 9 balance-break documents and the 7 that also carry incremental updates (IDs in
     `.claude/handoffs/2026-10-13-credit-checks-v1.md`), print **metadata only**: producer, creator, PDF
     revision count, creation vs modification date, and balance difference in cents.
   - For each, say whether the signal is explained by the reader or by the file.
   - If the new readers turn an old VLM-or-reader misread into a PASS, say so.
   - Do not loosen a threshold to clear a signal. A threshold change needs evidence from metadata, not from content.

## §4 PR B — categoriser

- **Module:** `lib/statement-analysis/categorise.ts` (or `lib/categorise/`, [agent decides]). It is a pure function
  `categorise(tx, ctx) → {category, rule}`, with `CATEGORISER_VERSION`.
- **Categories:** SALARY_INCOME, OTHER_INCOME, TRANSFER_OWN, SAVINGS_INVESTMENT, CASH_WITHDRAWAL, CREDIT_INSTALMENT,
  GAMBLING, RETURNED_DEBIT, BANK_FEES, plus living categories mapped to `ClientExpenseBreakdown`:
  - HOUSING, TRANSPORT (incl. fuel), FOOD (groceries), EDUCATION, INSURANCE, CLOTHING, ENTERTAINMENT, MEDICAL;
  - UTILITIES_TELECOM, which maps to "other";
  - UNCATEGORISED.
- **Single source of keywords.** The `policy.ts` lists move into or are imported by the categoriser, so the checks
  and the categoriser share one source.
- **Existing checks' behaviour must not change:**
  - every existing `lib/credit-checks/*.test.ts` stays green **unmodified**;
  - the v1 corpus flag set is identical before and after, compared by fingerprint, counts only.
- **Merchant dictionary:** public business names only, built from §6. Never a person's name.

## §5 PR B — insights, flag, export

- **API:** `GET /api/applications/[id]/statement-insights`.
  - CREDIT_OFFICER; cross-site refused; tenant-scoped.
  - `logDocumentContentAccess` for every statement it summarises.
  - Returns, per statement and combined for the client's statements in the same `since` window that
    `load-facts.ts` uses (keep that parity, or the decide route's `checks_stale` comparison breaks):
    - months covered;
    - money in and out per month;
    - average and lowest balance;
    - income regularity (salary credits found per month, day-of-month spread);
    - spend by category per month;
    - the uncategorised share;
    - living spend vs declared `monthlyExpenses`.
- **UI:** `components/applications/StatementInsightsPanel.tsx` on the application page, next to `CreditChecksPanel`.
  Use theme tokens (`--cf-*`), not hex, and recharts if a chart helps. Label the figures "From statement — estimate".
- **Flag:**
  - New check module `lib/credit-checks/expense-understated.ts`, wired through `run-checks.ts`.
  - The fingerprint includes the categoriser version.
  - Evidence rows: the months used, the living-spend total per category, declared, and the gap. It is gated by
    §2a.4 and by §6's accuracy gate (if the gate fails, ship the check disabled behind a constant and say so).
  - Clearing, TOTP and audit use the existing paths unchanged.
- **Export:** `GET /api/applications/[id]/statement-export` returns an `.xlsx`.
  - Sheets: Summary (per statement: bank, period, opening/closing, balance check, authenticity signals), Transactions
    (date, description, amount, balance, category, page), Monthly (in/out/category totals).
  - RBAC and logging per §2a.6.
  - A button on the insights panel.
  - Filename without client names (application reference + date).

## §6 Ground truth (corpus stays local; Claude sees only masked merchant strings)

1. **Merchant-list extractor:** a local script (committed under `scripts/`; its output goes to
   `/home/hein/secure/ndzinga-corpus-derived/`, never the repo).
   - Run every corpus statement through the TEXT readers. Normalise each **debit** description with
     `counterpartyKey()`.
   - Mask digits → `9`. Drop anything containing an `@`, a run of 6+ masked digits, or a string that also occurs
     as a credit from the same account.
   - Keep only keys seen for **≥ 3 distinct account holders**. The holder key is a local salted hash of holder +
     account last 4; the salt and the hashes never leave the box.
   - Output: `key \t row_count \t holder_count`.

   These are merchants, not people. **Claude may read this file**; it may read nothing else derived from the corpus.
2. **Split** the merchant list by a stable hash: about 60% dev, 40% held-out.
   - **Dev set:** the builder labels it and writes categoriser rules from it (patterns, not a lookup of held-out
     keys).
   - **Held-out set:** a **fresh subagent** that has not seen the rules labels it blind (no self-review). Its labels
     are the ground truth.
3. **Long tail** (rows not in the merchant list, mostly person-to-person transfers): the local vLLM at `VLM_API_URL`
   labels one sample of 10 statements blind, **after 17:00**. Report agreement with the categoriser as informative
   only; two machines agreeing is not accuracy.
4. **Accuracy gate for the flag:**
   - **Required:** on held-out merchant keys weighted by row count, the categoriser agrees with the blind labels on
     **≥ 95%** for CREDIT_INSTALMENT, GAMBLING, SALARY_INCOME and the living categories combined (a living-vs-not
     confusion counts as an error).
   - **Reported:** overall coverage (share of debit value categorised).
   - If the gate fails, iterate on the dev set. If it still fails, ship the flag disabled and report the numbers.
5. Update `lib/statement-analysis/.claude.md`'s corpus rule to name this exception exactly (masked merchant keys,
   ≥ 3 holders) and nothing wider.

## §7 Constraints

- **Corpus is real Ndzinga customer data.**
  - Never commit, print, paste or log names, ID/account numbers, or transaction text from it, apart from §6's
    merchant file.
  - Never send it to any model but the local one at `VLM_API_URL`.
  - Don't `Read` a corpus PDF or `cat` its text in this session.
  - Committed fixtures are synthetic only.
- **Code rules**
  - TypeScript only; files ≤ 300 lines; no `console.log` (use `console.error` / `console.warn` as `lib/` does); no
    empty catch.
  - Write each risky test so it fails first, and mutation-verify every guard.
  - Import the module under test statically.
- **Commits:** stage only the paths you changed. Never touch `main`, `fork/main` or `whitelabel/*`.
- **Shared vLLM:** any corpus vision run only after 17:00 SAST on weekdays.

## §8 Acceptance in the browser (seeded local DB, `npm run dev`; browser MCP tools, no Playwright in repo)

**PR A:**
1. Upload a synthetic Nedbank and a synthetic ABSA statement to a seeded client.
2. Confirm the application's checks panel shows no UNVERIFIED_READ for them.
3. Screenshot.

**PR B:**
1. Seed a client whose synthetic statement has living spend about R6,000/month against declared R3,000.
2. On the application, confirm:
   - the insights panel shows the monthly figures;
   - EXPENSE_UNDERSTATED is OPEN with evidence;
   - Approve is disabled.
3. Clear it with a reason; Approve becomes enabled.
4. Download the export, open the xlsx and check the three sheets.
5. Confirm the `DocumentAccessLog` and audit rows exist (query).
6. Screenshots of each state.

## §9 Success criteria (all required, with evidence on the PRs)

1. **Readers:** the §2a.2 gates, with a per-bank table on PR A. Capitec and FNB do not regress. Zero balance tamper
   flags on genuine files under TEXT.
2. **Doctored fixtures:** 100% of the doctored variants for all six banks raise DOCUMENT_AUTHENTICITY.
3. **Tamper review:** posted on PR A per §3.6.
4. **Categoriser:**
   - the §6.4 numbers are posted on PR B;
   - existing check tests are unmodified and green;
   - the v1 corpus flag set is unchanged (counts).
5. **Flag:**
   - unit tests for the R1,500/25%/28-day boundaries, each mutation-verified;
   - `RUN_CREDIT_CHECKS_IT` passes on a throwaway Postgres 16 (CLAUDE.md recipe, `docker rm -fv`), including:
     - the new enum value is migrated;
     - an OPEN EXPENSE_UNDERSTATED flag blocks approval through the trigger;
     - clear then approve → succeeds.
6. **Export:** route tests for RBAC (READONLY → 403), cross-site refused, tenant isolation, plus an access-log row
   and an audit row written per download.
7. **Gates:** in each worktree,
   - `npx tsc --noEmit`, `npm run lint`, full `npm test`;
   - the integration runner (baseline unchanged or shrunk);
   - `npm run claude-md:check && npm run agents:check` (after `npm run agents:mirror`).
8. **Browser acceptance** per §8, with screenshots on each PR.
9. **Review:** `/review-team` on each PR (each will exceed 500 lines), plus a blind security review. Fix to SHIP and
   post a reconciliation comment.

## §10 Confirmation gates — STOP and ask Hein

- A corpus vision run during 08:00–17:00 SAST Mon–Fri. Text-reader runs are fine any time.
- Anything touching Ndzinga production (72.61.197.178) or `ndzinga-lms`, including porting this code.
- Copying corpus files, or anything derived from them, anywhere other than `/home/hein/secure/`; any change to
  how they're stored; deleting the corpus.
- Any schema change beyond the one approved enum value.
- Any change to `lib/affordability/`, NCA document wording, or an existing check's thresholds.
- Building a machine API or API keys for statement data.
- Merging a PR or deploying anywhere: **open the PRs and stop**.

**At the end:**
- Write a handoff to `.claude/handoffs/` and update `.claude/handoffs/LATEST.md`.
- Update the auto-memory `project_credaflow_decision_engine.md` with what shipped, the per-bank numbers, the
  §6 gate result, and any tamper findings.
