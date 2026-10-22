# Asset finance slice 5 follow-ups — the review-item decisions

Build spec for the seven review items Hein decided on 2026-10-22 (goal
`.claude/handoffs/2026-10-22-asset-finance-slice5-followups-goal.md`, §2a).
One PR per part, D → T → W. Where the code or the law made a §2a default
unsafe, the safer option is taken and recorded under "Deviations".
Mutation evidence: `evidence/slice5-followups/MUTATIONS.md`. Browser
acceptance: `evidence/slice5-followups/browser/<part>/`.

## Part D — Dealer: consent v2, draft cancel, draft purge (§2a 1 and 8)

### Deviations from the goal's defaults (and why)

1. **Only drafts the lender never received are purged; declined deals are
   not.** A deal the dealer handed to the lender (`dealerSubmittedAt`) is an
   application for credit the lender received. NCA Regulation 55(1)(b) makes a
   credit provider keep the records of a declined application (and its
   pre-agreement quote) for three years, and POPIA s14(1)(a) allows what a law
   requires. A handed-over deal also carries the lender's own evidence (staff
   uploads, signer scans, surety consents the database keeps), which a dealer
   purge has no business deleting. So the 90-day purge covers a DRAFT the
   lender never received (90 days after its last activity) and such a draft
   once cancelled (90 days after the cancellation). Handed-over deals that
   ended DECLINED, REFUSED_NCA or CANCELLED are left to the lender's general
   records retention, which applies to staff and dealer deals alike; that job
   is a follow-up. Confidence MEDIUM; counsel confirms both directions: that a
   handed-over deal is an application (keep three years), and whether an
   attested draft the lender has not yet received already is one (then it
   could not be purged at 90 days either).
2. **The deal row and its application stay.** Nothing on them is personal
   information beyond foreign keys (the application's purpose names the
   asset), and every audit row points at them. The purge erases the people,
   the business and the documents, and the database closes the draft
   (`guardPurgedDealerDeal`: nothing is added to it, only staff cancel it).
3. **The database anonymises, not the TypeScript.** Setting
   `Client.dealerPurgedAt` (or `BusinessEntity.dealerPurgedAt`) makes the
   trigger check eligibility and overwrite every identifying column itself.
   Unique columns get `erased-<id>-<random>`, a value no one can have typed in
   advance. `lib/dealer/purge-schema.test.ts` holds the overwritten list
   against the schema, so a column added later fails until it is decided.
4. **"Linked elsewhere" is read from the catalog, plus the text-only links.**
   Every foreign key to `Client` / `BusinessEntity` counts (a table added
   later counts too), and so does each id column without a foreign key in
   `dealerPurgeTextLinks` (CRM activity, notification log, consent records,
   tasks, screening context, …); `purge-schema.test.ts` fails when the schema
   gains such a column that is in neither that list nor its short list of
   non-links (the audit log, webhooks).
5. **Remote identity check is free text (10–500 characters).** The dealer's
   remote processes vary (video call, e-signature platform identity check,
   certified copy plus call-back); the statement snapshot records what the
   dealer said was done. An enum would force a false choice. The UI asks for
   the method, never an ID number; the note is kept on the attestation only,
   not in the audit row (which is never erased).

### Data (migration `20261022100000_dealer_followups`)

```prisma
enum DealerConsentSigningMethod { IN_PERSON REMOTE }
enum DealerDealPurgeReason { ABANDONED_DRAFT CANCELLED_DRAFT }

model DealerConsentAttestation { // + signingMethod DealerConsentSigningMethod?, remoteIdentityCheck String? }
model AssetFinanceDeal         { // + cancelledByDealerUserId String? (→ DealerUser) }
model Client                   { // + dealerPurgedAt DateTime? }
model BusinessEntity           { // + dealerPurgedAt DateTime? }
model DealerDealPurge {         // id, tenantId, dealId (unique per tenant, → deal), reason, purgedAt,
                                // clientsErased, clientsKept, entitiesErased, entitiesKept, documentsErased, documentsKept
}
```

- **CHECK `DealerConsentAttestation_signing_method`**: a `dealer-consent-v1`
  row has neither column; a `dealer-consent-v2` row has a method, and
  `remoteIdentityCheck` (10–500 characters once whitespace is trimmed, one
  line: no control character or Unicode line separator, which could forge a
  method line in the snapshot) exactly when
  REMOTE; no other version.
- **`DealerConsentAttestation_current_version`** (BEFORE INSERT): a new
  attestation never names `dealer-consent-v1`. The existing
  `guardDealerConsentAttestation` keeps every row as attested (only the
  verification is added, once), so a v1 row cannot gain a method or new text.
- **CHECK `AssetFinanceDeal_cancellation_shape`** (replaced): a CANCELLED deal
  has `cancelledAt`, a reason ≥ 10 characters and exactly one of
  `cancelledById` (staff) and `cancelledByDealerUserId` (dealer).
- **`guardAssetDealDealerCancel`** (BEFORE INSERT OR UPDATE): a dealer
  cancellation is set only on the move DRAFT → CANCELLED of a dealer deal
  never handed over, by an active user of the deal's dealer that is
  DEALER_ADMIN or the deal's creator. `freezeTerminalAssetDeal` is re-created
  with the new column in its cancel whitelist.
- **`dealerDealPurgeReason(tenant, deal)`** → the reason or NULL, the one
  definition the cron selects with and the tombstone trigger checks: a dealer
  deal with no loan, never handed over, none of whose people has an open DSAR
  (RECEIVED, IN_PROGRESS, OVERDUE) or complaint (not RESOLVED or CLOSED), and
  - ABANDONED_DRAFT: DRAFT, last activity more than 90 days ago (the deal, its
    documents, attestations and requests, the business's relationships, and
    the people, business and asset rows; an erased row does not count);
  - CANCELLED_DRAFT: CANCELLED more than 90 days ago.
- **`guardDealerDealPurge`**: INSERT only when the reason is the function's
  answer now; never updated or deleted.
- **`dealerPurgeLinkedElsewhere(tenant, table, id, deal)`**: true when the
  person or business is linked to anything beyond the deals being purged:
  this one and any other deal on the same party that is itself purged or
  purgeable (two abandoned drafts on one business do not keep each other).
  Excluded: those deals, their applications, documents and attestations, the
  person's `ClientConsent`, the person's relationship to a business of those
  deals that is itself not linked elsewhere, and a business's relationships to
  people the same dealer captured (a person anyone else added keeps it).
- **`guardDealerPurgedParty`** (BEFORE UPDATE OF "dealerPurgedAt" on Client
  and BusinessEntity, named `a_` to run first): set once, never on insert; the
  row was captured by a dealer; a tombstone exists for a deal of that dealer
  naming it; not linked elsewhere; then it overwrites every identifying
  column.
- **`guardPurgedDealerDeal`**: a purged deal takes no new document,
  attestation or request, and changes only by staff cancelling it (a dealer
  cancel would add a reason no purge reaches).
- **`guardDealerPurgedPartyUse`**: no deal, application, relationship,
  document or consent attestation names an erased person or business again,
  and a deal naming one, or whose business still has an erased person
  active, is not handed to the lender (a sibling draft the same
  purge left for later); ending a relationship to one is allowed. The dealer's
  lookups and actions refuse first (404, 409); the staff people route names
  the purge.
- **`freezeDealerPurgedParty`**: an erased row is never changed again; the
  staff entity and client edits answer 409 naming the purge.
- **`DealerPurgePendingFile`**: each erased document's file path, written in
  the purge's transaction and deleted only with the file, so a crash between
  the commit and the delete is drained by the next run.

### Library and routes

- `lib/dealer/consent.ts`: `DEALER_CONSENT_VERSION = "dealer-consent-v2"`,
  `DEALER_CONSENT_STATEMENT` (no "in my presence"; "signed by the person
  named", "their identity was checked in the way recorded below", "not altered
  since it was signed or, if it was signed remotely, since the dealership
  received it") plus the method line ("Signed in my presence: …" or "Signed
  remotely. How their identity was checked: …"). `attestDealerConsent` takes
  `signingMethod` and `remoteIdentityCheck` (counted in code points, as the
  database counts). v1 text lives only in the rows that snapshotted it.
- `lib/dealer/cancel.ts` `cancelDealerDraft(actor, dealId, reason)`: 404 for
  another dealer's deal and for a SALES user's colleague's draft; 409 once
  handed over, not DRAFT, or refused by the database; otherwise the deal →
  CANCELLED, its application → CANCELLED, the asset released, audit
  `DEALER_DEAL_CANCELLED`. Route `POST /api/dealer/deals/[id]/cancel`.
- `lib/dealer/draft-purge.ts` `purgeDealerDrafts()`: per lender with a dealer,
  each deal `dealerDealPurgeReason` names (oldest first, 500 a run), in its own
  transaction with the deal, the sibling drafts on its parties (never a booked
  or handed-over deal), its business and its people locked `FOR UPDATE`, in
  that order: decide which people and business go and which
  documents go with them (only a document whose party is erased, now or by
  an earlier purge of a sibling draft, or that names none, and that no kept
  business cites as evidence); the tombstone; `dealerPurgedAt` on each party that goes; each
  document row deleted when nothing refers to it, else kept soft-deleted as
  "erased" (an earlier soft delete keeps its author); audit
  `DEALER_DEAL_PURGED` (counts only). After the commit the documents' bytes
  are deleted and their pending records with them; each run starts by
  draining what an earlier run left. A file that cannot be deleted keeps its
  record, is logged with its path, fails the run (503) and is retried next
  run. Cron `asset-finance-dealer-draft-purge` (daily 03:50,
  `CRON_SECRET`).
- Submit, attest and upload refuse a purged draft (409) before the database
  would; the dealer page shows it as closed.
- UI: the dealer deal page gains the signing method and remote identity
  fields and a "Cancel draft" form (both ask for no personal details); the
  staff Dealer panel shows each attestation's method and identity check, a
  dealer cancellation, and the purge tombstone, and no longer lists an erased
  person's contacts.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_DEALER_IT`)

| Rule | Test | Kind | Negative cases (§3 D) |
|---|---|---|---|
| v2 attestation carries a method; REMOTE needs the identity check | `lib/dealer/dealer-consent-v2.integration.test.ts` | IT | REMOTE without identity, blank (tabs), short, emoji-counted; IN_PERSON with one; an unknown version; v1 insert; the note kept out of the audit |
| v1 rows unchanged | same | IT | a v1 row altered (text, method added) |
| Statement wording and snapshot | `lib/dealer/consent-v2.test.ts` | unit | "in my presence" absent from the statement; method line per method; bounds in code points |
| Dealer cancels its own draft | `lib/dealer/dealer-cancel.integration.test.ts` | IT | another dealer's draft (404); SALES on a colleague's (404); a handed-over deal (409); inactive creator or admin (409, and SQL); a staff deal; an insert naming a dealer canceller; a short or emoji reason; both cancellers set |
| Purge eligibility | `lib/dealer/draft-purge.integration.test.ts` | IT | each kind of activity within 90 days; a handed-over deal (declined, waiting, cancelled) at any age; a cancelled draft at 89 days; an open DSAR or complaint; a tombstone for an ineligible deal by SQL |
| Purge scope | `lib/dealer/draft-purge-scope.integration.test.ts`, `draft-purge.integration.test.ts` | IT | every identifying column; a business with another live deal and its director kept; two stale drafts on one business; a lender-added person; a CRM-only link; a shared sole proprietor; a booked deal byte-identical; documents of kept parties, a cited document, an earlier soft delete |
| Purged draft closed | `lib/dealer/draft-purge-closed.integration.test.ts` | IT | dealer submit, attest, upload, cancel; SQL document, attestation, request, deal change, dealer cancel; staff cancel allowed; a whole cron run and a rerun; a file that cannot be deleted |
| Holds and set-once | `lib/dealer/draft-purge-holds.integration.test.ts` | IT | a staff deal; each DSAR and complaint status; a sole proprietor erased and held; erase twice; insert erased; an erased party used again (capture, deal, relationship, application) |
| Schema stays covered | `lib/dealer/purge-schema.test.ts` | unit | a new identifying column; a new text-only id column |
| Edge cases (independent tester) | `lib/dealer/edge-dealer-followups.integration.test.ts` | IT | 16 edges: boundaries at 90 days, collisions with `erased-` values, cross-tenant under RLS, a loan naming the business |
| Cron route | `app/api/cron/asset-finance-dealer-draft-purge/route.test.ts` | unit | no `CRON_SECRET` |
| Cancel route | `app/api/dealer/deals/[id]/cancel/route.test.ts`, `app/api/dealer/dealer-route-guards.test.ts` | unit | short reason; refusal mapping; no session, staff/client/other lender's session, portal off |
| Staff panel | `lib/dealer/staff-deal-panel.test.ts` | unit | an erased person listed |

### Known limitations (part D)

- **What stays after a purge.** The deal row (closed), its application (the
  purpose names the asset), the consent attestations (with the dealer's
  remote identity-check note, which the UI asks not to hold personal
  details), `ClientConsent` flags, every audit row (a business's capture
  audit holds its legal name and registration number; the cancel reason is in
  the cancel audit only, never on the application), staff document-request notes, the dealer-captured asset,
  and documents of a party that is kept. The audit is kept for the lender's
  s14(1)(b) record; its retention policy records that.
- **Free-text status notes on a person** (risk flag, blacklist, deceased,
  KYC rejection reasons) are not overwritten; a dealer draft never has them.
- **The cancel reason of a draft the dealer cancelled** stays on the deal row
  (the row is terminal and a reason is required) and in its audit row; the
  form asks for no personal details.
- **A text-only link added while a purge runs** (a CRM activity row) takes no
  lock on the person, so it can be missed in that instant; the static test
  only finds id columns named `*clientId` / `*entityId`, not id arrays or JSON.
- **Handed-over deals** are not purged here (deviation 1).
- **A file that cannot be deleted** keeps its pending record and fails every
  run until an operator fixes the path or the permission.
- **Other holds.** Only an open DSAR or complaint holds a purge; counsel says
  whether an NCR investigation or a Tribunal matter should too, and whether a
  structure preview a dealer gave the customer counts as a pre-agreement
  quote (which would bring the draft under Regulation 55).
- **Deadlocks.** Two overlapping purges of sibling drafts, or a purge and a
  path that locks a client before its business (`section129-artifact.ts`), can
  deadlock; Postgres aborts one, the run counts it failed and the next run
  retries.
- **Batch.** At most 500 deals per lender a run (oldest first); the rest wait
  for the next night.
- **Performance.** The link check walks every foreign key to `Client` (about
  30) once per person; fine at today's volumes, to be indexed before a lender
  with a large book runs it.

## Part T — Telematics: THEFT purpose, position trail, meter-reading void, closure (§2a 3 to 6)

### Decisions (the goal's "[agent decides]") and deviations

1. **A theft report is its own row, valid 30 days, confirmed by a second
   person.** `AssetTheftReport` (loan, asset, SAPS case number, the date the
   theft was reported to SAPS, who recorded it, `validUntil` = the
   recording's SAST date + 30 days, set by the database: it holds through
   day 30, not day 31). THEFT holds only once a second person with
   `view_asset_position` confirms it (CHECK: not the recorder; the review of
   PR #238 found one officer's say-so too little for a borrower in good
   standing), and stops when it is ended early with a reason (the asset
   found). Recorder, confirmer and ender hold `view_asset_position`'s roles in
   SQL too (`followups-sql-roles.test.ts` keeps the lists in step). The date
   reported is no more than 14 days before the recording (so the trail's week
   before it cannot be stretched back), not in the future and not before the
   loan started. A renewal is a new row for the same case that keeps the
   original's date and needs its own confirmation; a case has at most three
   reports (90 days), then a recovery or a legal matter takes over. Nothing
   else about a report changes; it is never deleted. The case number is
   checked as `CAS <number>/<month>/<year>` (year 2000 to this year), in the
   trigger before the CHECK.
2. **The purpose gate is SQL.** `telematicsPurposeHolds(tenant, loan,
   context)` is the one definition: DEFAULT (loan DEFAULTED or
   PENDING_WRITE_OFF), RECOVERY (a recovery not CLOSED or WITHDRAWN),
   LEGAL_MATTER (an OPEN matter), THEFT (this loan's confirmed, open report
   whose `validUntil` is today or later, on a loan ACTIVE, DEFAULTED or
   PENDING_WRITE_OFF). `guardTelematicsPositionAccess` refuses an access row
   whose purpose does not hold at insert. `position-purpose.ts` asks the same
   function (one definition), choosing only which report to name; a purpose
   that lapses between that answer and the access row is a 409, not a 500.
3. **The trail.** The per-device unique goes: ingest appends every position
   inside a tenure and retention. The latest-position reveal reads the newest
   row as today. The trail (`position-trail.ts`) is THEFT, RECOVERY or
   LEGAL_MATTER only (never DEFAULT: arrears alone do not justify a movement
   history), the loan's tenure and retention (under THEFT from 7 days
   before the theft was reported: the history before it is not the purpose),
   time-ordered, at most 500 points; each view writes an access row with `view = TRAIL` and the point
   count (SQL: a TRAIL row never names DEFAULT). The map is an inline SVG of
   the points (no tiles, no external call).
4. **Meter-reading void: a request row, decided by a second user.**
   `AssetMeterReadingVoid` (reading, reason 10–500, requestedBy/At, status
   PENDING → APPROVED | REJECTED, decidedBy/At). CHECK: the decider is not the
   requester; both hold `manage_asset_finance`'s roles (checked in SQL too).
   One open request per reading (two at once queue on the reading's row and
   the second is a 409). Refused when the reading is a final reading
   (`LeaseEndOfTerm.finalReadingId`), a recovery's or a maintenance claim's
   reading, already void, the lease's only live reading in its unit (there
   would be no start to measure from), or of a lease whose end of term is
   invoiced (`taxInvoiceId` set; the approval locks the end of term, which the
   invoice locks too, so the two serialise). The end-of-term invoice's start
   is the earliest live reading other than the final one: with none it
   refuses until a correct start is recorded. Approval sets `AssetMeterReading.voidedAt` and `voidId` (an
   AFTER trigger); `guardAssetMeterReading` allows that one UPDATE and
   nothing else, and skips voided rows in its monotonic check. The final-
   reading rule (`guardLeaseEndOfTerm`, re-created), the pace ceiling's start reading and the one-telematics-
   reading-per-day index skip voided rows; so do the TypeScript readers
   (start reading, monotonic pre-check, excess projection, end-of-term
   invoice and inspection, lease documents, the portal's latest reading, the
   claim picker, the telematics one-a-day count). Staff and the portal show a
   voided reading struck through as "Voided"; the portal shows the reason
   (a voided start changes the lessee's usage).
5. **Closure: a database-owned task row.** `TrackerClosure` (loan, device,
   unique per loan and device) is the staff task: the database inserts it
   (`AFTER UPDATE OF status ON "Loan"`, into COMPLETED, for each ACTIVE
   device on the loan's asset), so every path that completes a loan is
   covered, once (`ON CONFLICT DO NOTHING`: completing again opens no second),
   never for a device being removed at that moment (the trigger waits on the
   device row) or when the asset already runs under a later agreement.
   Its columns record each effect once (`guardTrackerClosure`): `noticeLoggedAt`
   (the portal notice, a `NotificationLog` row per borrower recipient, event
   `tracking_stopped`), `messageOutcome` (the email through `sendMessage`:
   SENT, SIMULATED, BLOCKED or FAILED with a note; never retried once
   decided), `letterStoragePath`/`letterSha256` (the stored PDF) and
   `removedAt/By` (set when staff remove the device). A cron
   (`asset-finance-telematics-closure`, every 15 minutes) processes pending
   rows; each step is guarded by its column, so a rerun or a concurrent run
   does nothing twice. The email step is claimed first (`messageClaimedAt`,
   released when a run ends undecided, stale after 10 minutes): two runs at
   once deadlocked inside the send pipeline in testing and left the message
   for manual reconciliation. A send still in flight or pending is left for a
   later run to replay; an unexpected error fails the run, never a FAILED
   decision. A lender that predates the template gets it seeded on its first
   closure, as the dunning templates are. Recipients are the borrower, or for an entity the
   people who act for it; never a deceased person or dealer-typed contact
   details. Staff read the letter on the loan (`work_telematics_alerts`), each
   view on the document access register.
   Nothing is told to a borrower until the lender approves the asset-finance
   wording (`TenantConfig.assetFinanceLegalWordingApproved`): the closures
   wait, counted as held, and the staff task says so (the architecture review
   found a letter stored before approval stayed a DRAFT for ever). A loan
   reopened since it completed is told nothing until it completes again. The
   cron lists the lenders with an unfinished closure, whatever their
   asset-finance flag says now; a lender whose identity is not configured
   has every closure counted failed. With the lender's email not set up or
   switched off the email is decided BLOCKED.
6. **No real send.** The closure email goes through `sendMessage`, whose
   consent gate, opt-outs and kill switches stand; the integration suite fakes
   only the provider transport and proves it is called once; with the lender's
   email not set up the outcome is BLOCKED and nothing is dispatched. Browser
   acceptance captures the email on a local SMTP server. Turning on a real
   send stays a §8 gate.
7. **Bug found while testing.** `guardNotVoidedReading` first read
   `NEW."finalReadingId"`/`NEW."meterReadingId"` in one CASE in its DECLARE
   block; plpgsql resolves every field of the expression, so every insert
   into LeaseEndOfTerm, Recovery or MaintenanceClaim would have failed. It
   reads the column per table in the body (caught by
   `meter-void.integration.test.ts` before merge).

### Data (migrations `20261022110000_telematics_followups_enum_values`, `20261022110100_telematics_followups`)

THEFT on `TelematicsPositionContext`; `AssetTheftReport`; `TelematicsPositionAccess.view`/`positionCount`/`theftReportId`; the per-device position unique dropped (a time index instead); `AssetMeterReadingVoid` and `AssetMeterReading.voidedAt`/`voidId`; `TrackerClosure`. RLS on each new table. Every rule above is a trigger, CHECK, function or index in the second migration.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_TELEMATICS_IT`)

| Rule | Test | Kind | Negative cases (§3 T) |
|---|---|---|---|
| THEFT needs a valid, confirmed report | `lib/telematics/theft-trail.integration.test.ts`, `edge-followups.integration.test.ts` | IT | no report; unconfirmed; confirmed by the recorder (TS and CHECK) or by READONLY (TS and trigger); ended; expired (day 31, day 30 still holds, SAST midnight); case number malformed (trigger and CHECK) or before 2000; reported in the future, before the loan, or over 14 days back (TS and trigger); a case of a later year; a closed loan (reveal and record); a renewal of another case, with another date, or a fourth report of a case; recorded by READONLY in SQL; a report changed or deleted |
| Report input | `lib/telematics/theft-reports.test.ts` | unit | each malformed field named |
| Purpose gate in SQL | `lib/telematics/theft-trail.integration.test.ts` | IT | each branch of `telematicsPurposeHolds` (DEFAULT by status, RECOVERY by status, LEGAL_MATTER by status, THEFT with another loan's, an unconfirmed, an ended report or a closed loan); an access row by SQL for each purpose that does not hold; a non-THEFT row naming a report; TRAIL with DEFAULT, TRAIL without a count, LATEST with one |
| Roles | same + `app/api/asset-finance/telematics/followup-routes.test.ts` | IT + unit | READONLY, INSURANCE_OFFICER and a dealer on the trail and the report (403, audited, nothing logged); the letter route |
| Trail inside tenure and retention, purged per position | `lib/telematics/theft-trail.integration.test.ts`, `edge-followups.integration.test.ts` | IT | a fix before the loan started not shown; THEFT from 7 days before the report; a fix after the next loan's start not shown; retention 1 day drops older fixes before any purge; 500 and 501 points; a device swapped mid-tenure; the purge deletes the older half one by one and keeps the rest |
| Every view logged | same | IT | a trail view writes one access row (view TRAIL, its count, its report) and an audit row without a coordinate |
| Void four-eyes in SQL | `lib/asset-finance/meter-void.integration.test.ts`, `lib/asset-finance/edge-followups.integration.test.ts` | IT | self-approval (TS and CHECK); asked or decided by READONLY in SQL; a second open request (TS, index, two at once through the route); a decided void changed or decided again; two decisions at once; a void deleted; a void inserted APPROVED; a reading edited or stamped by another reading's void; a reading deleted |
| Void refused when billed or final | same | IT | final reading (at request and at approval); invoiced lease; a recovery's or a claim's reading; already void; the lease's only live reading |
| Voided readings ignored | same | IT | the monotonic floor (TS and trigger); the start reading (pace ceiling value, excess projection, end-of-term invoice: refused with only the final left, billed as before once corrected); the final-reading rule at inspection (`guardLeaseEndOfTerm`); one telematics reading a day; never cited after as a final, recovery or claim reading |
| Closure once, all paths | `lib/asset-finance/tracker-closure.integration.test.ts`, `edge-followups.integration.test.ts` | IT | settled by payment (applyManualReceipt); end of term settled (completeEndOfTermIfSettled, the loan open until then); any other status change; completing twice; reopened and completed again; a device removed before; the asset re-leased; three or four runs at once (one email); a fresh claim left alone, a stale one taken over; a send in flight or an unexpected error decides nothing |
| Closure message gated | same + `lib/asset-finance/tracker-closure.test.ts` | IT + unit | wording not approved: held, nothing told; no lender email or email switched off: BLOCKED, transport never called; an opted-out contact (the pipeline's consent gate); a deceased borrower; an unverified dealer-typed contact; an entity with no acting person; lender identity missing (fails closed); with email: the real pipeline once, transport faked; the processor's only outbound imports are the send pipeline |
| Closure steps recorded once | same | IT | a decided message, a notice, a letter or a removal rewritten; done without the device removed; opened for a removed device; deleted |

### Known limitations (part T)

- **The case number is checked for form only.** Nothing verifies it with SAPS;
  the second person's confirmation is the check, and both are audited.
- **The trail map is an inline sketch** of the points (no map tiles, no
  external call): enough to see movement, not a street map.
- **A closure email stuck in reconciliation** (an outcome the provider never
  confirmed) leaves the closure's email undecided until staff reconcile the
  message; the notice and the letter are not held back.
- **Recipients of an entity's notice** are the people who act for it with
  trusted contact details; the letter is addressed to the entity with no
  postal address (the entity's registered address is not on file in a
  printable form).
- **A deceased borrower** gets no notice and no email; the letter is stored
  addressed to "The borrower" for the file. Staff contact the executor about
  the device themselves.
- **A written-off loan opens no closure** (only a move into COMPLETED does):
  collection still stops with the tenure, but no notice or removal task.
- **Contact details a dealer typed and staff never verified** get nothing:
  the email is decided BLOCKED once, and verifying them later does not resend.
- **A closure email held in reconciliation** returns to every run until staff
  reconcile the message; with many such, newer closures wait behind them
  (200 a run, oldest first).
- **A meter reading with no lease** (`loanId` null) cannot be voided here.
- **The closure letter** is read with `work_telematics_alerts` (the tracker
  work queue's permission, the same roles as `view_asset_position`), each view
  on the document access register.
- **The position purge** deletes at most 200 batches of 5 000 a tenant a
  night; a fleet reporting every minute would need more.
