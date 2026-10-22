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

### Review round 4 fixes

Fresh database `cf-it-s5fd-b1`; all dealer suites green (`Test Files 53 passed | 1
skipped`, `Tests 461 passed | 1 skipped`).

| # | Mutation | Suite | Result | Red test |
|---|---|---|---|---|
| M43 | `submit.ts`: an erased person on the business not refused first | `draft-purge-holds` | 1 failed, 6 passed | refuses handing over a draft on another business whose director a purge erased |
| M44 | `guardDealerPurgedPartyUse`: hand-over allowed with an erased person active on the business | `draft-purge-holds` | 1 failed, 6 passed | same (by SQL) |

Staff edits of an erased row answer 409 naming the purge: pinned by
`app/api/asset-finance/entities/[id]/route.test.ts` and `app/api/clients/[id]/route.test.ts`.


## Part T (THEFT purpose, SQL purpose gate, position trail, meter-reading void, tracker closure)

Database: a throwaway PostgreSQL 16 from `scripts/it-db.sh up cf-it-s5ft-*`,
`npx prisma migrate deploy` (the branch head after review round 1). Suites run
with `RUN_ASSET_FINANCE_TELEMATICS_IT=1 TENANT_RLS=on npx vitest run
--no-file-parallelism <suite>`. The T1–T59 mutations redefine one live database
object (a function with one clause replaced, a CHECK or index dropped or
rebuilt), run the named suite, and restore it. The T30–T69 mutations change one
TypeScript clause and restore it with `git checkout`. The tests' `ruleRefuses`
also removes each rule it names inside a rolled-back transaction and checks
the attack then goes through. Gaps in the numbering are mutations retired with
the code they targeted (T33: the purpose rule moved into SQL, covered by T5
and T28). Suites that run as one sequence often fail several tests from the
first failure on, so a count says a mutation was caught, not how many rules it
broke.

### Mutations (all killed)

| # | Mutation | Suite | Result |
|---|---|---|---|
| T1 | drop CHECK AssetTheftReport_case_number | `theft-trail` | 7 failed, 5 passed (12) |
| T2 | guardAssetTheftReport: a report on a closed loan | `theft-trail` | 7 failed, 5 passed (12) |
| T3 | guardAssetTheftReport: valid 31 days | `theft-trail` | 7 failed, 5 passed (12) |
| T4 | guardAssetTheftReport: a future report date | `theft-trail` | 7 failed, 5 passed (12) |
| T5 | telematicsPurposeHolds THEFT: an expired report holds | `theft-trail` | 2 failed, 10 passed (12) |
| T6 | telematicsPurposeHolds DEFAULT: any loan | `theft-trail` | 3 failed, 9 passed (12) |
| T7 | guardTelematicsPositionAccess: no purpose check | `theft-trail` | 1 failed, 11 passed (12) |
| T8 | guardTelematicsPositionAccess: a TRAIL for DEFAULT | `theft-trail` | 1 failed, 11 passed (12) |
| T9 | guardTelematicsPositionAccess: THEFT without its report | `theft-trail` | 1 failed, 11 passed (12) |
| T10 | drop CHECK AssetMeterReadingVoid_four_eyes | `meter-void` | 1 failed, 8 passed (9) |
| T11 | drop index AssetMeterReadingVoid_one_open | `meter-void` | 1 failed, 8 passed (9) |
| T12 | meterReadingVoidRefusal: an invoiced lease's reading voidable | `meter-void` | 2 failed, 7 passed (9) |
| T13 | meterReadingVoidRefusal: a final reading voidable | `meter-void` | 2 failed, 7 passed (9) |
| T14 | meterReadingVoidRefusal: a recovery's reading voidable | `meter-void` | 2 failed, 7 passed (9) |
| T15 | guardAssetMeterReadingVoid: decided again / changed | `meter-void` | 1 failed, 8 passed (9) |
| T16 | guardAssetMeterReading: monotonic counts voided readings | `meter-void` | 7 failed, 2 passed (9) |
| T17 | guardAssetMeterReading: any void stamp accepted | `meter-void` | 1 failed, 8 passed (9) |
| T18 | telematicsPaceCeiling: voided start counts | `meter-void` | 1 failed, 8 passed (9) |
| T19 | one_per_day index counts voided readings | `meter-void` | 1 failed, 8 passed (9) |
| T20 | guardNotVoidedReading: a voided reading cited | `meter-void` | 1 failed, 8 passed (9) |
| T21 | applyAssetMeterReadingVoid: approval does not stamp | `meter-void` | 9 failed (9) |
| T22 | createTrackerClosures: a removed device too | `tracker-closure` | 1 failed, 16 passed (17) |
| T23 | createTrackerClosures: no ON CONFLICT (twice fails) | `tracker-closure` | 13 failed, 4 passed (17) |
| T24 | createTrackerClosures: not fired at all | `tracker-closure` | 15 failed, 2 passed (17) |
| T25 | guardTrackerClosure: a decided message rewritten | `tracker-closure` | 2 failed, 15 passed (17) |
| T26 | guardTrackerClosure: done without the device removed | `tracker-closure` | 1 failed, 16 passed (17) |
| T27 | AssetTheftReport_confirmation CHECK dropped (recorder confirms) | `theft-trail` | 2 failed, 10 passed (12) |
| T28 | telematicsPurposeHolds THEFT: unconfirmed or ended holds | `theft-trail` | 2 failed, 10 passed (12) |
| T29 | guardAssetTheftReport: dated over 14 days back | `theft-trail` | 7 failed, 5 passed (12) |
| T47 | guardAssetTheftReport: a renewal with another date | `theft-trail` | 1 failed, 11 passed (12) |
| T48 | guardAssetTheftReport: no renewal cap | `theft-trail` | 1 failed, 11 passed (12) |
| T49 | guardAssetTheftReport: recorder role unchecked | `theft-trail` | 7 failed, 5 passed (12) |
| T50 | guardAssetTheftReport: confirmer role unchecked | `theft-trail` | 1 failed, 11 passed (12) |
| T51 | guardAssetTheftReport: recorded confirmed at once | `theft-trail` | 7 failed, 5 passed (12) |
| T52 | guardAssetTheftReport: an ended report re-ended / changed | `theft-trail` | 1 failed, 11 passed (12) |
| T53 | guardAssetMeterReadingVoid: decider role unchecked | `meter-void` | 1 failed, 8 passed (9) |
| T54 | guardAssetMeterReadingVoid: requester role unchecked | `meter-void` | 1 failed, 8 passed (9) |
| T55 | meterReadingVoidRefusal: the only reading voidable | `edge-followups` | 1 failed, 12 passed (13) |
| T56 | guardLeaseEndOfTerm: a later voided reading still blocks | `meter-void` | 1 failed, 8 passed (9) |
| T57 | createTrackerClosures: closure for a re-leased asset | `tracker-closure` | 1 failed, 16 passed (17) |
| T58 | guardAssetTheftReport: a second first report of a case | `theft-trail` | 1 failed, 11 passed (12) |
| T59 | guardAssetTheftReport: an ended report renewed | `theft-trail` | 1 failed, 11 passed (12) |
| T30 | position-trail: DEFAULT allowed for a trail | `theft-trail` | 2 failed, 10 passed (12) |
| T31 | position-trail: no tenure start filter | `theft-trail` | 2 failed, 10 passed (12) |
| T32 | position-trail: no permission check | `theft-trail` | 2 failed, 10 passed (12) |
| T34 | theft-reports: future date accepted | `theft-reports (unit)` | 1 failed, 4 passed (5) |
| T35 | theft-reports: no permission check | `theft-trail` | 1 failed, 11 passed (12) |
| T36 | meter-void: no four-eyes TS check | `meter-void` | 7 failed, 2 passed (9) |
| T37 | meter-void: no pending check | `meter-void` | 7 failed, 2 passed (9) |
| T38 | meter-readings: monotonic TS counts voided | `meter-void` | 5 failed, 4 passed (9) |
| T39 | lease-staff-data: projection counts voided | `meter-void` | 1 failed, 8 passed (9) |
| T40 | tracker-closure: notice not guarded by its column | `tracker-closure` | 1 failed, 16 passed (17) |
| T41 | tracker-closure: in-flight send decided FAILED | `tracker-closure` | 1 failed, 16 passed (17) |
| T42 | tracker-closure: pending message decided SENT | `tracker-closure` | 1 failed, 16 passed (17) |
| T43 | tracker-closure: unexpected error decided | `tracker-closure` | 2 failed, 15 passed (17) |
| T44 | tracker-closure: deceased recipient included | `tracker-closure` | 1 failed, 16 passed (17) |
| T45 | devices: removal does not close the task | `tracker-closure` | 1 failed, 16 passed (17) |
| T46 | letter route: no access log | `followup-routes (unit)` | 1 failed, 8 passed (9) |
| T60 | tracker-closure: not held until the wording is approved | `tracker-closure` | 2 failed, 15 passed (17) |
| T61 | tracker-closure: a reopened loan is told | `tracker-closure` | 1 failed, 16 passed (17) |
| T62 | tracker-closure: lender email switch not checked | `tracker-closure` | 2 failed, 15 passed (17) |
| T63 | tracker-closure: untrusted dealer contact written to | `tracker-closure` | 1 failed, 16 passed (17): survived its first run; killed once a sole proprietor case was added |
| T64 | lease-end-invoice: the final reading may be its own start | `edge-followups` | 1 failed, 12 passed (13) |
| T65 | theft-reports: 14-day rule dropped (TS) | `theft-reports (unit)` | 1 failed, 4 passed (5) |
| T66 | theft-reports: ending ends only the one report | `theft-trail` | 1 failed, 11 passed (12) |
| T67 | closure cron: lenders by the asset-finance flag | `followup-routes (unit)` | 1 failed, 8 passed (9) |
| T68 | portal-lease: the void reason dropped | `portal-lease (unit)` | 1 failed, 9 passed (10) |
| T69 | lease-end-of-term: inspection counts a later voided reading | `meter-void` | 1 failed, 9 passed (10): survived its first run; killed once recordInspection itself was tested |

### Found by the suites and reviews before merge

- `guardNotVoidedReading` read `NEW."finalReadingId"` and `NEW."meterReadingId"`
  in one CASE in its DECLARE block: every insert into LeaseEndOfTerm, Recovery
  or MaintenanceClaim failed ("record new has no field"). It now reads the
  column for each table in the body.
- Overlapping closure runs: the run that lost the send race recorded FAILED
  for an email the other run had sent, and two runs at once deadlocked in the
  send pipeline. Fixed with a claim on the email step for each closure.
- A test committed DDL: a "CHECK only" case disabled the theft trigger in a
  transaction that committed whenever the CHECK was mutated away, which broke
  every later run on that database. It now runs in a transaction that is
  always rolled back.
- Review round 1 (blind SA legal, security, architecture, code, tests and edge
  reviewers) found these, each now with a real-PG case and a mutation:
  - one person's theft report unlocked a good-standing borrower's position;
    a backdated date stretched the trail back; renewals were unlimited;
  - DRAFT letters were stored before the wording was approved;
  - voids and theft reports had no role check in SQL;
  - a lease's only reading could be voided; the invoice could measure usage
    from the final reading itself;
  - the end-of-term inspection still counted voided readings;
  - a reopened loan was told tracking had stopped;
  - the cron refused by the tenant-scope extension, and the cron keyed on the
    asset-finance flag.
