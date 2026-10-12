# Handoff — CredaFlow

**Repository:** `github.com/Heinvv10/CredaFlow` (private). `main` grows from one
orphan initial commit (`51c387e`); the old fork's history never goes to GitHub.
Work branches from `main`; one branch per change, reviewed by fresh agents
before merge.

## State

CredaFlow is a white-label loan management system for NCA-registered credit
providers. The codebase is lender-neutral: every lender's identity, brand
colours and feature flags are `TenantConfig` data, NCA documents refuse to
render without a valid identity, and a digest-based guard keeps a previous
lender's identity out of the tree. The guard's digests are deliberately not in
the repository: keep `~/.config/credaflow/other-lender-digests.json` on any
machine that ports code from the old codebase. Without it the guard is off.
Read `CLAUDE.md`, then `docs/ARCHITECTURE.md`.

**Twenty-one PRs, all merged into `main` on 2026-10-11** (#1–#5 and #8–#23, as
merge commits in this order). They were stacked, each on the previous one's
branch, and each had green CI and three blind reviewers' SHIP/CLEAN on its
final commit. #6 and #7 were throwaway PRs that proved the quality gate fails.

Follow-ups #30–#34 carry Hein's 2026-10-12 decisions. Each was branched from
`main`, had three blind reviewers' SHIP/CLEAN on its final commit, and is merged
before the PR that added this paragraph:

| PR | Branch | What |
|---|---|---|
| #30 | `fix/loan-product-amount-check` | Migration `20261012090000_loan_product_amount_bounds`: validated CHECK `LoanProduct_amount_bounds` (`minAmount > 0 AND maxAmount >= minAmount`); real-PG suite `RUN_LOAN_PRODUCT_AMOUNT_CHECK_IT` |
| #31 | `fix/approve-with-loan-409` | Approving an application that already has a loan answers 409 (the approve transaction flushes deferred constraints), like decline |
| #32 | `feat/portal-amount-starts-empty` | The portal apply amount starts empty; the credit-life block is hidden until the amount is valid |
| #33 | `fix/website-apply-requires-term` | The website apply route refuses a missing or invalid term (400, nothing written) when the request would create an application on a variable-term product, instead of storing 30 days; lead-only submissions still need no term; the website form gains a required term field and sends the catalogue's fixed term for fixed-term products |
| #34 | `test/webhook-replay-on-migrated-db` | The Stitch payment webhook runs in the loan's tenant (it 500'd on every webhook and stamped the default tenant); `webhook-replay` is a gated integration suite (`RUN_WEBHOOK_REPLAY_IT`) |

| PR | Branch → base at the time | What |
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
| #16 | `fix/crm-convert-amount-bounds` → #15 | CRM lead conversion refuses a missing, non-positive, over-precise or out-of-range amount (422, nothing written), as the portal does |
| #17 | `fix/crm-convert-recovery-scope` → #16 | CRM lead conversion refuses `recoveryApplicationId` on a lead with no linked client, which skipped the amount and Regulation 23A checks and could create a zero-amount application |
| #18 | `fix/loan-product-bounds` → #17 | The loan product API (create and update) refuses a non-numeric, non-positive or over-int4 amount or term, or a minimum above the maximum (422, nothing written); no policy cap on amount or term |
| #19 | `fix/application-amount-check` → #18 | New migration `20261010120000_application_amount_positive`: validated CHECK `LoanApplication_appliedAmount_positive` (`appliedAmount > 0`); real-PG suite `RUN_APPLICATION_AMOUNT_CHECK_IT` |
| #20 | `feat/term-starts-empty` → #19 | The portal apply form and the CRM convert form start the term empty for variable-term products (like the staff wizard); submit stays disabled until a valid term is entered |
| #21 | `fix/credit-life-guards` → #20 | New migration `20261010180000_attach_credit_life_guards`: attaches the 15 bundled credit-life triggers; `assertDisbursedCreditLifeCoverage` leaves loans on DRAFT/SUBMITTED/UNDER_REVIEW applications out of the commit invariant; validated CHECK `InsuranceProduct_credit_life_terms_positive` (a CREDIT_LIFE product needs premium and cover above zero); indexes on `LoanApplication.agreementDocumentId` and `Loan.agreementDocId` (owner decisions D1–D3 and the CHECK). `credit-life-containment-migration` revived on the PASQ v3 fixture; the register is empty. The product API refuses non-positive credit-life terms (422) and the offer selector skips them; the policy PATCH answers 422 when a bundled credit-life policy's premium or renewal date would change; declining an application that has a loan answers 409 |
| #22 | `fix/nca-schedule-continuation` → #21 | The credit agreement, the Form 20 quotation and the statement print every schedule, payment-history and reversed-payment row on continuation pages (no new wording; TOTAL once after the last row); documents whose tables fit one page are byte-identical and no existing render pin changed |
| #23 | `fix/credit-life-premium-rounding` → #22 | The credit-life monthly premium is computed in exact integer cents and rounds half up like the database's `ROUND(numeric)` (it used floating point and disagreed on half-cent ties, e.g. R1,010: 454c vs 455c); real-PG suite `RUN_CREDIT_LIFE_PREMIUM_ROUNDING_IT` |

- **Schema:** baseline + `20261009120000_neutral_tenant_palette` +
  `20261009150000_remove_outage_disbursement_exception` (with #3) +
  `20261010120000_application_amount_positive` (with #19) +
  `20261010180000_attach_credit_life_guards` (with #21) +
  `20261012090000_loan_product_amount_bounds` (with #30).
  `prisma migrate diff` migrations → schema is empty.
- **Seed:** neutral demo tenant "Acme". Demo passwords are generated on first
  creation or set by `SEED_ADMIN_PASSWORD` / `SEED_OFFICER_PASSWORD` /
  `SEED_PORTAL_PASSWORD`; `SEED_PRINT_CREDENTIALS=1 npx prisma migrate reset
  --force` prints them. A database seeded before #1 still accepts the old
  published passwords until it is reseeded with all three variables set.
- **No deploy path.** No production or staging environment exists; hosting is
  an open decision.

## Verification (measured at #23, the top of the merged stack)

CI runs `quality-gate`, `integration-tests`, `agent-docs` and
`date-boundaries`. `main` after the merge has the same tree as #23's head and
its CI is green; `integration-tests` runs on pull requests and nightly, not on
push, so it was run on `main` by hand (green). Local results, run against a
fresh Postgres 16:

- `npx tsc --noEmit` 0
- `npm run lint`: 0 errors, 0 warnings
- `npx vitest run`: 0 failed, three consecutive full runs (with #10)
- `npm run build` OK
- `dates:check`, `test:tz`, `claude-md:check` and `agents:check` OK
- the identity-boundary test passes
- Integration (`scripts/run-integration-tests.sh`): 89 gated suites, 88 pass
  and the OCR accuracy suite skips (it needs `RUN_VLM_ACCURACY` and a VLM);
  `scripts/integration-baseline.txt` is empty (with #21).

## Next steps

1. Reseed any database seeded before #1 with all three `SEED_*_PASSWORD` set
   (the old literals are in `main`'s public history).
2. Migrate any existing database through #19's and #21's validated CHECKs:
   one holding a `LoanApplication` with `appliedAmount` ≤ 0, or a CREDIT_LIFE
   `InsuranceProduct` with a premium or sum assured ≤ 0, fails
   `prisma migrate deploy` until that row is fixed or deleted.
3. Decide hosting and add a deploy path with its own gates. The deployment must
   schedule the externally owned cron routes (`instrumentation.cron-census.test.ts`
   lists them); nothing in this repo does.

## Open questions (owner: Hein)

- **Credit-life guards (#21).** The triggers have never run against a real
  credit-life product and insurer: disburse one by hand on a seeded database
  before any client goes live. The demo seed's loan
  sits on a DRAFT application, which therefore can never be approved or
  declined: both answer 409 (#21, #31).
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
- **Out-of-range terms on the website apply route** are still clamped into the
  product's range (#33 refuses only a missing or invalid term; the form
  validates the range). Confirm that clamping stays.
- **Default-tenant stamping.** These handlers write the default tenant rather
  than the record's own: `app/api/clients/[id]/consent/route.ts` (POPIA consent
  records), five actions in `app/actions/crm.ts`, `app/actions/lead-activities.ts`,
  and `app/api/loans/[id]/debit-mandate/route.ts` (fallback only). Harmless with
  one database per lender; wrong if a database ever holds several tenants.
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
  - Long NCA documents are new renders (#22): a schedule beyond 38 rows (37 on
    the statement) continues on extra pages that repeat the existing title and
    column headers. Each lender's legal team must sign off a rendered long
    schedule before go-live; samples are rendered by
    `scripts/ops/render-pasq-review.ts` and
    `scripts/ops/render-executed-agreement-review.ts`. A 39-row schedule puts
    row 39 and TOTAL alone on the continuation page. PASQs and agreements
    already stored with more than 38 rows stay truncated (execution stamps the
    stored bytes). Nothing caps instalments: the seeded PERSONAL product allows
    1,800 days (60 instalments); the portal, the CRM convert form and the staff
    wizard start the term empty (#20).
  - `lib/__tests__/runtime-tenant-isolation.test.ts` runs whenever
    `DATABASE_URL` is set rather than behind a `RUN_*_IT` gate.
  - The page background's indigo radial glow (`app/globals.css`) is not
    tenant-themed on any page.
  - The baseline helpers do not tell function overloads apart, nor scope
    triggers and constraints to their table.
- **Forked-lender guard in CI:** CI runs it off (no digests). To run it there,
  store the digests JSON as an Actions secret and point
  `CREDAFLOW_OTHER_LENDER_DIGESTS` at it.
- **Seed** creates no approved/disbursed applications, payments, insurance or
  compliance records: those need the product flows driven, not inserts.
