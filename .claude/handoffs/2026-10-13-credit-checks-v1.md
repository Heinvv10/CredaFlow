# Handoff — credit checks v1 (2026-10-13)

**Goal file:** `.claude/handoffs/2026-10-13-credit-checks-v1-goal.md`
**Branch / worktree:** `feat/credit-checks-v1` in `/home/hein/Workspace/CredaFlow-wt-checks`
**PR:** #54 MERGED by Hein's instruction (main = `f040f3c`, CI green on `d4778a0`)
**Evidence page:** deleted (the link in the PR was removed). Reconciliation: https://github.com/Heinvv10/CredaFlow/pull/54#issuecomment-6148086796

## Status
Every §8 criterion is met, with evidence on the PR. The one exception is the vision-model corpus run, which is informative only and is recorded below once run after 17:00. Review loop: `/review-team` → 6 breaker + fix-review rounds → final blind security review → fixes in `f68ab32` → blind re-review (result on PR). The reconciliation comment on the PR lists every finding and its fix.

## What shipped
- **Statement reader** (`lib/statement-analysis/`):
  - Capitec and FNB text readers (FNB reads word boxes).
  - The local VLM handles every other bank, scans and photos (12-page cap).
  - Persisted as `StatementAnalysis` per (bytes, parser version).
  - Reads run in the background on upload and re-extract, through a serial queue capped at 20 waiting per tenant.
  - Authenticity signals: producer/creator, incremental updates (counted before intake decryption), dates, balance identity.
- **Checks** (`lib/credit-checks/`):
  - DOCUMENT_AUTHENTICITY, SALARY_MATCH, UNDISCLOSED_DEBT, RISK_BEHAVIOUR, plus MANUAL_REVIEW codes.
  - They raise REFER flags (`ApplicationCheckFlag`) with evidence rows. There is no score and no auto-decision.
- **Gate:**
  - The decide route recomputes and returns 409 while any flag is open.
  - It re-counts under the row lock and refuses `checks_stale` on new evidence.
  - Trigger `LoanApplication_a0_guard_open_check_flags` is the backstop.
  - Flags cannot be deleted, a CLEARED flag is immutable, and CLEARED requires a reason of at least 15 characters (CHECK).
- **Clearing:** LOAN_ADMIN, a TOTP-verified session and a reason; audited (`CREDIT_CHECK_FLAG_CLEARED`).
- **UI:** `CreditChecksPanel` on the application page. Approve is disabled while checks are open.
- **Bureau parsers** return account lists (`obligations.accounts`); totals are unchanged.

## Corpus results (real data stayed in /home/hein/secure; only counts were printed)
- TEXT, Capitec + FNB bank-produced: **105/106 (99.1%)**. The 106th is a Capitec PDF the text reader can't read; the text-only run skipped it and reported 105/105. All Capitec + FNB PDFs: 110/119; all 9 failures are non-bank-produced (Word ×6, airSlate, pypdf, no producer).
- VLM: 5/79 (6.3%); see "VLM run" below.
- Authenticity signals on corpus documents. These are for Hein to review; they were NOT tuned away. The IDs are ClientDocument IDs in the source system.
  - BALANCE_MISMATCH and RUNNING_BALANCE_BREAK (9 each): cmtbl0wna03nzbirmrll2zo5o, cmu2eg7934zmmqobv8yunu3kp, cmu5igtui0dzsvwzdbyakxkr4, cmu6fmwor006oebrz0ynd9cez, cmu6fmghw006bebrzhdkq9t67, cmub2idiq119kvwzd2a8tu27b, cmue3nky200554w4s0aza6kn6, cmugv6dql0a88jf86w19fucbq, cmul2g4jt001v3stbn7vfu2v0
  - INCREMENTAL_UPDATE (7 from the text run; the VLM run adds cmumlw4dm0bbtyexx36ne1ac0 and cmuo33xqf08ze5wb5gmxv9nx6, other banks, for 9): cmu2eg7934zmmqobv8yunu3kp, cmu5igtui0dzsvwzdbyakxkr4, cmu6fmwor006oebrz0ynd9cez, cmu6fmghw006bebrzhdkq9t67, cmub2idiq119kvwzd2a8tu27b, cmugv6dql0a88jf86w19fucbq, cmul2g4jt001v3stbn7vfu2v0
  - PRODUCER_UNEXPECTED (14): the 9 above plus cmrkm8qo201ekc8g6h6kvpm7r, cmszuxdi800e4mq0n2myyzeve, cmub7kdyl124cvwzdkonu8dk2, cmuins7dd0k2cjf868m6xavyt, cmv5bnfv73qc75wb5cbv9k00j
  - 7 files carry appended incremental updates AND break the running balance, the strongest tamper pattern.

## VLM run
Run 17:30–19:42 SAST on the local vLLM (the first attempt hit the test's 30-minute timeout; `d4778a0` gives VLM mode 8 h). Of 79 statements routed to the vision model, 61 were read and **5 passed the balance check (6.3%)**:
- ABSA 0/13, African Bank 0/2, Capitec (non-text) 0/1, Discovery 1/9;
- Nedbank 0/19 (all 19 read);
- Standard Bank 1/6, TymeBank 3/10, undetected 0/19.

These fail closed to MANUAL_REVIEW / UNVERIFIED_READ, so there are no false tamper flags. Every non-Capitec/FNB statement, about 40% of the corpus, still needs a person. Next options:
- find where vision reads drop or misread rows (Nedbank first);
- or add text readers for Nedbank and ABSA.

PR comment: https://github.com/Heinvv10/CredaFlow/pull/54#issuecomment-6151573579

## Open decision for Hein
Clearing requires a TOTP-verified session. Demo stacks strip TOTP, so no one can clear a flag on a demo, and the simulator's approve will 409 on flagged applications. Options:
- (a) the demo restore clears flags;
- (b) a per-tenant setting for clearing without TOTP (never for a real lender);
- (c) accept that demos can't approve flagged applications.

## Follow-ups (not in PR #54)
- A retry cron for pending vision reads, and round-robin fairness across tenants (the current cap is 20 waiting per tenant).
- An upload rate limit.
- Compare the statement's account number with the client's banking details.
- Make document create + decrypt-audit row one transaction.
- Gambling-merchant key vs an income change; render a Dr suffix in the synthetic fixtures.
- DSAR/retention: `StatementAnalysis` has a RESTRICT FK, and flags are undeletable by design. Decide the retention story.
- Inherent limits:
  - payslip authenticity is not checked;
  - a balanced, bank-producer, unedited forgery passes the file checks;
  - an upload landing in the milliseconds between the approval's evidence check and its commit is unseen.
- CI is not running (GitHub billing). PR #54 was gated locally only.

## Local state
Cleaned up: the dev server, the `cf-checks-it` and `cf-checks-dev` containers, and the worktree `.env.local` and `uploads/` are gone. The worktree itself is kept for the PR. To re-run the IT suites, see CLAUDE.md.
