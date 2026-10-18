# Surety consent proof retention: concurrent first reference

Reviewed candidate: `23100c04` (the relevant application and commercial guard
blobs are identical in `2ecf46d0` and `99389a00`). All data was synthetic in a
separate clone and a unique disposable PostgreSQL 16 container.

## Original failure

The regression committed in `f2079d11` reproduced this ordering against the
fully migrated candidate, with every existing trigger and CHECK enabled:

1. Transaction A inserts valid in-community surety consent, referencing a live
   staff-uploaded legal document of its deal. It remains uncommitted.
2. Transaction B soft-deletes that document and commits. Its retention trigger
   cannot see the uncommitted consent.
3. Transaction A commits. Its consent now references deleted proof.

The assertion that the committed consent's evidence had `deletedAt = null`
failed. The original log was `/tmp/cf-security-race-result.log`. The payout
guard still refuses deleted proof; this finding concerns retained evidence.

## Correction and verification

New migration `20261018130000_surety_consent_evidence_lock` adds a function and
the alphabetically first `SuretyConsent_00_evidence_lock` trigger. It locks the
deal and then the proof before the existing legal/timing validation. It does
not replace or weaken an existing function, trigger or CHECK. The server
helper takes the same proof lock before reading live evidence.

Fresh databases: `cf-it-security-fix-20261018` and final repeat
`cf-it-security-final-20261018`; ownership checked with
`scripts/it-db.sh check` before migrating. All migrations deployed successfully.
Both race tests observe an actual PostgreSQL lock wait through
`pg_stat_activity`, then release the first transaction:

- Consent first: deletion waits, then the unchanged evidence retention guard
  refuses it; the committed consent retains live proof.
- Deletion first: consent waits, then the unchanged legal validation sees the
  committed deletion and refuses the consent. No consent row is created.

Command (with the disposable database URL and container exported):

```sh
RUN_ASSET_FINANCE_SIGNING_IT=1 RUN_ASSET_FINANCE_BOOKING_IT=1 npx vitest run \
  lib/asset-finance/security-surety-race.integration.test.ts \
  lib/asset-finance/payout-booking.integration.test.ts
```

Result: **2 files, 16 tests passed**, including existing consent chronology,
retained-proof and payout guard checks. Targeted ESLint and
`npx tsc --noEmit` passed. The live catalog
confirmed the new lock trigger precedes `SuretyConsent_legal_guard` and
`SuretyConsent_timing`, alongside all nine existing document guards and the
three existing document/consent CHECK constraints.

The disposable databases were removed with `scripts/it-db.sh down`, including
their volumes. No shared database, source worktree, external payment, message,
deployment or lender flag was changed. Full integrated gates remain the
coordinator's responsibility after cherry-picking.
