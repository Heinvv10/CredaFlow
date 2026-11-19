# Handoff — statement analysis v2 landed, 2026-10-15

**Status:** both PRs are merged into main. The worktrees `CredaFlow-readers-v2` and `CredaFlow-insights` are removed, and their remote branches are deleted.

| PR | Merge SHA | Notes |
|---|---|---|
| #72 bank readers | d1aec744 | Merged at 04:11 SAST with `--admin`. GitHub Actions was refusing jobs for billing, so `enforce_admins` was switched off for that one merge on Hein's explicit choice, then switched back on (verified `true`). |
| #73 insights/export | ef6f94f9 | Merged at 04:33 SAST at the reviewed head 3590e9c, after billing was fixed and CI went green (quality + integration). |

## Evidence
- **#72 head 473f374:**
  - `ci:quality` exit 0, vitest 14905 passed.
  - Integration 149 passed / 2 skipped of 151. That is the previous 148 plus main's `lib/bureau/framework.integration.test.ts` from #78.
- **#73 head 3590e9c** (origin/main merged in after #72):
  - `ci:quality` exit 0, vitest 14993 passed.
  - Integration 150 passed / 2 skipped of 152.
- **`.claude.md` conflict:** both sides kept, file is 50 lines, mirror regenerated.
  - A blind reviewer returned APPROVED, with LOW wording notes only.
  - Dropped qualifiers it flagged: "background" vision read, `reader_unavailable`.
- **Fresh main checkout at ef6f94f:** `tsc` OK, vitest 1078 files / 14993 tests passed.
  - `EXPENSE_UNDERSTATED_ENABLED = false` (`lib/credit-checks/policy.ts:146`).
- **Flake under load:** `scripts/demo/restore.test.ts`, at load average 65. It passes alone and on rerun.

## Hein decisions still open (from `2026-10-14-statement-analysis-v2.md`)
1. **Manual-review workload:** every ABSA and Discovery corpus statement now gets a flag.
2. **Word hybrid-xref trailer:** whether it should stop counting as INCREMENTAL_UPDATE.
3. **EXPENSE_UNDERSTATED switch-on prerequisites** (`policy.ts`):
   - the §6.4 gate is at 90.2% against 95% required;
   - supersede an older OPEN flag when its successor is raised;
   - add monthlyExpenses to the decide route's stale check;
   - decide how an explicit R0 declaration is treated.
4. **Corpus deletion** (`/home/hein/secure/ndzinga-corpus` and `-derived`), now that v2 is merged.

## Engineering follow-ups (no decision needed, not started)
- `fnb.ts` still keeps its own copy of the word-box helpers; `word-table.ts` has the shared ones.
- Bank-detection markers are matched over the whole text. Matching header-only markers would be cleaner.
- Categoriser coverage is 31.4% of debit value. 187 rows the model calls living spend are uncategorised, mostly P2P payments.
- `lib/statement-analysis/.claude.md` sits at the 50-line cap. The review's LOW notes: the "background" qualifier on vision reads and the `reader_unavailable` code were trimmed.
- `scripts/demo/restore.test.ts` is flaky under heavy load (load average 65).

## Where to resume
Nothing is in flight: no worktrees, containers or open PRs from this work. Start from Hein's answers to decisions 1–4.
