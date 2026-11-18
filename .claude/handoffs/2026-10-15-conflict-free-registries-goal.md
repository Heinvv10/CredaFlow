# /goal — Conflict-free registries: stop parallel PRs colliding on shared lists (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-15-conflict-free-registries-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§8) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, then open the PR(s), queue them with mq, write a handoff and stop.`

## 1. Mission

On 2026-10-15 roughly a dozen parallel PRs were merged through the CredaFlow merge queue (`mq`). Most queue ejections and most of the merge-agent's work came from a handful of **shared, append-only lists** that nearly every feature PR edits. Make those lists conflict-free so two PRs that each add an entry never conflict in git (and therefore never conflict in GitHub's mergeability check, which ignores local merge drivers).

This is a **behaviour-preserving refactor**: same runtime values, same tests, same database. "Done" means: the same entries exist at runtime, every existing test is green, a new test proves the generated registries equal the old lists exactly, and a demonstration shows two branches each adding an entry merge with **zero conflicts**.

Churn in the last 24h on main (commits touching each file): `prisma/schema.prisma` 23, `lib/audit.ts` 22, `CLAUDE.md` 10, `lib/tenant-scope.ts` 6, `instrumentation.ts` 6, `lib/integrations/simulation-guard.ts` 3, `lib/permissions.ts` 2, `lib/ops/cron-heartbeat.ts` 2.

## 2. What already exists — do NOT redo

- `main` at `e343dc4f` or later. Start: `git fetch origin && git checkout -b refactor/conflict-free-registries origin/main`; `npm ci --legacy-peer-deps`; `npx prisma generate`.
- Lists to convert (verified on main):
  - `lib/tenant-scope.ts:3` — `export const TENANT_SCOPED_MODELS = [ ... ]` (+ `TenantScopedModel` type at :139, membership at :241). Tests: `lib/__tests__/tenant-scope.test.ts`, `lib/tenant-scope-instances.test.ts`, `lib/tenant-isolation.integration.test.ts` (RLS coverage of every scoped model).
  - `lib/audit.ts:58` — `export const AuditAction = { ... }` (TS object, not a Prisma enum).
  - `instrumentation.ts` — the `cron.schedule(...)` list; `instrumentation.cron-census.test.ts` (census + INTENTIONALLY_UNWIRED); `lib/ops/cron-heartbeat.ts:28` `CRON_FRESHNESS_MINUTES`; `lib/ops/cron-freshness.test.ts` (every scheduled job must have a budget).
  - `lib/integrations/simulation-guard.ts:50` — `SIMULATION_FORBIDDEN_ON_DEPLOYED` (+ `GuardedIntegration` type).
  - `lib/permissions.ts` — permission → min-role table.
  - `CLAUDE.md` "## Path-Scoped Rules" list (line ~244) and its `AGENTS.md` mirror (`scripts/mirror-agents-md.ts`, check `npm run agents:check`, drift `npm run claude-md:check` via `scripts/check-claude-md-paths.ts`).
  - `prisma/schema.prisma` — single file, Prisma `^5.22.0`.
- Gates: `npm run ci:quality`, `npm run ci:integration` (disposable container; or `scripts/it-db.sh up|check|down` + `scripts/run-integration-tests.sh`), `.github/workflows/quality-gate.yml`, `scripts/ci-local.sh`, `Dockerfile` (the build must still work in Docker).
- Merge queue: `mq add <pr>` / `mq status` / `mq log` (owner: session credaflow-b0; worker `systemd --user merge-queue.service`). Agents can't `gh pr merge` (critical-guard hook).

## 2a. Product decisions (already made — Hein, 2026-10-15)

1. **Split the Prisma schema now** using the `prismaSchemaFolder` preview feature (Prisma 5.22): one `.prisma` file per domain. Back-relation lines on shared models (Tenant, TenantConfig, Client, Loan, User, LoanApplication) are unavoidable in Prisma — keep each such model's relation fields **alphabetically sorted, one per line**, so insertions from different PRs land in different places.
2. **One file per registry entry, index generated at build (not committed).** Each feature contributes its own small file; a generator script produces the index the app imports. The generated file is gitignored and produced by a pre-step before `dev`, `build`, `test`, `tsc`, `ci:*`, CI and Docker build.

## 3. Registries (lists) — what "real" means

For each list: a directory of entry files, a generator, a generated index, and a parity test.

**Recommended shape** `[agent decides details]`:
- `lib/registry/<name>/<entry>.ts` (or colocated next to the feature, e.g. `lib/collections-engine/registry.audit.ts` — agent decides; colocated is preferred so a feature PR touches only its own folder). Each entry file `export default` a typed literal (e.g. `defineAuditActions({ COLLECTION_RESULT_RECORDED: "COLLECTION_RESULT_RECORDED" })`, `defineTenantScopedModels(["DebitMandate", ...])`, `defineCron({ path, schedule, method, freshnessMinutes })`, `defineSimulatedIntegration({...})`, `definePermission({...})`).
- `scripts/gen-registries.ts`: globs entry files (stable sort by path), validates (duplicates → error naming both files; shape), writes `lib/registry/generated/*.ts` (gitignored) with static imports and the merged `as const` values so TypeScript keeps literal types (`TenantScopedModel`, `GuardedIntegration`, audit action union).
- Wire `npm run gen:registries` into `predev`, `prebuild`, `pretest`, a `typecheck` script used by ci:quality, `ci:*`, the GitHub workflow, `ci-local.sh` and the Dockerfile build stage. A fresh clone running `npm ci && npm test` must work with no manual step. `[agent decides how; postinstall is acceptable if it doesn't break `npm ci` in Docker]`.
- **Cron** consolidated: one entry declares schedule + freshness budget + census status, so `instrumentation.ts`, `CRON_FRESHNESS_MINUTES` and the census test all read the same registry (removes the 3-way edit per new cron job).
- **Parity test** per registry: a committed snapshot of today's exact values (taken from `origin/main` before refactoring) must equal the generated values — mutation-check by deleting one entry file.
- Keep public exports stable (`TENANT_SCOPED_MODELS`, `AuditAction`, `CRON_FRESHNESS_MINUTES`, etc. re-exported from their current modules) so no call site changes are needed beyond imports.
- Move existing entries into per-domain entry files (grouped by the comments already in each list), not one giant file.

**CLAUDE.md Path-Scoped Rules list:** generate it. Each nested `.claude.md` declares a one-line summary in front-matter or first line; `scripts/mirror-agents-md.ts` (or a sibling generator) rewrites the list section between markers in CLAUDE.md/AGENTS.md. Since CLAUDE.md is committed, the list itself must not be hand-edited: add a check that fails if the section is stale, and make the generator idempotent — **conflict-free requires that two PRs adding a module don't both edit CLAUDE.md**: so the committed CLAUDE.md should contain only a pointer ("see the generated `docs/module-rules.md`") or the markers with content regenerated in CI and not committed. `[agent decides; record the choice in the PR]`.

## 4. Prisma schema split

- Enable `previewFeatures = ["prismaSchemaFolder"]`; move `prisma/schema.prisma` → `prisma/schema/*.prisma` by domain (auth/users, tenancy/config, clients/kyc, applications/decision, loans/schedule/payments, collections, bureau, screening/fic, insurance, asset-finance, comms/messaging, crm, accounting/payouts, lender-api/webhooks, ops). Update every tool path (`prisma` config in package.json, scripts referencing `prisma/schema.prisma`, `lib/db-baseline.test-helpers.ts`, Dockerfile, CI, `scripts/demo/*`, `scripts/lender/*` — grep `schema.prisma`).
- Back-relation fields on shared models: alphabetical, one per line, with a lint/test that enforces ordering (fails with the expected order).
- **Proof:** `npx prisma validate`, `npx prisma generate`, `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema --shadow-database-url <throwaway>` reports **no difference**, and `migrate deploy` from scratch works. No migration is created by this work.

## 5. Demonstrate conflict-freedom

Script or test (`scripts/__tests__/registry-merge.test.ts` or a documented manual proof in the PR): create two throwaway branches from the refactor branch, each adding (a) a new tenant-scoped model with Tenant back-relation, (b) an audit action, (c) a cron job with freshness, (d) a simulated integration, (e) a module `.claude.md`; `git merge` them → **0 conflicts** (back-relations alphabetised so they don't touch the same lines — pick names that sort apart; if they sort adjacently a conflict on Tenant is acceptable and expected; document it).

## 6. Optional: queue auto-rebase-once (coordinate, don't build)

Draft a short proposal for credaflow-b0 (owner of `mq`, `/home/hein/.local/bin/mq`, `systemd --user merge-queue.service`): before ejecting a PR as BEHIND/conflicting, the worker merges `main` into it once, pushes, reruns CI, and ejects only if that fails. Send it to session credaflow-b0 via SendMessage. Do **not** modify mq yourself.

## 7. Success criteria (all with evidence)

1. Every listed registry is generated from per-entry files; generated output gitignored; public exports unchanged.
2. Parity tests: generated values == pre-refactor snapshot for each registry; deleting an entry file turns the test red (mutation evidence in the PR).
3. Schema split: validate/generate OK; migrate diff empty; migrate deploy from scratch OK; relation-order lint in place.
4. `npm run ci:quality` and `npm run ci:integration` green; Docker image builds (`docker build .` or the repo's build script) and the app boots (`/api/health` 200 on a local container).
5. Fresh clone check: `git clone` into /tmp, `npm ci --legacy-peer-deps && npm test` passes with no manual generator step.
6. Two-branch merge demo: 0 conflicts (§5).
7. Docs: `docs/ARCHITECTURE.md` section "Registries" explaining how to add an entry for each kind; CLAUDE.md updated (via the generator) and `agents:check` / `claude-md:check` green.
8. Blind `/review` (fresh agent) and an adversarial reviewer ("can a registry entry be silently dropped, duplicated, or ordered differently than before? does any build path skip generation?") both SHIP; findings fixed.
9. PR opened and queued with `mq add`.

## 8. Confirmation gates (stop and ask Hein)

- Any change that alters runtime values (a model added/removed from tenant scope, an audit action renamed, a cron schedule changed). There should be none.
- Any new migration (there should be none).
- Changing `mq` or the merge-queue service (proposal only — §6).
- Touching demo/Fairscore stacks on velo-server.

## 9. Coordination

Other sessions keep merging feature PRs while this runs; expect to merge `main` into the branch several times — each time, re-run the generators and the parity snapshot must be re-taken **only** for entries those merges added (never edit snapshot values to make a test pass without tracing the new entry to a merged PR). Use `scripts/it-db.sh up/check/down` for any database; never reuse another session's container. Merge-queue only — no direct merges.
