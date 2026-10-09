# Handoff — CredaFlow

**Repository:** `github.com/Heinvv10/CredaFlow` (private). `main` starts as one
initial commit holding this tree. Work branches from `main`; one branch per
change, reviewed by a fresh agent before merge.

## State

CredaFlow is a white-label loan management system for NCA-registered credit
providers. The codebase is lender-neutral: every lender's identity, brand
colours and feature flags are `TenantConfig` data, NCA documents refuse to
render without a valid identity, and a digest-based guard keeps a previous
lender's identity out of the tree. The guard's digests are deliberately not in
the repository (committed short-value digests can be reversed): keep
`~/.config/credaflow/other-lender-digests.json` on any machine that ports code
from the old codebase. Without it the guard is off. Read `CLAUDE.md`, then
`docs/ARCHITECTURE.md`.

- **Schema:** one baseline migration (`20261009000000_baseline`) plus
  `20261009120000_neutral_tenant_palette` (colour defaults only).
  `prisma migrate diff` migrations → schema is empty.
- **Seed:** neutral demo tenant "Acme" (`prisma/seed.ts`, `seed-staging.ts`);
  `SEED_PRINT_CREDENTIALS=1` prints the demo logins and TOTP secrets.
- **Palette:** indigo brand on slate neutrals, light and dark; brand tokens
  derive from the tenant's colours (`components/TenantThemeProvider.tsx`).
  Every text/surface pair is WCAG AA (`scripts/palette-contrast.ts`).
- **No deploy path.** No production or staging environment exists; hosting is
  an open decision. `Dockerfile` / `docker-compose*.yml` build and run locally.
- **Push:** this tree is to be pushed as ONE orphan commit on `main`. Nothing older
  goes to GitHub.

## Verification (at the initial commit)

- `npx tsc --noEmit` 0 errors; `npm run lint` 5 errors (the known
  `<a href="/api/reports/export/…">` pattern in `app/(dashboard)/reports/` and
  `components/compliance/FscaReturnClient.tsx`) + 13 warnings.
- `npx vitest run`: no deterministic failures. Known load flakes under a full
  parallel run, green alone: `app/api/applications/[id]/disburse`,
  `app/portal/register`, `debit-mandate`, `lib/messaging/send.test.ts`
  (fingerprint).
- `npm run build` OK (one NFT tracing warning).
- `npm run claude-md:check`, `npm run agents:check` OK.
- Integration (`scripts/run-integration-tests.sh`, fresh baseline-migrated
  Postgres 16): 167 gated suites, 9 failing, all known environment/fixture
  debt (inbox conversation-last-activity, mentions, note-mutability;
  insurance bind, quote-to-policy; loan charges-round5, charges-sync,
  small-balance-waiver; messaging retry-notification-projection), plus the
  5 suites in `scripts/integration-baseline.txt`.

## Next steps

1. Watch the first CI runs on GitHub (`integration-tests`, `agent-docs`,
   `date-boundaries`); a red run is a follow-up PR, never a force-push.
2. Decide hosting (demo on one box, real clients each on their own instance
   and database) and add a deploy path with its own gates.
3. The lint errors above: route the report exports through `next/link` or a
   button.
4. Tenant colours: the staff app, the portal and the website's `--cf-*`
   tokens follow `TenantConfig`; the website's hardcoded accent classes, the
   sign-in pages, the NCA PDFs and the emails use the default palette. A tenant's light-mode
   brand and dark background are not contrast-checked when saved — validate
   them on write (`scripts/palette-contrast.ts` has the maths).
5. The in-app manual (`lib/manual/curriculum.ts`) links `/admin-manual/videos`
   and `/admin-manual/screenshots`, which are not in the repository.
6. Forked-lender guard: CI runs it OFF (no digests file). To run it in CI,
   store the digests JSON as a GitHub Actions secret and point
   `CREDAFLOW_OTHER_LENDER_DIGESTS` at it in a job that runs
   `lib/config/legacy-identity-boundary.test.ts`. Residual misses: the brand
   glued to another lowercase word or pluralised, a suffixed host name.
7. Demo passwords are constants in `prisma/seed.ts`: rotate them (or read
   them from env) before seeding anything internet-facing.

## Open questions (owner: Hein)

- **Legal sign-off before any client goes live:** each client's legal team
  approves the rendered NCA documents (Section 129, credit agreement/PASQ,
  certificate of balance, statement, debit mandate, FAIS disclosure) and the
  website's legal pages. Render hashes are pinned in tests.
- **`section129_email`** is not seeded: the S129 email path refuses until a
  tenant creates its own legally approved template.
- **Outage-disbursement reconciliation is dead code** (untested TS paths in
  the disbursement module): delete it, or re-enable it with new tests first.
- **`LoanApplication_bureauOverrideById_fkey`** is single-column
  `ON DELETE SET NULL`, unlike its tenant-composite siblings.
- **TOTP enrolment policy** for new staff, and the `ncrStatus` wording shown
  on the website.
- **Integration debt:** the 9 failing gated suites above and the 5 register
  entries; `bind.integration` uses a hard-coded past start date. Make the
  gate green (fix or register) before relying on the CI job.
- **Inherited comment history (accepted debt):** about 470 files carry dated
  comments about the previous operator's production incidents and decisions
  (none names a lender). Neutralise them file by file, before a client
  receives the code.
- **Seed** creates no approved/disbursed applications, payments, insurance or
  compliance records: those need the product flows driven, not inserts.
