# Handoff — CredaFlow

**Repository:** `github.com/Heinvv10/CredaFlow` (private). `main` is one initial
commit. Work branches from `main`; one branch per change, reviewed by fresh
agents before merge.

## State

CredaFlow is a white-label loan management system for NCA-registered credit
providers. The codebase is lender-neutral: every lender's identity, brand
colours and feature flags are `TenantConfig` data, NCA documents refuse to
render without a valid identity, and a digest-based guard keeps a previous
lender's identity out of the tree. The guard's digests are deliberately not in
the repository: keep `~/.config/credaflow/other-lender-digests.json` on any
machine that ports code from the old codebase. Without it the guard is off.
Read `CLAUDE.md`, then `docs/ARCHITECTURE.md`.

**Four stacked PRs are open, none merged** (merge in order; each is based on
the previous one's branch):

| PR | Branch | What |
|---|---|---|
| #1 | `fix/ci-green-and-quality` → `main` | Integration gate green (9 stale fixtures fixed, register 5 → 2, lead-convert PASQ-stamp bug), lint 0 errors (exports are downloads), undefined `--cf-*` tokens and duplicate selectors removed with a test, demo passwords out of source |
| #2 | `feat/tenant-colour-validation` → #1 | Tenant colours refused with 422 per field when any text/surface pair falls below WCAG AA; maths in `lib/theme/`, runtime token copy tested against `app/globals.css`; tenant creation and colour changes audited; sign-in pages themed |
| #3 | `chore/remove-outage-reconciliation` → #2 | Dead outage disbursement exception removed (code, schema, triggers, functions, guard branches) by migration `20261009150000_…`; new CHECK `ComplianceRecord_no_disbursement_exception` keeps the old trigger's refusal (approved at the confirmation gate); two integration flakes fixed |
| #4 | `chore/comment-history-pass` → #3 | Comments that narrated a previous operator's history rewritten as rules; `scripts/check-comment-only-diff.ts` proves the pass changed comments only |

- **Schema:** baseline + `20261009120000_neutral_tenant_palette` +
  `20261009150000_remove_outage_disbursement_exception` (with #3).
  `prisma migrate diff` migrations → schema is empty.
- **Seed:** neutral demo tenant "Acme". Demo passwords are generated on first
  creation or set by `SEED_ADMIN_PASSWORD` / `SEED_OFFICER_PASSWORD` /
  `SEED_PORTAL_PASSWORD`; `SEED_PRINT_CREDENTIALS=1 npx prisma migrate reset
  --force` prints them. A database seeded before #1 still accepts the old
  published passwords until it is reseeded with all three variables set.
- **No deploy path.** No production or staging environment exists; hosting is
  an open decision.

## Verification (at #4's head, all PRs' CI green on GitHub)

- `npx tsc --noEmit` 0; `npm run lint` 0 errors, 13 warnings; `npx vitest run`
  no failures (load flakes under a full parallel run, green alone:
  `app/api/applications/[id]/disburse`, `app/api/insurance/policies/draft`,
  `lib/messaging/send.test.ts` fingerprint); `npm run build` OK.
- Integration (`scripts/run-integration-tests.sh`, fresh Postgres 16): 85 gated
  suites pass, 2 in `scripts/integration-baseline.txt`. CI installs
  `poppler-utils` for the suites that read rendered PDFs.

## Next steps

1. Merge #1 → #2 → #3 → #4 (rebase each onto `main` as the one below lands).
2. Reseed any database seeded before #1 with all three `SEED_*_PASSWORD` set
   (the old literals are in `main`'s public history).
3. The two register suites (`submission-lock`, `credit-life-containment-
   migration`) need a shared fixture for a fully countersigned, disbursable
   PASQ v3 application; the builder in
   `lib/compliance/pasq-v3-billing-migration.integration.test.ts` is the
   starting point. Some of credit-life-containment's expected errors will be
   pre-empted by earlier PASQ v3 guards and need re-deciding.
4. Decide hosting and add a deploy path with its own gates. The deployment must
   schedule the externally owned cron routes (`instrumentation.cron-census.test.ts`
   lists them); nothing in this repo does.

## Open questions (owner: Hein)

- **Legal sign-off before any client goes live:** each client's legal team
  approves the rendered NCA documents and the website's legal pages. Render
  hashes are pinned in tests; a pin proves the render has not moved, not that
  it is approved.
- **`section129_email`** is not seeded: the S129 email path refuses until a
  tenant creates its own legally approved template.
- **`LoanApplication_bureauOverrideById_fkey`** is single-column
  `ON DELETE SET NULL`, unlike its tenant-composite siblings.
- **TOTP enrolment policy** for new staff, and the `ncrStatus` wording on the
  website.
- **Strings still carry history** the comment pass could not touch (string
  literals were out of scope): test names with review IDs or a person's name
  (e.g. `lib/referral-agents/commission-backfill.test.ts`), the recipient-guard
  error text, `[CRITICAL-n]`/`[IMPORTANT-n]` test titles, and "OPEN GAP (date)"
  entries in the cron census. `lib/email/templates/` was outside the comment
  pass apart from one comment in `section129.ts` that named a real business;
  the rest of that folder has not been reviewed for history.
- **Known limits:** the credit agreement truncates schedules beyond 38 rows
  (nothing upstream caps instalments); `lib/db-baseline.test-helpers.ts` only
  recognises `DROP` / `CREATE OR REPLACE` in the `public."x"` one-line form;
  two concurrent super-admin colour PATCHes are each validated against the set
  read outside the transaction; `/portal/register` is not tenant-themed.
- **Forked-lender guard in CI:** CI runs it off (no digests). To run it there,
  store the digests JSON as an Actions secret and point
  `CREDAFLOW_OTHER_LENDER_DIGESTS` at it.
- **Seed** creates no approved/disbursed applications, payments, insurance or
  compliance records: those need the product flows driven, not inserts.
