# Handoff — KYC follow-ups goal DONE (2026-10-16 12:50 SAST)

**Goal:** `.claude/handoffs/2026-10-16-kyc-followups-goal.md` (F1–F8). All eight closed.

## PRs
| PR | Items | State |
|---|---|---|
| #123 | F7 restore.test flake, F8 bake preflight | MERGED |
| #125 | F2 manual-PENDING hold, F4 stored-status badges, F5 ADMIN (no repro), F6 re-derive tests | MERGED (79a69570) |
| #129 | F1 identical ID = verified copy, F3 CHECK verified ⟂ refused (migration `20261016120000`) | MERGED (4539b4ed) |

Gates on each: `ci:full` twice in a row green on the final head; hosted CI green; blind review (Sonnet for #123; Opus reviewer + Opus breaker for #125 and #129) ending SHIP from both, every finding fixed and re-confirmed (#125 took 3 rounds, #129 2 + a post-merge re-confirm).

## What changed (behaviour)
- **F1 — no SQL migration.** No SQL function picks the selfie's ID copy, so the twin is resolved at capture and at the outcome re-check (`resolveCurrentIdDocument`, `lib/kyc/usable-id-document.ts`). Every SQL gate accepts it unchanged; nothing loosened. Bonus: an adverse selfie after an identical re-upload now lapses the in-person attestation (it escaped before). Verify route 409s an identical twin. Checklist: twin shows "Identical to verified copy"; when a *different* copy holds PENDING, the ID row shows that copy instead.
- **F2 — manual PENDING holds against every automatic promotion** (my call, beyond the goal's "hide the button"; both reviewers found the button-only version was bypassable via document verify and via FAILED→selfie). Only a later recorded VERIFIED (Approve KYC, senior exception, in-person, override approval — all staff, TOTP-gated) ends it. Reject KYC doesn't end it. `lib/kyc/manual-pending.server.ts` (`holdManualPending` in every derived-state writer).
- **F3** CHECK `ClientDocument_verified_not_refused_check`; pre-check aborts with the count, never fixes data. Agreement signing and the selfie outcome writer deliberately don't clear a refusal (fail closed).
- **F4** all staff badges and the **borrower portal** "complete" use the stored status.
- **F5** didn't reproduce on main: ADMIN missing from `STAFF_ROLES` was fixed by #116 (7d50db9d); existing `route.admin.integration.test.ts` proves ADMIN 200 + `DocumentAccessLog`. **Live demo (tsela-56c4863b) and Fairscore (fairscore-9165dbde) images predate #116 → still 401 until rebuilt.**
- **F7** not reproduced; measured (≤4.7 s at 512 busy loops); root cause CPU starvation of a fork-heavy test with fixed sleeps → 30 s budget + shorter stub sleep.
- **F8** `sim_env_preflight` fails in seconds naming missing `DEMO_MODE`/`UNSUB_TOKEN_SECRET`.

## For Hein (decisions / follow-ups, nothing built)
1. **Manual EXPIRED** with no prior manual PENDING is not held — a later document verify can promote it. Same class as F2; decide if a manual EXPIRED should stick.
2. **Rollout of #129's migration** to demo/Fairscore: the pre-check will abort if any row is verified *and* refused. Run the count first: `SELECT count(*) FROM "ClientDocument" WHERE verified AND ("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL);` — not run on live stacks (out of scope).
3. Demo/Fairscore images need a rebuild for #116/#125/#129 (ADMIN checklist 401 still live there).
4. Document list route logs only refusals to `DocumentAccessLog`; view logs access. Left as is (new POPIA behaviour would be your call).
5. Flake candidates seen under heavy load (not touched): `collections-engine-breaker4` case F (createdAt tie ordering), `pasq-ceremony-guard-migration`, `lease-pricing.test.ts` 150-lease case.

## Cleanup
Worktrees `CredaFlow-kycfu-a/b/c` can go once #129 merges (b and c are merged). Screenshots (synthetic data) in this session's scratchpad only; reusable local browser harness there too (`browser-harness.sh`, `shoot.mjs`). All IT containers torn down.

## Where to resume
All three PRs merged; goal closed.
