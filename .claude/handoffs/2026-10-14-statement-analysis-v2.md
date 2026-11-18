# Handoff — statement analysis v2 ("OBSE parity"), 2026-10-14 ~22:45 SAST

**Goal file:** `.claude/handoffs/2026-10-14-statement-analysis-v2-goal.md`
**Status:** both PRs are open, reviewed and fixed to SHIP candidates. Not merged; merging is Hein's call (§10).

| PR | Branch / worktree | Head | What |
|---|---|---|---|
| **#72** | `feat/statement-readers-v2` / `../CredaFlow-readers-v2` | c75f34e | Nedbank, ABSA (BIRT + eStatement), Standard Bank, Discovery text readers; tamper review |
| **#73** | `feat/statement-insights` / `../CredaFlow-insights` | 05a61e2 | Categoriser, insights panel, xlsx export, EXPENSE_UNDERSTATED (shipped **off**) |

Each PR's description carries its evidence, and a reconciliation comment records every review finding and its outcome. The two PRs aren't stacked. Whichever merges second will conflict in `lib/statement-analysis/.claude.md` and `AGENTS.md`; keep both sets of lines, trim to 50, run `npm run agents:mirror`.

## Success criteria (§9)
1. **Readers:** corpus TEXT, bank-produced files:
   - Nedbank **19/19**, ABSA **11/11**, Standard Bank 5/5, Discovery 8/8.
   - Counting the vision reads too: Standard Bank 6/6, Discovery 9/9.
   - Capitec + FNB 105/105 (v1 was 105/106).
   - Zero balance tamper flags on genuine files. ✅
2. **Doctored fixtures:** 46/46 across all 7 layouts. ✅
3. **Tamper review:** posted on #72.
   - Every balance break is explained by the file (Word, pypdf, airSlate), not the reader.
   - The INCREMENTAL_UPDATE on all 8 Word files is Word's hybrid-xref trailer (~187 bytes, zero objects), not an edit.
   - **Proposal for Hein:** don't count an appended section that adds no objects. Not changed in code. ✅
4. **Categoriser:**
   - Existing check tests unmodified. ✅
   - v1 corpus flag set identical: 484 flags, digest 1c37d2e49fe12bd2. ✅
   - §6.4 gate **FAILED**: held-out 90.0, 90.5, 90.2 and 90.2% (needs 95%). Per the goal, **EXPENSE_UNDERSTATED ships disabled**; numbers are posted on #73.
5. **Flag:**
   - Boundary tests are mutation-verified.
   - The RUN_CREDIT_CHECKS_IT suite on throwaway Postgres 16 passes: the enum is migrated, an OPEN flag blocks approval through the trigger, and clear-then-approve succeeds. ✅
6. **Export route tests:**
   - READONLY and INSURANCE_OFFICER → 403, no session → 401, LOAN_ADMIN → 200.
   - Cross-site refused, tenant isolation.
   - One access-log row and one audit row per download. ✅
7. **Gates:** tsc, lint, full `npm test`, the integration runner (#72 148/148, #73 149/149, baseline empty), claude-md and agents checks. All green on both final heads. ✅
8. **Browser acceptance:** seeded local DB, real LOAN_ADMIN login with TOTP. Screenshots are on branch `evidence/statement-v2-screenshots`, linked from the PRs. ✅
   - #73's flag path was shown with the constant flipped **locally only**, then reverted.
   - A separate browser UI reviewer checked light and dark at desktop and 375 px.
9. **Review:**
   - Round 1, both PRs: blind review team (quality, security, TDD, architecture), plus a parser-attacker on #72 and a policy-breaker on #73.
   - Then two more rounds of breaker and fix review.
   - All findings fixed or reconciled on the PRs. ✅

## Decisions for Hein
- **Merge #72 and #73** (and their order).
- **Manual-review workload from #72:** every ABSA Transaction History (9/9) and Discovery (8/8) corpus statement now gets FIRST_ROW_UNVERIFIED and/or LAST_ROW_UNVERIFIED, and every ABSA eStatement (3/3) gets ROWS_UNCHECKED. Those rows really can't be checked by arithmetic. A follow-up could compare the derived opening with the previous statement's closing.
- **Architecture review asked** for Standard Bank and Discovery TEXT failures to be treated as UNVERIFIED_READ rather than tamper evidence. Not adopted, because it contradicts §9.2. Your call.
- **Word hybrid-xref:** whether to stop counting it as INCREMENTAL_UPDATE.
- **Before turning EXPENSE_UNDERSTATED on**, all listed in `policy.ts`:
  - pass the §6.4 gate;
  - supersede an older OPEN LIVING_SPEND_ABOVE_DECLARED when its successor is raised;
  - add monthlyExpenses to the decide route's stale check;
  - decide how an explicit R0 declaration is treated.
- **Corpus deletion:** due once v2 is accepted. Remove `/home/hein/secure/ndzinga-corpus` and `/home/hein/secure/ndzinga-corpus-derived` (it holds the merchant keys, labels and holder salt).

## Incidents (be aware)
- **A shape-script run printed a few unmasked words into this session.** With only 3 ABSA eStatement files, its "label" filter let through what looked like a surname and town names. Nothing reached the repo or a PR. The filter now needs 5+ accounts and normalises spaced account numbers.
- **My integration script hit another session's database.** Its container failed to bind 55443, and it ran PR B's migrations and the suites against another session's IT database (`cf-s3`, owned by credaflow-b0). That session was told and recreated it. Lesson saved in memory `feedback_it_container_failfast.md`.

## Not done / follow-ups
- `fnb.ts` still has its own copy of the word-box helpers (review MEDIUM, left surgical).
- Bank-detection markers are still matched over the whole text. Readers are now tried per marker, which fixes routing; header-only markers would be cleaner.
- The long tail (vLLM, informative only): gate-class agreement was 326/530 rows. 187 rows the model calls living are uncategorised (mostly P2P payments).
- Coverage: 31.4% of debit value is categorised.

## Clean-up done
- Dev and IT containers removed, `.env.local` deleted, temporary worktrees (measure, v1-main) removed, dev servers stopped.
- Worktrees `CredaFlow-readers-v2` and `CredaFlow-insights` are kept for the PRs.
