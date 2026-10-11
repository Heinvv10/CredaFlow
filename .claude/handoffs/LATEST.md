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

**Thirteen stacked PRs, none merged.** Merge them in order; each is based on the
previous one's branch. Every one has green CI and three blind reviewers'
SHIP/CLEAN on its final commit.

| PR | Branch | What |
|---|---|---|
| #1 | `fix/ci-green-and-quality` → `main` | Integration gate green (9 stale fixtures fixed, register 5 → 2, lead-convert PASQ-stamp bug), lint 0 errors (exports are downloads), undefined `--cf-*` tokens and duplicate selectors removed with a test, demo passwords out of source |
| #2 | `feat/tenant-colour-validation` → #1 | Tenant colours refused with 422 per field when any text/surface pair falls below WCAG AA; maths in `lib/theme/`, runtime token copy tested against `app/globals.css`; tenant creation and colour changes audited; sign-in pages themed |
| #3 | `chore/remove-outage-reconciliation` → #2 | Dead outage disbursement exception removed (code, schema, triggers, functions, guard branches) by migration `20261009150000_…`; new CHECK `ComplianceRecord_no_disbursement_exception` keeps the old trigger's refusal (approved at the confirmation gate); two integration flakes fixed |
| #4 | `chore/comment-history-pass` → #3 | Comments that narrated a previous operator's history rewritten as rules; `scripts/check-comment-only-diff.ts` proves the pass changed comments only |
| #5 | `ci/quality-gate` → #4 | `quality-gate.yml`: tsc, lint, vitest, build, claude-md and agents checks on every PR and push to `main`; read-only, no secrets. It installs poppler-utils and qpdf and gives tsc/build a 4 GB heap. Also fixes a `send.test.ts` test that depended on two sends landing in the same millisecond |
| #8 | `test/pasq-v3-disbursable-fixture` → #5 | Shared PASQ v3 application fixture (`lib/compliance/pasq-v3-application.integration-fixture.ts`); `submission-lock` revived on it and out of the register (2 → 1) |
| #9 | `chore/string-history-pass` → #8 | Test titles, runtime messages and a few comments lose review IDs, phase/round labels, names and dates |
| #10 | `ci/hardening` → #9 | Every workflow `uses:` pinned to a commit SHA with a version comment (guard test); lint 13 warnings → 0 with no rule disabled; 17 suites import the module under test statically, so the first test no longer loads the route graph inside its 5 s budget |
| #11 | `fix/tenant-colour-patch-race` → #10 | Colour PATCH validates under `FOR NO KEY UPDATE` on the Tenant row, inside the write's transaction; real-PG race suite `RUN_TENANT_COLOUR_RACE_IT` (existing and missing config row) |
| #12 | `fix/portal-register-theming` → #11 | `/portal/register` renders inside `TenantThemeProvider` like the other sign-in pages; its indigo tints use the brand token |
| #13 | `test/db-baseline-helper-forms` → #12 | `lib/db-baseline.test-helpers.ts` splits migrations into SQL statements (comments, strings, `$tag$` bodies) and reads multi-line, unqualified and multi-object DDL; identical results on every existing migration |
| #14 | `fix/crm-convert-term-bounds` → #13 | CRM lead conversion refuses a term outside the product's min/max (422, nothing written), as the staff wizard and portal already did |
| #15 | `feat/crm-convert-term-field` → #14 | The CRM convert form gets a "Term (days)" field like the portal's (product-bounded, defaults to the maximum, hidden for fixed-term products) |

(#6 and #7 were throwaway PRs used to prove the quality gate fails; both are
closed and their branches deleted.)

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

## Verification (local, at the top of the stack)

CI runs `quality-gate`, `integration-tests`, `agent-docs` and
`date-boundaries`. Local results, run against a fresh Postgres 16:

- `npx tsc --noEmit` 0
- `npm run lint`: 0 errors, 0 warnings
- `npx vitest run`: 0 failed, three consecutive full runs (with #10)
- `npm run build` OK
- `dates:check`, `test:tz`, `claude-md:check` and `agents:check` OK
- the identity-boundary test passes
- Integration (`scripts/run-integration-tests.sh`): 87 gated suites pass, 1 in
  `scripts/integration-baseline.txt`.

## Next steps

1. Merge #1 → #2 → #3 → #4 → #5 → #8 → #9 → #10 → #11 → #12 → #13 → #14 → #15, rebasing each onto `main` as the one
   below lands.
2. Reseed any database seeded before #1 with all three `SEED_*_PASSWORD` set
   (the old literals are in `main`'s public history).
3. Decide the last register suite, `credit-life-containment-migration` (see
   "Open questions").
4. Decide hosting and add a deploy path with its own gates. The deployment must
   schedule the externally owned cron routes (`instrumentation.cron-census.test.ts`
   lists them); nothing in this repo does.

## Open questions (owner: Hein)

- **Credit-life containment suite.** It cannot be revived on the PASQ v3 fixture
  without owner decisions:
  - **Guards not attached.** The bundled credit-life guard functions it tests
    exist in the baseline migration but are attached to no trigger:
    `guardBundledCreditLifeAgreement`, `guardCreditLifeProductIdentity`,
    `assertDisbursedCreditLifeCommitInvariant` and related. Most of its
    expected rejections never fire, so the first decision is whether to
    reattach them (a DB-guard migration).
  - **Pre-empted by earlier guards.** With them reattached, some expectations
    are still pre-empted by earlier guards: the signed-evidence rewrite, the
    agreement-sha change, the document retirement and product `active:false`.
  - **Cannot arrange.** The missing and malformed election scenarios can't be
    set up, because completed agreement artifacts are immutable.
  - **Weakened race.** One race assertion now rejects at an earlier step.

  The full per-assertion table is in PR #8's description.
- **Legal sign-off before any client goes live:** each client's legal team
  approves the rendered NCA documents and the website's legal pages. Render
  hashes are pinned in tests; a pin proves the render has not moved, not that
  it is approved.
- **Section 129 email:** by default (`MESSAGING_NEW_SEND_S129` unset) the
  S129 routes send the cover email from the code template
  `lib/email/templates/section129.ts`, whose wording no client's legal team has
  reviewed. With the flag on, they use the tenant's `section129_email`
  `MessageTemplate` instead — which is not seeded, so that path refuses until a
  tenant creates its own legally approved template.
- **`LoanApplication_bureauOverrideById_fkey`** is single-column
  `ON DELETE SET NULL`, unlike its tenant-composite siblings.
- **TOTP enrolment policy** for new staff, and the `ncrStatus` wording on the
  website.
- **History left in UI copy and names.** The string pass changed no customer-facing
  UI copy (one staff-manual key rule lost a review ID); these remain:
  - "Run the S2 backfill to populate." on the contacts page
  - "until Phase 7 go-live" in `IntegrationsTab.tsx`

  Also untouched: the `charges-round{2..5}-regressions` and
  `default-charges.review` file names, and `lib/email/templates/` beyond one
  comment. Test fixtures use the placeholder phone `+27820000000`, a dialable
  SA number.
- **Known limits:**
  - The credit agreement (and the Form 20 quotation, same renderer) prints at
    most 38 schedule rows and silently drops the rest, while its TOTAL row sums
    the full schedule. Nothing caps instalments: the seeded PERSONAL product
    allows 1,800 days (60 instalments). The portal and the CRM convert form
    default the term field to the product's maximum (the staff wizard starts
    it empty), so an untouched PERSONAL application from either is 60
    instalments. `lib/pdf/statement.ts` has the same
    ~37-row cut. Options are an upstream cap or a continuation page; an NCA
    document change needs Hein's and legal sign-off.
  - `lib/__tests__/webhook-replay.test.ts` runs whenever `DATABASE_URL` is set
    (not behind a `RUN_*_IT` gate) and its fixture creates an
    APPROVED application without a PASQ document, which the
    `lockLoanApplicationPasqDocument` trigger refuses on a migrated database. CI's quality job sets no `DATABASE_URL`, so it skips there.
  - CRM lead conversion does not check `appliedAmount` against the product's
    min/max, nor that it is a positive number (the staff wizard and portal do).
  - The page background's indigo radial glow (`app/globals.css`) is not
    tenant-themed on any page.
  - The baseline helpers do not tell function overloads apart, nor scope
    triggers and constraints to their table.
- **Forked-lender guard in CI:** CI runs it off (no digests). To run it there,
  store the digests JSON as an Actions secret and point
  `CREDAFLOW_OTHER_LENDER_DIGESTS` at it.
- **Seed** creates no approved/disbursed applications, payments, insurance or
  compliance records: those need the product flows driven, not inserts.
