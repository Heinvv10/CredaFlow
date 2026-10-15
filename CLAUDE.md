# CredaFlow

## What This Is

A white-label loan management system for South African credit providers
registered under the National Credit Act (NCA). Multi-tenant and multi-branch,
covering the loan lifecycle end to end: apply → qualify → approve → sign →
disburse → repay → collect → close. It also ships a CRM, an insurance module,
a client portal, a public website with an AI chat, and the NCA-mandated
paperwork (Section 129 notices, credit agreements, debit mandates,
certificates of balance).

Each lender is a `Tenant`. Its identity (legal name, NCR/FSP/company numbers,
office, contacts, logo), brand colours and feature flags live in its
`TenantConfig` row; nothing about a lender is hardcoded. A deployment that has
not configured a lender's identity refuses to render an NCA document rather
than print a wrong one. `docs/ARCHITECTURE.md` explains the modules, the
tenancy/identity model and the database enforcement philosophy.

**No deploy path exists yet; production hosting is an open decision.** The
`Dockerfile` and `docker-compose*.yml` build and run the image locally; there
are no deploy scripts and no production or staging environment. No live users
or live data exist. Start a session at `.claude/handoffs/LATEST.md`.

## Behavioral Principles

1. **Think before coding.** State assumptions explicitly. If multiple
   interpretations exist, surface them — don't pick silently. Ask when
   uncertain. Push back when warranted.
2. **Simplicity first.** Minimum code that solves the stated problem. No
   speculative abstractions, no error handling for impossible scenarios.
3. **Surgical changes.** Touch only what the task requires. Match existing
   style. Don't refactor adjacent code or rewrite unrelated comments.
4. **Goal-driven.** Convert tasks into verifiable success criteria. Define the
   verification command before claiming done. Loop until verified.

## Compliance is Load-Bearing

A lender running this is regulated. Several rules are legal or audit
obligations, not style:

- **NCA documents are exact.** Section 129 notice text, credit agreement
  clauses and certificate-of-balance numbers come from `lib/pdf/*.ts`. Never
  paraphrase NCA-mandated language. A wording change needs the lender's legal
  team's sign-off before merge, and each client's legal team signs off the
  rendered documents before it goes live. Render hashes are pinned in tests
  (`lib/pdf/charges-off-identity.test.ts`, `scripts/nca-pdf-fingerprint.ts`):
  re-pin only with a proof of what changed.
- **Audit trail.** Every state-changing user action runs through
  `lib/audit.ts`. Don't bypass it for "just this one path".
- **Staff TOTP 2FA is a per-lender setting, on by default**
  (`TenantConfig.requireStaffTotp`, `lib/security/staff-totp-policy.ts`).
  While on, a staff user with no TOTP can sign in but reach only the enrolment
  page (`proxy.ts`, `lib/auth-guards.ts`), and nobody can turn their own 2FA
  off. Off, a code is demanded only of users who enrolled. Only a SUPER_ADMIN
  in a TOTP-verified session changes it, audited. Turning your own 2FA off
  always needs a current code. A SUPER_ADMIN cannot be reset by another
  SUPER_ADMIN: recovery of a locked-out SUPER_ADMIN is the operator
  break-glass CLI. Don't add staff-write paths that skip 2FA. See
  `lib/totp.ts`, `lib/auth.ts`. The one exception is the synthetic demo
  stacks: `scripts/demo/restore.sh` turns staff TOTP off, and the lender's 2FA
  setting off, when the demo app runs with `DEMO_CLEAR_STAFF_TOTP=true` (and
  again after a restore); with it plus `DEMO_MODE=true` a password-only
  session may clear a credit check (`demoStaffWithoutTotp`,
  `lib/config/demo-mode.ts`; audited as waived). Never set it on a real lender.
- **Document access is logged.** `ClientDocument` access goes through
  `lib/document-auth.ts`, which writes a `DocumentAccessLog` row — POPIA
  compliance depends on it.
- **DSAR, complaints and COI** modules exist for a reason. When in doubt, log;
  when really in doubt, ask.
- **No real personal data in the repository** — not in fixtures, tests,
  comments or docs. Use obviously synthetic values.

## The Database Enforces the Rules

Many compliance invariants live in Postgres as triggers, CHECK constraints,
partial unique indexes and functions, not only in TypeScript.

> **Green unit tests cannot see the database.** Most suites mock Prisma, and a
> mocked Prisma cannot execute a trigger or a CHECK constraint. Mocking a
> *helper* hides in-code gates the same way. A rule that only holds when it
> runs needs a `RUN_*_IT` integration test against a migrated database.

Before changing any compliance rule, enumerate the live enforcement — query
both catalogs, because triggers and plain CHECK constraints are different
blockers:

```sql
SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal;
SELECT conrelid::regclass, conname FROM pg_constraint WHERE contype = 'c';
```

and `grep -rn "CREATE TRIGGER\|ADD CONSTRAINT" prisma/migrations/`.

- **Prisma is the source of truth for the schema** (`prisma/schema.prisma`),
  but not for hand-written objects. `prisma/migrations/20261009000000_baseline`
  is the single starting migration; its hand-written section holds every
  trigger, CHECK and function. `prisma migrate dev` never diffs those: a later
  migration that changes one writes the SQL by hand and updates the static
  tests that read it (`lib/db-baseline.test-helpers.ts`).
- **Never edit a migration that has been applied to a shared database** —
  generate a new one. Never apply DDL to a shared database by hand.
- **A migration that adds enforcement is not safe to apply ahead of the code.**
  Additive, nullable columns are backward compatible. A trigger, CHECK or
  UNIQUE takes effect immediately and rejects writes the running code still
  makes, so such a migration and its code ship together.

## Tool Overrides

npm, not bun (`package.json` has no `packageManager` field). Install with
`npm ci --legacy-peer-deps`: plain `npm install` exits 0 but leaves an
incomplete tree (next-auth beta peer conflict). In a git worktree, install
there too — otherwise Node resolves the parent checkout's `node_modules` and
produces phantom failures.

```
npm run dev                  # Next.js dev server (port 3000)
npm run build                # next build
npm run lint                 # eslint
npm test                     # vitest run (unit + mocked suites)
npm run ci:quick             # type/lint/docs/date gates before pushing
npm run ci:quality           # complete local quality job
npm run ci:integration       # disposable PostgreSQL + all real-DB suites
npm run ci:full              # quality then integration
npx prisma migrate dev       # create + apply a migration locally
npx prisma migrate reset     # rebuild a local DB: migrations + seed
npx prisma generate          # regenerate the client after schema changes
```

## Verification Before "Done"

Run these in order. `npm run ci:quality` covers steps 1–4 plus the production
build; `npm run ci:full` then adds the complete integration gate using a
disposable PostgreSQL 16 container. Don't write "should work" or "Done!"
without evidence.

1. `npx tsc --noEmit` — TypeScript passes (`rm -rf .next` first if stale)
2. `npm run lint` — eslint
3. `npm test` — scope it while iterating (`npx vitest run lib/collections/`)
   but run it whole before merging. Import the module under test statically:
   an `await import("./route")` inside a test loads its whole module graph
   within that test's 5 s budget, which a full parallel run can exceed.
4. `npm run claude-md:check && npm run agents:check` — required if you touched
   CLAUDE.md, any `.claude.md`, or a skill
5. Integration suites for DB-enforced rules (below)
6. Manual exercise of the affected flow against a seeded local DB
7. NCA-document changes: render the PDF locally and compare it with the
   approved template

When you add risky logic (loan calculation, interest, NCA compliance,
payment allocation), write a test next to it — and make it fail first.

### Integration tests

`*.integration.test.ts` suites are gated behind `RUN_*_IT` variables and skip
under `npm test`. Run them against a throwaway Postgres 16:

```bash
eval "$(bash scripts/it-db.sh up cf-it-<unique>)"   # free port; exports DATABASE_URL + IT_CONTAINER
bash scripts/it-db.sh check                          # abort here if the port is not yours
npx prisma migrate deploy
bash scripts/run-integration-tests.sh
bash scripts/it-db.sh down cf-it-<unique>
```

Never hardcode a port or reuse a shared container name: sessions on this
machine collide, and a failed `docker run -p` that your script ignores points
the migrate and the suites at another session's database. `it-db.sh up` aborts
on failure and verifies the port is yours; run `it-db.sh check` before the
migrate (the runner runs the same check, but only after it). The runner also
refuses a local `DATABASE_URL` when `IT_CONTAINER` is unset, unless `CI=true`
or `REQUIRE_IT_CONTAINER=0`.

Run the teardown even when an earlier step fails, against the name you gave
`it-db.sh up`. Use `docker rm -fv`, never plain `docker rm -f`: the image keeps
its data dir in an anonymous volume, and without `-v` every run leaves 45–90 MB
behind (leaks like this reached 99 volumes, 7 GB, on velo-server in 1.5 days;
2026-10-12).

The script refuses a `DATABASE_URL` whose host is not this machine or a
docker-compose service named `db` or `postgres` (or whose query sets `host=`)
unless `ALLOW_REMOTE_TEST_DB=1`: the suites create and
delete real rows. `scripts/integration-baseline.txt` is the register of known
failing suites; it may only shrink (enforced in CI).
`prisma/seed.integration.test.ts` creates its own database, so the role needs
CREATEDB.

## Stack

- **Framework**: Next.js (App Router), TypeScript strict, Tailwind v4, shadcn/ui
- **DB**: PostgreSQL 16 via Prisma
- **Auth**: NextAuth + bcryptjs + TOTP 2FA, sessions in DB
- **Payments**: Stitch (`lib/stitch.ts`, `STITCH_*` env) and debit mandates
- **Email**: Resend + Nodemailer + IMAPflow (`lib/email/`)
- **SMS / WhatsApp**: BulkSMS (`lib/integrations/`), WhatsApp Cloud API (`lib/whatsapp/`); SMS
  is off by policy (`lib/messaging/.claude.md`)
- **KYC / credit data**: SmileIdentity, TransUnion, Experian (`lib/integrations/`)
- **PDF**: `pdf-lib` for NCA documents (`lib/pdf/`)
- **Document OCR**: a vision-language model at `VLM_API_URL` (`lib/ocr/`)
- **Scheduling**: cron routes under `app/api/cron/*`, gated by `CRON_SECRET`
- **Reports**: `recharts` (UI) + `xlsx` (Excel export)

## Theming

`app/globals.css` defines the `--cf-*` tokens for light and dark mode. The
brand tokens derive from `--cf-tenant-primary/secondary/dark`, which
`components/TenantThemeProvider.tsx` sets from the tenant's `TenantConfig`
colours. Use the tokens, not hex values. `scripts/palette-contrast.ts` (run by
`scripts/__tests__/palette-contrast.test.ts`) checks every text/surface pair
for WCAG AA in both modes, for the default and the demo tenant's colours. The
tenant admin API refuses colours that break it (`lib/theme/tenant-colours.ts`,
422 per field); `lib/theme/palette-tokens.ts` is the runtime copy of the
tokens, tested against `app/globals.css`.

## Routes Layout

```
app/
├── (website)/         # Public website (tenant's own identity)
├── (portal)/          # Client self-service (apply, sign, pay, statements)
├── (dashboard)/       # Staff app (loans, applications, collections, CRM, …)
├── (quote)/           # Insurance quote host
├── login/, forgot-password/, reset-password/
├── actions/           # Server actions
└── api/               # API routes (admin, applications, loans, payments,
                       # collections, compliance, cron, dsar, complaints, …)
```

## Key Files

- `prisma/schema.prisma` — DB models, enums, relations
- `lib/auth.ts` + `lib/auth-guards.ts` — NextAuth config + role guards
- `lib/audit.ts` — audit-log writer (use it for ALL state changes)
- `lib/permissions.ts` — RBAC helpers
- `lib/tenant.ts` + `lib/tenant-scope.ts` — tenant resolution and the Prisma
  tenant-scope extension
- `lib/config/identity.ts` — the lender identity (`getLenderIdentity`)
- `lib/loan-calculator.ts` — amortisation + NDI affordability
- `lib/qualify.ts` — pre-qualification rules
- `prisma/seed.ts` — neutral demo tenant ("Acme"; `DEMO_LENDER` picks another
  from `prisma/demo-lender.ts`), TOTP staff

## Path-Scoped Rules

Domain-specific rules live next to the code:

- `lib/pdf/.claude.md` — NCA document hygiene
- `lib/collections/.claude.md` — escalation, arrangements, Section 129
- `lib/messaging/.claude.md` — the send pipeline; SMS is OFF by policy
- `lib/integrations/.claude.md` — third-party API contracts
- `lib/bank-sync/.claude.md` — the one money-import path (statement CSV)
- `lib/bureau/.claude.md` — bureau enquiry providers, fallback, freshness
- `lib/bureau-submission/.claude.md` — bureau files; statuses are sent once
- `lib/screening/.claude.md` — PEP/sanctions screening; a sanctions match is never cleared
- `lib/fic/.claude.md` — FIC registers (CTR, STR, RMCP); tipping off; unverified threshold
- `lib/signing-otp/.claude.md` — the signing one-time code; never SMS, never stored
- `lib/security/.claude.md` — staff access policy; the IP allowlist needs a closed app port
- `lib/kyc/.claude.md` — failed-selfie override policy and database enforcement

When you discover a rule that only applies inside one of these modules, add it
there — don't pile it into root.

## Works in Claude Code AND Codex

`CLAUDE.md` is the **single canonical source**. Codex/Devin read `AGENTS.md`, so
the `AGENTS.md` files are generated mirrors — root, plus one beside every nested
`.claude.md` that clears the size bar. Do not edit an `AGENTS.md` by hand; the
gate will reject it.

```
npm run agents:mirror    # regenerate after editing CLAUDE.md or any .claude.md
npm run agents:check     # fails if a mirror is stale OR missing
```

The only transform is `.claude.md` → `AGENTS.md` in path references, one way
only: a pointer written for Claude names a file Codex never opens, so in the
mirror it is repointed at the sibling Codex does have. The rules themselves are
copied verbatim. `agents:check` compares rendered content against disk rather
than using `git diff`, because git cannot see an untracked file.

## Drift Gate

`npm run claude-md:check` validates that every `lib/...`-style path referenced
in any nested `.claude.md` exists on disk. Run it before merging docs changes.

## Pointers

- `docs/ARCHITECTURE.md` — modules, tenancy, DB enforcement, migrations, seeds, tests
- `README.md` — quick start, scripts, environment
- `.claude/handoffs/LATEST.md` — current state and next steps
