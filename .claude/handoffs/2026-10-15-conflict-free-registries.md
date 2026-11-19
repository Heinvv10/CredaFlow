# Handoff — 2026-10-15 ~14:40 SAST — conflict-free registries

**Goal:** `.claude/handoffs/2026-10-15-conflict-free-registries-goal.md`. Every success criterion in §7 is met with evidence. The evidence is in the PR body.
**PR:** #110 `refactor/conflict-free-registries`, head 0a848479, **queued with `mq add 110`**; not merged at time of writing.
**Worktree:** `/home/hein/Workspace/CredaFlow-registries` (clean; delete it after merge).

## What landed on the branch
- Audit actions, tenant-scoped models, cron jobs, simulated integrations and permissions are each built from `lib/registry/<kind>/*.ts`. `scripts/gen-registries.ts` merges them into gitignored `lib/registry/generated/`. Cron is one entry per route: schedule, method, freshness and owner (in-process / external / unwired + reason). instrumentation.ts, `CRON_FRESHNESS_MINUTES` and the census test all read it.
- CLAUDE.md "Path-Scoped Rules" is a pointer now. Each `.claude.md` carries a `<!-- summary: … -->` line, and the generator fails without it. The index goes to gitignored `docs/module-rules.md`.
- `prisma/schema/*.prisma` replaces `prisma/schema.prisma` (prismaSchemaFolder; `package.json` `prisma.schema`). Back-relations sit in one alphabetical block per model (`prisma/schema-order.test.ts`). Schema readers use `readPrismaSchema()` from `prisma/schema-source.ts`.
- Generation runs on: postinstall, predev, prebuild, pretest, typecheck, demo:typecheck, the seed/lender/uploads scripts, vitest globalSetup, ci-local.sh, the CI workflow, and demo `update-runner.sh`.
- Parity snapshots in `lib/registry/__snapshots__/` are FROZEN at e343dc4f. New entries never edit them; removing or changing an old entry does.
- #89 (accounting + payouts) was merged in and ported (08aa1858). Its runtime values are byte-identical to 03207a90.

## Verified (this session)
- ci:quality green on 0a848479 (17,138 unit tests + build). ci:integration green on bb592f85 (223 suites).
- One earlier full integration run failed `pasq-ceremony-guard-migration … freeze-anchor` once. It passed 3/3 alone on both branch and main, then passed in the next full run. It's order-dependent flake; watch for it.
- migrate diff: empty, from migrations and from both old single files. Fresh-clone `npm ci && npm test` works. Docker runner + tools built from `git archive`: health 200, 20 cron jobs registered, tools-image `migrate deploy` OK.
- Two-branch merge demo: 0 conflicts. The same additions on old main conflict in 7 files.
- Blind reviewer SHIP; adversarial breaker SHIP (after two fix rounds).

## Open — for Hein
1. **mq auto-rebase-once (goal §6):** I sent the proposal to credaflow-b0, which replied that it doesn't own mq. Owner unknown (source `/home/hein/Workspace/merge-queue`). Proposal: before ejecting a BEHIND or conflicting PR, merge main into it once (a new commit, no force-push), run gen:registries, push, rerun CI, and eject only on a merge conflict or red CI; skip a PR labelled `no-auto-merge`. This needs Hein's go-ahead and an owner.
2. **Permission maps disagree (pre-existing, kept as-is):** `decline_loan` is LOAN_ADMIN on the server and CREDIT_OFFICER on the client. The server map lacks `manage_insurance` and `manage_collections`. Unifying them changes access, so it needs Hein's decision.
3. **Open PRs written against the old layout** conflict once, e.g. `feat/af-slice4-recovery`, which adds 7 tenant models, ~23 audit keys and a schema block. Resolution recipe: see "Merging other PRs after this" in the #110 body.

## Next steps
- Watch `mq status` / `mq log` for #110. If it's ejected as BEHIND, merge main into it and port any new list edits into entry files (the recipe above). Re-run `npx tsx scripts/gen-registries.ts` and the parity test. Never edit snapshot values to make the test pass.
- After merge: `git worktree remove ../CredaFlow-registries`.
