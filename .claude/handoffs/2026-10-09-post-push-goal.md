# /goal — CredaFlow: 4 post-push PRs (green CI, tenant colours, outage removal, comment pass) — run autonomously until DONE

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-09-post-push-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then open the PRs as §7 says, write the handoff and stop.`

## 1. Mission

Four stacked pull requests on `github.com/Heinvv10/CredaFlow`, each reviewed blind and green, none merged
(Hein merges):

1. **PR1 — green CI + quality:** the nightly/PR `integration-tests` job green; lint 0 errors; no undefined CSS
   variables; demo passwords out of source.
2. **PR2 — tenant colour validation:** a tenant cannot save colours that break WCAG AA; sign-in pages use the
   tenant's colours.
3. **PR3 — delete outage-disbursement reconciliation:** TS code, admin route, DB functions/triggers and the
   schema relation removed, proven by a catalog diff.
4. **PR4 — comment-history pass:** inherited comments that narrate a previous operator's production history
   are rewritten to state the rule, with a machine proof that only comments changed.

"Done" = every §8 criterion proven with pasted output, three blind reviewers SHIP/CLEAN on each PR's final
commit, CI green on GitHub for every PR.

## 2. What already exists — do NOT redo

- **Repo:** local `main` = `origin/main` = `51c387e` ("CredaFlow: initial public commit", one orphan commit).
  Read `.claude/handoffs/LATEST.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md` first.
- **⚠️ The fork history must never reach GitHub.** Local branches `fork/main` and every `whitelabel/*` descend
  from `ab18248` and hold another lender's code and data. Branch ONLY from `main`. Before EVERY `git push`, run
  and paste: `git merge-base --is-ancestor ab18248 HEAD && echo FORK-HISTORY || echo clean` → must print
  `clean`, and `git rev-list --max-parents=0 HEAD` → must print only `51c387e…`. Never push with `--all`,
  `--tags`, `--mirror` or `-f`.
- **Forked-lender guard:** `lib/website/__fixtures__/other-lender.ts` reads digests from
  `~/.config/credaflow/other-lender-digests.json` (present on this machine; never copy it into the repo, never
  print its contents). With it, `lib/config/legacy-identity-boundary.test.ts` scans the whole tree. It must stay
  green on every PR.
- **Gate baseline at `51c387e`:** `rm -rf .next && npx tsc --noEmit` 0; `npm run lint` 5 errors (the
  `<a href="/api/reports/export/…">` pattern in `app/(dashboard)/reports/advisor/page.tsx`,
  `app/(dashboard)/reports/arrears-aging/page.tsx`, `app/(dashboard)/reports/page.tsx`,
  `components/compliance/FscaReturnClient.tsx`) + 13 warnings; `npx vitest run` 868 files, no deterministic
  failure (load flakes, green alone: `app/api/applications/[id]/disburse/route.test.ts`,
  `app/api/portal/register/route.test.ts`, `lib/messaging/send.test.ts` fingerprint); `npm run build` OK
  (1 NFT warning); `npm run dates:check`, `claude-md:check`, `agents:check` OK.
- **Integration:** `bash scripts/run-integration-tests.sh` against a throwaway PG 16
  (`docker run -d --name cf-goal-pg -e POSTGRES_PASSWORD=x -p 127.0.0.1:55441:5432 postgres:16-alpine`,
  `DATABASE_URL=postgresql://postgres:x@127.0.0.1:55441/<db>`, `npx prisma migrate deploy`). At `51c387e`:
  167 gated suites, 9 failing (list in §3.1), plus 5 in `scripts/integration-baseline.txt`. The script refuses
  non-local hosts — do not work around it.
- **Palette tooling:** `scripts/palette-contrast.ts` (`check(css, tenantOverrides)`), test
  `scripts/__tests__/palette-contrast.test.ts`; tenant colours are published by
  `components/TenantThemeProvider.tsx` (server component, `#rrggbb` only) and mounted in
  `app/(dashboard)/layout.tsx`, `app/(portal)/layout.tsx`, `components/website/WebsiteShell.tsx`.
- **Seed:** `prisma/seed.ts` (Acme, TOTP staff, `SEED_PRINT_CREDENTIALS=1` prints logins).
  `npx prisma migrate reset --force` = migrations + seed.

## 2a. Product decisions (already made by Hein, 2026-10-09 — build them, do not re-ask)

1. All four PRs are in scope, in the order of §1, **stacked**: PR1 base `main`; PR2 base PR1's branch; PR3 base
   PR2's; PR4 base PR3's. Pushing these branches and opening the PRs is pre-authorised (§7). Merging is not.
2. **Outage reconciliation: DELETE it** (not re-enable). It is dead: the allow-list is empty and its TS paths are
   untested.
3. **Comment pass: neutralise**, file by file, keeping the rule each comment explains.
4. Demo passwords: not constants in source. [agent decides: generated per first seed run like the TOTP secrets
   and printed only with `SEED_PRINT_CREDENTIALS=1`, or read from env with a generated fallback] — the seed must
   stay idempotent and `prisma/seed.integration.test.ts` must keep passing.

## 3. The four PRs — what "real" means for each

### 3.1 PR1 `fix/ci-green-and-quality`
- **The 9 failing gated integration suites** (observed at `51c387e` on a fresh baseline-migrated DB; the cause
  of each is to be diagnosed, not assumed — add instrumentation before fixing, per the debugging protocol):
  - `lib/inbox/conversation-last-activity.integration.test.ts`, `lib/inbox/mentions.integration.test.ts`,
    `lib/inbox/note-mutability-migration.integration.test.ts` — PrismaClientKnownRequestError / guard behaviour
  - `lib/insurance/policy/bind.integration.test.ts` (uses a hard-coded past start date),
    `lib/insurance/policy/quote-to-policy.integration.test.ts` (409 instead of 201; `token.split` on undefined —
    likely a missing disclosure-token secret env in the test setup)
  - `lib/loan/charges-round5-regressions.integration.test.ts` (`pdftotext` cannot parse the rendered PDF),
    `lib/loan/charges-sync.integration.test.ts` (Stitch initiate returns 502),
    `lib/loan/small-balance-waiver.integration.test.ts` (`LenderIdentityError: ncrNumber` — fixture tenant has no
    identity)
  - `lib/messaging/retry-notification-projection.integration.test.ts`
  For each: fix the fixture/test setup when the code is right; fix the code when the test exposes a real bug
  (say which, with evidence). A suite may move into `scripts/integration-baseline.txt` ONLY if it needs
  something CI cannot have, in a commit that does nothing else, with the reason written in the register —
  CI's "Baseline may only shrink" step will then fail that PR by design, which is a §9 gate. Prefer fixing.
  Also try the 5 register entries; remove any that pass.
- **CI must actually go green on GitHub:** `integration-tests` runs on `pull_request`; paste the run URL and
  conclusion. `agent-docs` and `date-boundaries` green too.
- **Lint 0 errors:** the 5 `<a href="/api/reports/export/…">` → a download that is not a page navigation
  (`<a download>` / `next/link` with `prefetch={false}` / a button — [agent decides], must keep the export
  working: prove by fetching the export in the browser or a route test).
- **CSS:** define or replace the undefined variables `--cf-accent` (10 uses), `--cf-border` (7), `--cf-text-soft`
  (5), `--cf-text-primary` (1) with existing tokens; remove duplicated selector lines in `app/globals.css`
  left by the phase-6 colour map. Add a test that every `var(--cf-…)` used in TSX/CSS (without a fallback) is
  defined in `app/globals.css` or `app/(quote)/quickquote-theme.css`; mutation: delete one definition → red.
  `scripts/palette-contrast.ts` must still pass.
- **Demo passwords** per §2a.4.

### 3.2 PR2 `feat/tenant-colour-validation`
- Saving `primaryColor`/`secondaryColor`/`darkColor` through `app/api/admin/tenants/route.ts` (POST) and
  `app/api/admin/tenants/[tenantId]/route.ts` (PATCH) — and any other writer you find (`git grep -n
  primaryColor`) — is refused with 422 and a field-level reason when, with that tenant's colours applied, any
  text/surface pair in light or dark mode is below 4.5:1, or a value is not `#rrggbb`.
- **Single source of truth stays `app/globals.css`.** The runtime check cannot read CSS files in the standalone
  build, so [agent decides] how the surface values reach runtime code (e.g. a small TS module of the base token
  values) — but a test must parse `app/globals.css` and fail when the runtime copy disagrees. Reuse the maths
  in `scripts/palette-contrast.ts` (move it to `lib/` and import it from the script).
- RBAC unchanged (`SUPER_ADMIN`). The PATCH route audits via `logAuditStrict`; the POST route (tenant
  creation) writes no audit row today — add one through `lib/audit.ts` (CLAUDE.md: every state change).
- **Sign-in pages themed:** `/login` and `/portal/login` (and forgot/reset password) render
  `TenantThemeProvider` with the request tenant's config (`getResolvedTenantId` + `getTenantConfig`).
- Tests: route tests for accept/refuse (a known-good colour set, a yellow primary, a light darkColor, a
  non-hex string); mutation: disable the check → red. Browser: set a failing colour via the API → 422; set a
  passing one → staff app and `/login` show it (screenshots light + dark).

### 3.3 PR3 `chore/remove-outage-reconciliation`
- Remove: `app/api/admin/disbursement-outage-reconciliation/` (route + test),
  `lib/disbursement/outage-exception.ts`, `lib/disbursement/outage-reconciliation.ts` and their tests and
  `lib/disbursement/outage-exception-migration.integration.test.ts`; callers in
  `app/api/applications/[id]/disburse/route.ts` and `app/api/applications/[id]/decide/route.ts` (verify with
  `git grep -n -i "outage"`; leave unrelated uses of the word, e.g. WhatsApp bridge outage handling, alone).
- Schema: `LoanApplication.disbursementExceptionId` / `disbursementException` relation and the
  `ApplicationDisbursementException` back-relation on `ComplianceRecord` — drop them if nothing else uses them.
- DB: a NEW migration (never edit the baseline) that drops the triggers
  `ComplianceRecord_guard_outage_disbursement_exception`, `LoanApplication_guard_outage_exception_binding`, the
  functions `guardLoanApplicationOutageExceptionBinding`, `guardOutageDisbursementExceptionRecord`,
  `validOutageDisbursementException`, `validOutageDisbursementExceptionRecord`,
  `validOutageDisbursementExceptionValues`, `validateOutageDisbursementLoan`, and the column/constraints —
  AND rewrites (`CREATE OR REPLACE`) every remaining function that calls them (find them:
  `grep -n "OutageDisbursement" prisma/migrations/20261009000000_baseline/migration.sql`) so that the outage
  branch is simply gone. **Direction must only ever be stricter:** removing an exception path from a guard is
  allowed; any other change to a guard's logic is a §9 gate.
- **Proof (catalog diff):** build DB-A from `main` migrations and DB-B with PR3's; diff `pg_trigger`,
  `pg_constraint`, `pg_proc` definitions (normalised `pg_get_functiondef`), indexes and columns. The only
  differences are the removed objects and the outage branches removed from the rewritten functions — paste the
  diff. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma
  --shadow-database-url …` empty. Update the static SQL tests (`lib/db-baseline.test-helpers.ts` readers) to
  the latest definitions. Integration suites for disbursement/decide stay green; add one that proves a
  `DISBURSED` transition without signed documents is still refused (mutation: re-open the branch → red).

### 3.4 PR4 `chore/comment-history-pass`
- Scope: comments (and only comments) across `app/`, `components/`, `lib/`, `scripts/`, `prisma/` (not
  migrations), `proxy.ts`, `instrumentation.ts` that narrate a previous operator's history: dated incidents
  ("the 2026-07-28 production outage"), "prod"/"staging"/"live lender" claims, person attributions ("Hein
  decided …", first names of staff), PR/issue numbers (`PR #366`, `#376`), counts of real clients/rows,
  references to files that do not exist. Find them with greps such as
  `git grep -nE '20(25|26)-[01][0-9]-[0-3][0-9]|\bprod(uction)?\b|staging|incident|outage|\bHein\b|PR #[0-9]+|#[0-9]{3}\b'`
  and read each hit. Rewrite each to state the rule and its reason in present tense; delete pure history.
  Keep statutory references (NCA sections, regulations) and legally meaningful dates of rules.
- Never touch: string literals, NCA/statutory wording in `lib/pdf/`, `lib/email/templates/`, migrations.
- **Machine proof that only comments changed:** write `scripts/check-comment-only-diff.ts` (TypeScript scanner:
  token stream without comments/whitespace) and run it over every changed `.ts/.tsx/.mjs` file, base vs head →
  identical; for `.css/.sql/.yml/.sh` changed files, show the diff is comment lines only. Test the checker
  itself (a code change → it reports the file). Paste its output.
- Report the before/after hit counts of the grep above.

## 4. Order of work
PR1 → PR2 → PR3 → PR4, each: branch (from the previous PR's branch; PR1 from `main`) → TDD → gate →
integration on a fresh DB → browser where UI changed → commit (explicit paths) → three blind reviews (§6) →
fixes → re-review → push + PR (§7) → CI green → next. Write the handoff last.

## 5. Gate for every PR
`rm -rf .next && npx tsc --noEmit` 0; `npm run lint` 0 errors after PR1 (warnings ≤ 13); `npx vitest run` no
deterministic failure (re-run flakes alone and paste); `npm run build` OK; `npm run dates:check`,
`claude-md:check`, `agents:check` OK; integration: 0 failing gated suites after PR1; the guard boundary test
green WITH the digests file present.

## 6. Reviews (blind; never self-review)
Per PR, three fresh agents given ONLY the PR's commit range + CLAUDE.md files + the PR's §3 entry: **opus**
(correctness, DB enforcement direction, security), **sonnet** (dangling refs, tests that bite, half changes),
**opus privacy** (no real personal data, no forked-lender identity, never print the digests file). Same reviewers
via SendMessage for fix rounds until all SHIP/CLEAN. Paste verdicts.

## 7. Push and PRs (pre-authorised — exactly this)
For each PR, after reviews pass: run the §2 fork-history check and paste it; `git push -u origin <branch>`
(that branch only); `gh pr create --base <main | previous PR branch> --head <branch>` with a body listing the
§8 evidence, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Wait for CI and paste
`gh pr checks <n>`. A red check is fixed with a new commit on that branch (never force-push). **Do not merge.**

## 8. Success criteria (all proven with pasted output)
- [ ] PR1: `integration-tests` green on GitHub (run URL); 0 failing gated suites locally on a fresh DB; register
      not grown (shrunk if possible); lint 0 errors; undefined-variable test + mutation red; demo passwords
      not in source; exports still download.
- [ ] PR2: route tests accept/refuse + mutation red; CSS↔runtime agreement test + mutation red; screenshots of
      a refused save (422) and of a passing tenant colour on staff app + `/login`, light + dark.
- [ ] PR3: catalog diff showing only removals/stricter guards; `migrate diff` empty; new migration applies on a
      fresh DB after the existing ones; DISBURSED-without-documents still refused (integration test + mutation).
- [ ] PR4: comment-only checker output clean over every changed file; checker's own test; grep hit counts
      before/after.
- [ ] Every PR: gate §5 pasted; three blind reviews SHIP/CLEAN on the final commit; CI green; fork-history
      check pasted before each push.
- [ ] `.claude/handoffs/LATEST.md` updated (in PR4, or PR1 if PR4 is blocked) and a dated archive copy at
      `/home/hein/Workspace/CredaFlow-archive/`; throwaway containers and dev servers stopped (identify by PID/
      name — never pattern-kill).

## 9. Confirmation gates — STOP and ask Hein
- Any push other than §7 (merge, force-push, pushing `main`, tags), or the fork-history check printing
  anything but `clean`.
- Any change to a DB guard (trigger/CHECK/UNIQUE/function) other than removing the outage branch, or any change
  to NCA/statutory wording.
- Adding a suite to `scripts/integration-baseline.txt`.
- A new runtime npm dependency; any paid action, real message, DNS change, deploy, or touching `/opt`,
  `/home/velo`, another server.
- A reviewer finds real personal data you cannot replace without changing test meaning.
