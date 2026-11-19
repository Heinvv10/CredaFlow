# /goal — Credit checks v1: statement reader + 4 evidence checks + approval gate (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-13-credit-checks-v1-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then publish the evidence, open the PR, write a handoff and stop.`

---

## §1 Mission

Build a credit-decision **assist** layer. It reads an applicant's bank statements down to transaction
level, cross-checks them against the payslip, the declared debts and the bureau, and raises
**REFER flags with evidence**. A credit officer must clear every open flag, with a written reason,
before an application can be approved. The engine never approves or declines on its own; the
existing bureau and affordability gates stay the hard stops.

"Built" means:
- Real Postgres rows.
- Real readers run against real PDFs: synthetic fixtures in the repo, plus the Ndzinga corpus off-repo.
- Approval is refused in **both** the route and a database trigger.
- RBAC + TOTP-gated staff actions, audited through `lib/audit.ts`.
- A panel on the application page, exercised in a logged-in browser with a screenshot.
- No mock data anywhere a user can see it.

## §2 What already exists — do NOT redo

Base: `origin/main`. Work on branch `feat/credit-checks-v1` in a **new worktree** (`git worktree add ../CredaFlow-wt-checks -b feat/credit-checks-v1 origin/main`). Then `npm ci --legacy-peer-deps` inside it.

- **Payslip extraction**
  - `lib/vlm-extract.ts`, with `applyPayslipPostProcessing`. Fields: grossIncome, netIncome, totalDeductions, payDate, employerName. Cents; `validated` flag.
  - **Use only payslip money fields with `validated === true`.**
- **Bank statement extraction today:** identity and banking fields from page 1 only (`BANK_STATEMENT` prompt in `lib/vlm-extract.ts`). It reads no transactions and no balances. You are adding the reader, not replacing this.
- **PDF tooling**
  - The runtime image has `poppler-utils` (`pdftotext`, `pdfinfo`, `pdftoppm`) and `qpdf` (Dockerfile stage 3).
  - `lib/documents/pdf-decrypt.ts` removes statement passwords; reuse it.
  - Rendering helpers are in `lib/vlm-extract.ts` (`renderTargetPx`, `RENDER_DPI`, the crop-box handling).
- **Name matching:** `lib/ocr/name-matching.ts` (`areNamesSimilar`).
- **Declared debts:** the `ExistingDebtObligation` model (creditProvider, accountType, outstandingBalance, monthlyInstalment).
- **Bureau:** `lib/integrations/experian.ts` and `transunion.ts` sum instalments only; the account list survives only in the raw response (`rd.accounts`), stored on `CreditBureauCheck`. Live parsing is partly blocked on vendor spec; dry-run mode simulates. Extend the parsers to **return** the account list (subscriber, account type, instalment, status). Do not change any existing totals.
- **Gates and approval**
  - `lib/decision/bureau-gate.ts`, `lib/decision/affordability-gate.ts`, `app/api/applications/[id]/decide/route.ts` (LOAN_ADMIN, reckless-lending sign-off).
  - UI: `components/applications/ApplicationApprovePanel.tsx`.
  - Page: `app/(dashboard)/applications/[id]/page.tsx`.
- **Document upload and extraction entry points:** `app/api/documents/route.ts` and `app/api/documents/[id]/extract/route.ts`.
- **Compliance plumbing**
  - `lib/audit.ts` (every state change).
  - `lib/document-auth.ts` (document access writes `DocumentAccessLog`; showing statement transactions counts as document access).
  - `lib/totp.ts` and `lib/auth-guards.ts`.
  - `lib/permissions.ts`.
- **Accuracy harness pattern to copy:** `lib/ocr/accuracy/` (corpus outside the repo via env var; runs only with `RUN_VLM_ACCURACY=1`).
- **DB rules**
  - Baseline migration `prisma/migrations/20261009000000_baseline`.
  - Hand-written triggers need their static tests updated in `lib/db-baseline.test-helpers.ts`.
  - Integration runner `scripts/run-integration-tests.sh`; `scripts/integration-baseline.txt` may only shrink.
- **Separate, do not touch:** PR #51 (Reg 23A minimum-expense table) awaits legal sign-off and is not in scope.

## §2a Product decisions (already made by Hein, 2026-10-13 — build them, don't re-ask)

1. **The migration is approved.** It adds new tables, enums and an approval trigger. It is additive, and the trigger ships in the same PR as the code that clears flags.
2. **Open flags block approval.** LOAN_ADMIN clears each one with a reason of at least 15 characters. Each clearance is audited. Blocking is enforced in the route **and** by a DB trigger.
3. **Readers**
   - Digital PDFs: text readers for **Capitec and FNB**.
   - **Vision-model fallback** for photos, scans and every other bank.
   - A fallback read that fails the balance check raises a manual-review flag (`MANUAL_REVIEW/UNVERIFIED_READ`), **never** a tamper flag. A misread and a forgery look the same in that case.
4. **Triggers**
   - Read the statement on upload and on manual re-extract.
   - Recompute an application's flags when staff open the checks panel, and again inside the approve decision.
   - Persist everything.
5. **No auto-decision.** No score, no approve/decline recommendation, no LLM-written narrative in v1.
6. **The outcome back-test is out of scope.** Ndzinga had 4 loans at 30+ days past due as of 2026-10-13, which is too few.

## §3 Data model (recommended — keep the names unless a collision forces a change)

```prisma
enum StatementReadMethod { TEXT VLM }
enum StatementReadStatus { READ UNREADABLE UNSUPPORTED }
enum BalanceCheck { PASS FAIL NOT_APPLICABLE }

model StatementAnalysis {            // one per ClientDocument content version
  id                 String @id @default(cuid())
  tenantId           String
  clientDocumentId   String
  contentSha256      String           // ties the read to exact bytes; re-read on change
  parserVersion      String
  method             StatementReadMethod
  status             StatementReadStatus
  bank               String?          // normalised: CAPITEC, FNB, NEDBANK, ABSA, …
  accountHolderName  String?
  accountNumberLast4 String?
  periodStart        DateTime?
  periodEnd          DateTime?
  openingBalanceCents BigInt?
  closingBalanceCents BigInt?
  transactions       Json             // [{date, description, amountCents, balanceCents?, page}]
  balanceCheck       BalanceCheck
  balanceDiffCents   BigInt?
  authenticity       Json             // {producer, creator, createdAt, modifiedAt, incrementalUpdates, signals[]}
  createdAt          DateTime @default(now())
  @@unique([clientDocumentId, contentSha256, parserVersion])
}

enum CreditCheck { DOCUMENT_AUTHENTICITY SALARY_MATCH UNDISCLOSED_DEBT RISK_BEHAVIOUR MANUAL_REVIEW }
enum CheckFlagStatus { OPEN CLEARED SUPERSEDED }

model ApplicationCheckFlag {
  id            String @id @default(cuid())
  tenantId      String
  applicationId String
  check         CreditCheck
  code          String            // e.g. BALANCE_MISMATCH, NO_SALARY_CREDIT
  fingerprint   String            // stable hash of (code + evidence key) → idempotent recompute
  status        CheckFlagStatus @default(OPEN)
  summary       String            // one plain sentence for the officer
  evidence      Json              // {documentId, page, transactionIndexes[], amounts…} — no free-text PII beyond what the doc holds
  raisedAt      DateTime @default(now())
  clearedById   String?
  clearedAt     DateTime?
  clearReason   String?
  @@unique([applicationId, fingerprint])
}
```

- Tenant scoping: register both models with the Prisma tenant-scope extension (`lib/tenant-scope.ts`).
- Recompute semantics:
  - Same fingerprint already CLEARED → stays CLEARED.
  - Same fingerprint no longer raised → `SUPERSEDED`.
  - New evidence → new OPEN row.
- **DB enforcement (hand-written SQL in the new migration):**
  - A trigger on `LoanApplication` refuses a transition to APPROVED while an OPEN flag exists for it.
  - A CHECK requires `clearedById`, `clearedAt` and `clearReason` (≥15 chars) when status = CLEARED.
  - Update the static migration tests.
  - Add `RUN_CREDIT_CHECKS_IT` integration tests that prove both against a migrated database.
- `[agent decides]` exact column types, indexes, whether `transactions` is JSON or a child table.

## §4 Statement reader — `lib/statement-analysis/`

- **Pipeline:** decrypt (`pdf-decrypt.ts`) → `pdfinfo` + raw scan (authenticity facts) → detect bank → text reader if CAPITEC or FNB and the PDF has a text layer → else VLM reader → balance check → persist `StatementAnalysis`.
- **Text readers:** `pdftotext -layout`; one module per bank (`capitec.ts`, `fnb.ts`), each under 300 lines. They parse opening/closing balance, period, account holder, last 4 digits of the account number, and every transaction with its page.
- **Balance check:** opening + Σ amounts = closing (±1 cent). Where a running balance exists, also check each row: previous balance + amount = balance. This is the oracle for reading accuracy **and** the strongest tamper signal on digital PDFs.
- **VLM reader**
  - Render **all pages**; today's code renders page 1 only.
  - Prompt for the same JSON shape, then run the same balance check.
  - Method = VLM.
  - The vision model is shared on velo-server: unit tests mock it. **Corpus VLM runs happen only outside 08:00–17:00 SAST Mon–Fri** (§9).
- **Synthetic fixtures (committed)**
  - Generate Capitec-like and FNB-like statement PDFs with `pdf-lib` from obviously fake data, laid out like the real ones. Learn the layout from the corpus, but copy no real values, names or account numbers.
  - Generate doctored variants:
    - an amount edited via an incremental update;
    - a statement re-saved through a different producer;
    - a transaction changed without fixing the balance;
    - a statement whose ModDate is later than its CreationDate.
- **Corpus accuracy harness:** `lib/statement-analysis/accuracy/`
  - Gated by `RUN_STATEMENT_ACCURACY=1`; reads `STATEMENT_CORPUS_DIR=/home/hein/secure/ndzinga-corpus`.
  - Reports per bank × method: files, READ, balance PASS %.
  - Prints only counts and document IDs, never names, numbers or transactions.

## §5 The four checks — `lib/credit-checks/`

Each check is a pure function: (application facts) → flag candidates. A single
`recomputeApplicationFlags(applicationId)` loads the facts, runs all checks and upserts flags in one
transaction. All thresholds and merchant lists live in **one** file, `lib/credit-checks/policy.ts`
(`[agent decides]` values, each with a comment giving the reason).

1. **DOCUMENT_AUTHENTICITY**
   - Codes: BALANCE_MISMATCH (TEXT method only), RUNNING_BALANCE_BREAK, INCREMENTAL_UPDATE, PRODUCER_UNEXPECTED, MODIFIED_AFTER_CREATION, HOLDER_NAME_MISMATCH (vs the client, `areNamesSimilar`), STALE_STATEMENT (ends > 45 days before the application date).
   - Learn each bank's expected producer/creator strings from the corpus, and record them as a per-bank allow-list in `policy.ts`.
2. **SALARY_MATCH**
   - For each month the statement covers, look for a credit within ±5 days of the payslip pay date, within 2% or R50 of the validated net pay.
   - Codes: NO_SALARY_CREDIT, SALARY_AMOUNT_MISMATCH, PAYSLIP_UNVALIDATED (the money fields failed `validated`).
3. **UNDISCLOSED_DEBT**
   - Group recurring debits (debit orders / same counterparty) by counterparty.
   - Match them against `ExistingDebtObligation.creditProvider` and the bureau account subscribers (fuzzy name, instalment ±10%).
   - Code: UNDISCLOSED_DEBIT_ORDER, raised for a credit-like counterparty with no match. Credit-like means it appears on the credit-provider list in `policy.ts`, or its description has LOAN/FINANCE/CREDIT/LENDING markers.
4. **RISK_BEHAVIOUR**
   - Codes: RETURNED_DEBIT (bank-specific unpaid/returned markers), GAMBLING (merchant list; a threshold as a % of income), PAYDAY_LENDER (short-term lender list).
5. **MANUAL_REVIEW**
   - Codes: UNVERIFIED_READ (VLM balance FAIL), UNREADABLE, NO_STATEMENT.

## §6 API + UI

- `GET /api/applications/[id]/checks`
  - Recomputes, then returns flags.
  - Requires the existing application-read permission.
  - Returns transaction evidence only through `lib/document-auth.ts`, which writes `DocumentAccessLog`.
- `POST /api/applications/[id]/checks/[flagId]/clear`
  - Requires LOAN_ADMIN and a TOTP-verified session; reason ≥ 15 characters.
  - Audit row via `lib/audit.ts`.
  - 409 if the flag is not OPEN.
- **Decide route:** recompute inside the approve path. Refuse with a typed error and a 409 that lists the open flags. The DB trigger is the backstop.
- **UI:** `components/applications/CreditChecksPanel.tsx` on the application page.
  - Flags are grouped by check, each with a one-line summary and evidence: document link, page, the specific transactions.
  - A Clear dialog with the reason field.
  - `ApplicationApprovePanel` shows "N open checks" and disables Approve.
  - Use the `--cf-*` tokens only, and keep the palette-contrast test green.

## §7 Constraints

- **Corpus**
  - Corpus = real Ndzinga customer data. **Never commit, print, paste or log** names, ID numbers, account numbers or transaction descriptions from it.
  - Never send it to Claude or any external API. The local VLM at `VLM_API_URL` on velo-server is the only model allowed to read it.
  - Committed fixtures are synthetic only.
  - Don't open corpus files in this session's context (no `Read` of a corpus PDF, no `cat` of `pdftotext` output from it). Inspect corpus layouts only through scripts that print structure: column positions, masked shapes (`a`/`9`), counts.
- **Code rules**
  - TypeScript only; files ≤ 300 lines; no `console.log`; the repo has no logger module, so use `console.error`/`console.warn` as existing `lib/` code does; no empty catch.
  - Write each risky test so it fails first, and mutation-verify every guard: remove the guard and watch the test go red.
- **Commits:** stage only the paths you changed. Never touch `main`, `fork/main` or `whitelabel/*`.

## §8 Success criteria (all required, with evidence in the PR)

1. **Reader accuracy (corpus, after hours):** balance PASS on ≥ 95% of Capitec + FNB digital PDFs, via the TEXT method. Report counts per bank. Report the VLM-method PASS % for the rest; that figure is informative, with no threshold.
2. **Tamper detection:** 100% of the doctored fixtures raise a DOCUMENT_AUTHENTICITY flag.
3. **No false tamper flags:**
   - Run the corpus statements through the authenticity check alone: 0 genuine statements get BALANCE_MISMATCH or RUNNING_BALANCE_BREAK under the TEXT method.
   - Any other authenticity signal that fires on a corpus file is **listed by document ID for Hein**, not tuned away. It may be a real forgery.
4. **Checks:** every check code has unit tests on synthetic facts, red-first, mutation-verified.
5. **DB enforcement:** `RUN_CREDIT_CHECKS_IT` passes against a throwaway Postgres 16 (CLAUDE.md recipe):
   - approve with an OPEN flag → rejected by the trigger;
   - CLEARED without a reason → rejected by the CHECK;
   - clear then approve → succeeds.
6. **Gates:** `npx tsc --noEmit`, `npm run lint`, full `npm test`, the integration runner (baseline unchanged or shrunk), and `npm run claude-md:check && npm run agents:check` if any `.claude.md` was added.
   - Add `lib/statement-analysis/.claude.md` and `lib/credit-checks/.claude.md` (≤ 50 lines each) with the module rules, and run `npm run agents:mirror`.
7. **Browser acceptance (seeded local DB, `npm run dev`):**
   - Log in as seeded staff.
   - Open an application whose client has a synthetic statement that triggers at least one flag.
   - Confirm the flag shows with evidence, and Approve is disabled.
   - Clear it with a reason; Approve becomes enabled.
   - Screenshots of both states are attached to the PR. Use the browser MCP tools if no Playwright is installed.
8. **Review:** run `/review-team` (the diff will exceed 500 lines) plus a security review. Fix to SHIP, and post a reconciliation comment on the PR.

## §9 Confirmation gates — STOP and ask Hein

- Any corpus VLM run during 08:00–17:00 SAST Mon–Fri. Wait until after hours or ask; text-reader runs are fine any time.
- Anything that would touch Ndzinga production (72.61.197.178) or `ndzinga-lms`, including porting this code.
- Copying corpus files anywhere other than `/home/hein/secure/`, or any change to how they are stored.
- Merging the PR or deploying anywhere: **open the PR and stop**.
- A change to NCA document wording or to `lib/affordability/mle.ts`.

At the end:
- Write a handoff to `.claude/handoffs/`.
- Update `.claude/handoffs/LATEST.md`.
- Update the auto-memory file `project_credaflow_decision_engine.md` with what shipped and any authenticity signals found in the corpus.
