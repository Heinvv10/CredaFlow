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
