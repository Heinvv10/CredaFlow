# Slice 5 follow-ups: mutation evidence

## Part D (dealer consent v2, draft cancel, draft purge)

Database: a throwaway PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5fd-*`,
`npx prisma migrate deploy`. Suites run with
`RUN_ASSET_FINANCE_DEALER_IT=1 TENANT_RLS=on npx vitest run --no-file-parallelism <suite>`.

### Before the migration

The three new suites against a database migrated to
`20261021090300_valuation_guide_review_fixes` (the part D migration held back):

```
 Test Files  3 failed (3)
      Tests  22 skipped (22)
PrismaClientKnownRequestError: The column `BusinessEntity.dealerPurgedAt` does not exist in the current database.   (x3, each suite's beforeAll)
```

### After

```
lib/dealer/dealer-consent-v2.integration.test.ts   Tests  6 passed (6)
lib/dealer/dealer-cancel.integration.test.ts       Tests  8 passed (8)
lib/dealer/draft-purge.integration.test.ts         Tests  8 passed (8)
lib/dealer/ (all 46 dealer suites)                 Test Files  46 passed (46)   Tests  416 passed (416)
```

### Mutations

Each database mutation is applied to the migrated throwaway database, the
named suite run, then the object restored exactly as the migration creates it
(`CREATE OR REPLACE` / re-add). Each code mutation is an edit to the file, the
suite run, then the file restored byte for byte. Every mutation turned a named
test red; after restoring, every suite was green again.

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| M1 | `DROP CONSTRAINT "DealerConsentAttestation_signing_method"` | `dealer-consent-v2` | 1 failed, 5 passed | refuses by SQL a row without a method, a remote one without a check, an in-person one with one, and a short check |
| M2 | `DROP TRIGGER "DealerConsentAttestation_current_version"` | `dealer-consent-v2` | 1 failed, 5 passed | refuses a new dealer-consent-v1 attestation |
| M3 | `DROP TRIGGER "AssetFinanceDeal_dealer_cancel"` | `dealer-cancel` | 3 failed, 5 passed | refuses a dealer cancellation once handed over or past DRAFT; refuses another dealer's user, a sales colleague and an inactive creator; keeps a dealer-cancelled deal terminal |
| M4 | `AssetFinanceDeal_cancellation_shape` with `num_nonnulls(...) >= 1` | `dealer-cancel` | 1 failed, 7 passed | refuses a cancellation naming both a staff and a dealer canceller, or none |
| M5 | `dealerDealPurgeReason`: abandoned after 80 days | `draft-purge` | 1 failed, 7 passed | leaves a draft active within 90 days, and names it at 91 |
| M6 | `dealerDealPurgeReason`: CANCELLED_DRAFT without `dealerSubmittedAt IS NULL` | `draft-purge` | 1 failed, 7 passed | keeps a handed-over deal that ended three years, not 90 days (NCA Regulation 55) |
| M7 | `dealerPurgeLinkedElsewhere` returns FALSE first | `draft-purge` | 1 failed, 7 passed | keeps a person who is also a sole proprietor on another live deal |
| M8 | `guardDealerPurgedParty` without the `createdByDealerId` check | `draft-purge` | 1 failed, 7 passed | refuses erasing a staff-captured person, and erasing twice |
| M9 | `DROP TRIGGER "DealerDealPurge_guard"` | `draft-purge` | 1 failed, 7 passed | refuses a tombstone for a deal it does not name, and never changes or deletes one |
| M10 | `draft-purge.ts`: people erased without the linked-elsewhere check | `draft-purge` | 1 failed, 7 passed | keeps a person who is also a sole proprietor on another live deal (the database refused the erase) |
| M11 | `draft-purge.ts`: every document deleted, referenced or not | `draft-purge` | 1 failed, 7 passed | erases an abandoned draft's people, business and documents; keeps the deal, attestation, tombstone and audit |
| M12 | `cancel.ts`: no own-draft check for a sales user | `dealer-cancel` | 1 failed, 7 passed | is 404 for another dealer's draft and for a sales colleague's, and changes nothing |
| M13 | `consent.ts`: signing method not checked before writing | `dealer-consent-v2` | 1 failed, 5 passed | refuses a remote signing without the identity check before writing anything |
