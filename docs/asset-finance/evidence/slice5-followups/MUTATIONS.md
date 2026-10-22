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

### After (first build)

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

### Review round 1 fixes: re-run

After review round 1 (purge narrowed to drafts the lender never received,
DSAR/complaint hold, stale sibling drafts, text-only links, document scope,
closed purged drafts, consent wording, code-point lengths), on a fresh
database from the final migration (`cf-it-s5fd-a5`):

```
lib/dealer/ (all dealer suites)   Test Files  52 passed | 1 skipped (53)   Tests  452 passed | 1 skipped (453)
```

Every mutation below was applied, its suite run, and the object or file
restored (database objects as the migration creates them, files byte for
byte). M18 first survived (the CRM-linked person was also kept by a
lender-added relationship); the test was split so the CRM row is the only
link, and M18 then failed it.

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| M1 | `DROP CONSTRAINT "DealerConsentAttestation_signing_method"` | `dealer-consent-v2` | 1 failed, 6 passed | refuses by SQL a row without a method, … and a short check |
| M2 | `DROP TRIGGER "DealerConsentAttestation_current_version"` | `dealer-consent-v2` | 1 failed, 6 passed | refuses a new dealer-consent-v1 attestation |
| M3 | `DROP TRIGGER "AssetFinanceDeal_dealer_cancel"` | `dealer-cancel` | 5 failed, 5 passed | handed over or past DRAFT; another dealer's user / colleague / inactive; inactive creator or admin; staff deal, new deal; dealer-cancelled deal terminal |
| M4 | `AssetFinanceDeal_cancellation_shape` with `>= 1` | `dealer-cancel` | 1 failed, 9 passed | refuses a cancellation naming both … or none |
| M5 | `dealerDealPurgeReason`: abandoned after 80 days | `draft-purge` | 1 failed, 9 passed | leaves a draft active within 90 days, and names it at 91 |
| M6 | `dealerDealPurgeReason`: handed-over deals not excluded | `draft-purge` | 1 failed, 9 passed | never names a deal handed to the lender, however old |
| M7 | `dealerPurgeLinkedElsewhere` returns FALSE first | `draft-purge-scope` | 3 failed | business with another live deal; lender-added person and CRM link (then one test); documents |
| M8 | `guardDealerPurgedParty` without the `createdByDealerId` check | `draft-purge` | 1 failed, 9 passed | refuses erasing a staff-captured person, and erasing twice |
| M9 | `DROP TRIGGER "DealerDealPurge_guard"` | `draft-purge` | 1 failed, 9 passed | refuses a tombstone for a deal it does not name, … |
| M10 | `draft-purge.ts`: people erased without the linked check | `draft-purge-scope` | 4 failed, 2 passed | the database refused each erase the TypeScript planned |
| M11 | `draft-purge.ts`: every erased document row deleted | `draft-purge` | 1 failed, 9 passed | erases an abandoned draft's people, business and documents; keeps … attestation |
| M12 | `cancel.ts`: no own-draft check for a sales user | `dealer-cancel` | 1 failed, 9 passed | is 404 for another dealer's draft and for a sales colleague's |
| M13 | `consent.ts`: signing method not checked first | `dealer-consent-v2` | 2 failed, 5 passed | remote without identity; five emoji |
| M14 | `dealerDealPurgeReason`: no DSAR hold | `draft-purge` | 1 failed, 9 passed | holds a draft while a person on it has an open DSAR or complaint |
| M15 | `dealerDealPurgeReason`: cancelled after 80 days | `draft-purge` | 1 failed, 9 passed | names a cancelled draft 90 days after the cancellation, not before |
| M16 | `dealerDealPurgeReason`: person edits not activity | `draft-purge` | 1 failed, 9 passed | counts every kind of activity on the draft, its people, business and asset |
| M17 | `dealerPurgeLinkedElsewhere`: other stale drafts are links | `draft-purge-scope` | 1 failed, 4 passed | does not let two abandoned drafts on one business keep each other |
| M18 | `dealerPurgeLinkedElsewhere`: text links not read | `draft-purge-scope` | 1 failed, 5 passed | keeps a person a CRM activity names |
| M19 | `dealerPurgeLinkedElsewhere`: no relationship keeps a business | `draft-purge-scope` | 1 failed, 5 passed | keeps a business a person the lender added relates to |
| M20 | `DROP TRIGGER "EntityDocument_a_purged_deal_closed"` | `draft-purge-closed` | 1 failed, 2 passed | refuses by SQL a new document, attestation or request, … |
| M21 | `guardPurgedDealerDeal`: the deal row may change | `draft-purge-closed` | 1 failed, 2 passed | same |
| M22 | `guardDealerPurgedParty`: bank account number kept | `draft-purge-scope` | 1 failed, 4 passed | overwrites every identifying column of the person and the business |
| M23 | `draft-purge.ts`: a cited document erased | `draft-purge-scope` | 1 failed, 5 passed | erases only documents whose party goes, and none a kept business cites |
| M24 | `draft-purge.ts`: a document goes whatever its party | `draft-purge-scope` | 1 failed, 5 passed | same |
| M25 | `submit.ts`: a purged draft not refused first | `draft-purge-closed` | 1 failed, 2 passed | refuses the dealer's submit, attestation and upload |
| M26 | `cancel.ts`: reason counted in UTF-16 units | `dealer-cancel` | 1 failed, 9 passed | … a reason under ten characters |

`lib/dealer/purge-schema.test.ts` (static): deleting `NEW."creditScore" := NULL`
and the `EmailConfig.clientId` text link from the migration turned both of its
schema tests red; restored, green.
