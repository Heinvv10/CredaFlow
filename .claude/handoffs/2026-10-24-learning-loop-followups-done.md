# Learning loop follow-ups — DONE, all six PRs merged (2026-10-24)

Goal: `.claude/handoffs/2026-10-23-learning-loop-followups-goal.md`. Evidence page (was https://claude.ai/artifact/57MbCSmVdwS4M3zbCeZHYP — deleted/unshared 2026-10-24; local copy in the session scratchpad).

## Merged (via mq; each passed local `npm run ci:full`, blind review, coordinator-run mutations, GitHub CI)
| PR | Part |
|---|---|
| #242 | 6 offboarding runbook (DESIGN §12) — batch #248 |
| #243 | 3 refusal-failure audit trace + s71 count — batch #248 |
| #244 | 1 DSAR export of decision records — batch #248 |
| #245 | 5 bounded outcome job + dashboard loader (24-month decision lookback) |
| #246 | 4 subject-consistency INSERT trigger |
| #247 | 2 retention + pseudonymise (off by default) |
| #249 | test-only: valuation guide B5 accepts a serialised publish pair (CI flake surfaced by #247's shard reshuffle) |

Integration fixes made while merging:
- #245 ← #243: the s71 failure count takes the same 24-month `decidedAt` lookback as the refusal total (IT row outside the window; mutation red).
- #246 ← #244: the DSAR-export IT stored rows the subject trigger now refuses (erased application, another lender's ids); the fixture inserts them under `session_replication_role = replica`.
- #247: DESIGN §2.3/§9 no longer say retention is "not built".
- After merging main into a branch, run `npm run gen:registries` before `tsc` (new audit-action files).

## Open decisions for Hein
- #245: dashboard shows only the last 24 months of decisions. **Decided 2026-10-24 (Hein): keep** (#250).
- #247: **floor decided 2026-10-24 (Hein): 60 months (FICA), CHECK 60..600, #250.** Accepted limits: an owner/superuser
  session can set the pseudonymise flag (every stack connects as superuser today; ARCHITECTURE RLS checklist says the
  app role must not own tables); the period has no DB guard (like `requireStaffTotp`). No retention set on any demo stack.
- Merge-queue fix (Confirmation Gate, untouched): `/home/hein/Workspace/merge-queue` branch `fix/skipped-draft-checks`
  (worktree `merge-queue-wt-skipped`): a skipped required check stays pending while a check run started after it is
  unfinished. Red-then-green test, `bun test` 127/127, blind review APPROVED. Merge to master + restart
  `merge-queue.service` only on Hein's go. **Done 2026-10-24 (master fdab4be, restarted idle; #250 merged through it).**

## Known flakes (pre-existing)
- `dashboard.integration.test.ts` races `outcomes.integration.test.ts` (all-tenant cron sweep) when run in one vitest invocation.
- ITs that create a Postgres role collide on `DROP OWNED BY` when run as a pair. CI runs serially.
- GitHub Actions was blocked by billing 2026-10-23 16:27 → 2026-10-24 ~06:50 (fixed by Hein).
