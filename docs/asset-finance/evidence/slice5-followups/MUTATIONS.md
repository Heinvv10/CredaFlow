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

### Review round 2 fixes

Fresh database `cf-it-s5fd-a6`. All dealer suites: `Test Files 53 passed | 1
skipped`, `Tests 458 passed | 1 skipped` (after the fix below).

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| M27 | `draft-purge.ts`: a party erased by an earlier purge not counted as gone | `draft-purge-scope` | 1 failed, 5 passed | does not let two abandoned drafts on one business keep each other (the second draft's document) |
| M28 | `DROP TRIGGER "EntityRelationship_purged_party"` | `draft-purge-holds` | 1 failed, 3 passed | erases once, never on insert, and never uses an erased party again |
| M29 | `guardPurgedDealerDeal` lets a dealer cancel a purged draft | `draft-purge-closed` | 1 failed, 3 passed | refuses by SQL … any change to the deal but its cancellation |
| M30 | `DealerConsentAttestation_signing_method` without the one-line rule | `dealer-consent-v2` | 1 failed, 6 passed | refuses by SQL a row without a method, … |
| M31 | `draft-purge.ts`: a pending-file failure not counted | `draft-purge-closed` | 1 failed, 3 passed | reports a file it cannot delete as a failure, … |
| M32 | `dealerDealPeople` without the sole proprietor | `draft-purge-holds` | 1 failed, 3 passed | erases a sole proprietor with no other link, and holds one with an open DSAR |
| M33 | DSAR hold without `OVERDUE` | `draft-purge-holds` | 1 failed, 3 passed | holds a draft for every open DSAR and complaint status, … |
| M34 | `DROP TRIGGER` `AssetFinanceDeal_purged_party` and `LoanApplication_purged_party` | `draft-purge-holds` | 1 failed, 3 passed | erases once, never on insert, and never uses an erased party again |

M21 (round 1) targeted the closed-deal guard's old cancel clause; M29 replaces it
for the new clause (only the lender cancels a purged draft).

### Review round 3 fixes

Fresh database `cf-it-s5fd-a9`; all dealer suites green after the fixes
(`Test Files 53 passed | 1 skipped`, `Tests 460 passed | 1 skipped`).

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| M35 | drop `Client_b_dealer_purged_frozen` and `BusinessEntity_b_dealer_purged_frozen` | `draft-purge-holds` | 1 failed, 5 passed | erases once, never on insert, and never uses an erased party again |
| M36 | `guardDealerPurgedPartyUse` refuses a relationship's deactivation too | `draft-purge-holds` | 1 failed, 5 passed | same (ending the erased director's relationship) |
| M37 | drop `EntityDocument_purged_party` and `DealerConsentAttestation_purged_party` | `draft-purge-holds` | 1 failed, 5 passed | closes a sibling draft whose business an earlier purge erased |
| M38 | `AssetFinanceDeal_purged_party` not on `dealerSubmittedAt` | `draft-purge-holds` | 1 failed, 5 passed | same |
| M39 | `documents.ts`: a sibling draft's erased parties not refused first | `draft-purge-holds` | 1 failed, 5 passed | same (the database refused the upload as an error) |
| M40 | `consent.ts`: only C0 control characters refused | `dealer-consent-v2` | 1 failed, 6 passed | counts characters as the database does … (U+2028, U+2029, U+0085) |
| M41 | signing-method CHECK without U+0085, U+2028, U+2029 | `dealer-consent-v2` | 1 failed, 6 passed | refuses by SQL a row without a method, … |
| M42 | `cancel.ts`: the purged check before the colleague check | `draft-purge-closed` | 1 failed, 3 passed | refuses the dealer's submit, attestation and upload (a colleague gets 404) |
