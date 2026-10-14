# Handoff — Asset finance slice 2 servicing

**Date:** 2026-10-14

**Branch:** `feat/asset-finance-slice2-servicing`

**Pull request:** #66, stacked on #65

**Stack base:** `feat/asset-finance-slice2` (PR #65, open)

**Environment:** local development only. CredaFlow has no staging or production deploy path, live users, or live data.

## Outcome

This branch completes the local slice-2 servicing path on top of the NCA
origination and booking work in PR #65:

- Natural-person and juristic-person NCA deals can complete quote acceptance,
  credit-life evidence, PASQ, signing, countersigning and booking.
- Juristic-person documents and signing use the entity's legal identity and
  authorised representative.
- Section 129 output resolves a juristic debtor's registered address and active
  authorised contact.
- Section 127 voluntary surrender records the request, valuation, valuation
  notice, sale proceeds and final surplus/shortfall notice. Mutation routes are
  audited and database guards enforce sequencing and tenant-safe references.
- Portal pages expose the relevant NCA actions and surrender status.
- The neutral demo seed includes a natural-person NCA deal, a juristic-person
  NCA deal and a non-NCA finance lease. Five browser walkthrough screenshots
  are committed under `docs/asset-finance/evidence/slice2/`.

## Verification evidence

Passed on this branch:

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`: 1,040 files passed, 150 skipped; 14,519 tests passed, 1,502 skipped
- `npm run build`: 229 static pages generated; known Turbopack NFT tracing
  warning from `next.config.ts` through the insurance-disclosures route only
- `npm run claude-md:check && npm run agents:check`: all path and 10 mirror
  checks passed
- Explicit NCA/PDF checks: 3 files, 9 tests passed
- Clean `prisma migrate reset --force` and seed against throwaway PostgreSQL 16
- `prisma migrate diff`: no schema difference detected
- Full database integration gate: 146 files passed, 2 skipped; 1,480 tests
  passed, 2 skipped; `integration gate OK`
- Targeted deal integration suite after the final surrender-payment FK: 15/15
- `git diff --check`

The statement-accuracy integration suite remains intentionally skipped by its
existing gate. No shared database migration was run.

## Evidence files

- `natural-nca-tlb-loan.png`
- `natural-nca-s127.png`
- `entity-nca-business-portal.png`
- `entity-nca-finance-lease.png`
- `entity-nca-s127.png`

All are in `docs/asset-finance/evidence/slice2/` and contain synthetic data.

## Legal assumptions and explicit markers

These are implementation defaults, not approved legal positions:

- `lib/asset-finance/nca-caps.ts` uses a maximum service fee of R60 including
  VAT, Regulation 42 repossession plus 17%, and the initiation-fee formula.
  Each is marked `UNTESTED` pending citation and lender legal approval.
- The finance-lease path uses the same schedule engine, treats residual as the
  balloon and records VAT on the full price at inception. Its tax treatment is
  not final and needs the lender's tax memo.
- `lib/asset-finance/schedule-records.ts` marks the NCA treatment of capitalised
  interest `UNTESTED`.
- `lib/asset-finance/surrender-calculation.ts` marks Section 127
  shortfall/refund treatment and its legal citation `UNTESTED`.
- `lib/asset-finance/surrender-store.ts` marks the 10 South African business-day
  valuation window and citation `UNTESTED`.
- `lib/asset-finance/reprice-loan.ts` is `PARTIAL`: contract variations still
  need a re-signed agreement, and a VAT-deferral lump is not modelled.
- `lib/asset-finance/reprice-notice.ts` is `PARTIAL`: the notice is generated
  but is not sent or queued.
- Section 125 settlement uses the existing settlement/receipt engine; the exact
  statutory computation still requires legal confirmation.
- NCA document language remains visibly DRAFT placeholder wording. Do not
  remove the watermark or ship the documents without lender legal sign-off and
  approved render comparison.
- Bureau submission includes natural-person NCA accounts and excludes
  juristic-person NCA accounts pending a confirmed legal position.
- Section 129 uses the entity registered address plus an active authorised
  contact.
- The juristic NCA credit-life path records an offered/accepted-or-declined
  representative decision; the demo entity declines. The natural-person demo
  accepts the bundled policy.
- Physical repossession and remarketing are out of scope.

## Delivery boundary and next actions

- Do not merge PR #65 or this stacked branch without owner approval.
- Do not apply migrations to a shared database, enable non-draft legal output,
  or deploy without a separate confirmation gate.
- GitHub Actions on PRs #65 and #66 fail before job execution because recent
  account payments failed or the spending limit must be increased. All four
  #66 jobs (`docs`, `boundaries`, `integration`, `quality`) stopped in 1–2
  seconds without running repository steps. Local gates above are green, but
  CI is not green proof.
- A blind independent review was not performed in this run because delegation
  was unavailable. It remains required before merge.
- Once GitHub billing is restored: rerun PR #65, rebase this branch if needed,
  run the stacked PR's checks, obtain independent SHIP/CLEAN review, and then
  stop for the merge/legal/migration gates.
