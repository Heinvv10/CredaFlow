# Asset finance slice 5 follow-ups — the review-item decisions

Build spec for the seven review items Hein decided on 2026-10-22 (goal
`.claude/handoffs/2026-10-22-asset-finance-slice5-followups-goal.md`, §2a).
One PR per part, D → T → W. Where the code or the law made a §2a default
unsafe, the safer option is taken and recorded under "Deviations".
Mutation evidence: `evidence/slice5-followups/MUTATIONS.md`. Browser
acceptance: `evidence/slice5-followups/browser/<part>/`.

## Part D — Dealer: consent v2, draft cancel, draft purge (§2a 1 and 8)

### Deviations from the goal's defaults (and why)

1. **Declined deals are kept three years, not 90 days.** A deal the dealer
   handed to the lender is an application for credit the lender received.
   NCA Regulation 55(1)(b) makes a credit provider keep the records of a
   declined application (and its pre-agreement quote) for three years, and
   POPIA s14(1)(a) allows retention a law requires. So the 90-day clock runs
   only for a deal the lender never received (`dealerSubmittedAt` NULL: an
   abandoned or cancelled draft). A deal handed over that ended DECLINED,
   REFUSED_NCA or CANCELLED is purged by the same cron three years after it
   ended. Confidence MEDIUM: the legal reviewer confirms; if counsel says a
   dealer deal is not yet an "application" until the staff accept, the line
   moves from `dealerSubmittedAt` to the accept, a one-line SQL change.
2. **The deal row and its application stay.** Nothing on them is personal
   information beyond foreign keys (the application's purpose names the
   asset), the status table makes them terminal, and every audit row points
   at them. The purge erases the people, the business and the documents.
3. **The database anonymises, not the TypeScript.** Setting
   `Client.dealerPurgedAt` (or `BusinessEntity.dealerPurgedAt`) makes the
   trigger check eligibility and overwrite every identifying column itself,
   so no caller can "purge" a booked borrower or leave a column behind.
4. **"Linked elsewhere" is read from the catalog.** Whether a person or
   business is linked to anything outside the purged deal is decided by
   walking every foreign key that references the table (`pg_constraint`), so
   a table added later counts as a link (fail closed) without anyone
   updating the purge.
5. **Remote identity check is free text (10–500 characters).** The dealer's
   remote processes vary (video call, e-signature platform identity check,
   certified copy plus call-back); the statement snapshot records what the
   dealer said it did. An enum would force a false choice.

### Data (migration `20261022100000_dealer_followups`)

```prisma
enum DealerConsentSigningMethod { IN_PERSON REMOTE }
enum DealerDealPurgeReason { ABANDONED_DRAFT CANCELLED_DRAFT ENDED_AFTER_HANDOVER }

model DealerConsentAttestation { // + signingMethod DealerConsentSigningMethod?, remoteIdentityCheck String? }
model AssetFinanceDeal         { // + cancelledByDealerUserId String? (→ DealerUser) }
model Client                   { // + dealerPurgedAt DateTime? }
model BusinessEntity           { // + dealerPurgedAt DateTime? }
model DealerDealPurge {         // id, tenantId, dealId @unique (→ deal), reason, purgedAt,
                                // clientsErased, clientsKept, entitiesErased, entitiesKept, documentsErased
}
```

- **CHECK `DealerConsentAttestation_signing_method`**: a `dealer-consent-v1`
  row has neither column; any other version has a method, and
  `remoteIdentityCheck` (trimmed 10–500) exactly when REMOTE.
- **`guardDealerConsentAttestation`** (re-created): an INSERT naming
  `dealer-consent-v1` is refused (new attestations are v2); the UPDATE rule
  is unchanged (only the verification, once), so a v1 row cannot gain a
  method or have its text changed.
- **CHECK `AssetFinanceDeal_cancellation_shape`** (replaced): a CANCELLED deal
  has `cancelledAt`, a reason ≥ 10 characters and exactly one of
  `cancelledById` (staff) and `cancelledByDealerUserId` (dealer).
- **`guardAssetDealDealerCancel`** (BEFORE INSERT OR UPDATE): a dealer
  cancellation is set only on the move DRAFT → CANCELLED of a deal never
  handed over (`dealerSubmittedAt` NULL), by an active user of the deal's
  dealer that is DEALER_ADMIN or the deal's creator. `freezeTerminalAssetDeal`
  is re-created with the new column in its cancel whitelist.
- **`dealerDealPurgeReason(tenant, deal)`** → the reason or NULL, the one
  definition the cron selects with and the tombstone trigger checks: a dealer
  deal with no loan, and
  - ABANDONED_DRAFT: DRAFT, never handed over, last activity (the deal, its
    documents, attestations, document requests, the business's
    relationships) more than 90 days ago;
  - CANCELLED_DRAFT: CANCELLED, never handed over, cancelled > 90 days ago;
  - ENDED_AFTER_HANDOVER: handed over, DECLINED / REFUSED_NCA / CANCELLED,
    ended (cancelledAt, else decidedAt, else updatedAt) > 3 years ago.
- **`guardDealerDealPurge`**: INSERT only when the reason is the function's
  answer now; never updated or deleted.
- **`dealerPurgeLinkedElsewhere(tenant, table, id, deal)`**: true when any
  row of any table with a foreign key to `Client` / `BusinessEntity` refers
  to it, other than: the deal itself, its application, its documents, its
  consent attestations, `ClientConsent`, and an `EntityRelationship` to the
  deal's business.
- **`guardDealerPurgedParty`** (BEFORE UPDATE OF "dealerPurgedAt" on Client
  and BusinessEntity): set once; the row was captured by a dealer; a
  tombstone exists for a deal naming it (borrower, or a person of its
  business); not linked elsewhere; then it overwrites every identifying
  column (names, ID/registration number, contact, address, employment,
  bank, next of kin, portal password; unique columns get `erased-<id>`).

### Library and routes

- `lib/dealer/consent.ts`: `DEALER_CONSENT_VERSION = "dealer-consent-v2"`,
  `DEALER_CONSENT_STATEMENT` (no "in my presence") plus the method line;
  `attestDealerConsent` takes `signingMethod` and `remoteIdentityCheck` and
  snapshots the statement with the method line. v1 text lives only in the
  rows that snapshotted it.
- `lib/dealer/cancel.ts` `cancelDealerDraft(actor, dealId, reason)`:
  404 for another dealer's deal and for a SALES user's colleague's draft;
  409 once handed over or not DRAFT; otherwise the deal → CANCELLED, its
  application → CANCELLED, the asset released, audit `DEALER_DEAL_CANCELLED`.
  Route `POST /api/dealer/deals/[id]/cancel`.
- `lib/dealer/draft-purge.ts` `purgeDealerDrafts()`: per tenant with a
  dealer, each deal `dealerDealPurgeReason` names, in its own transaction
  (deal locked): the tombstone, then `dealerPurgedAt` on each dealer-captured
  person and business not linked elsewhere (the DB erases them), then each
  document of the deal: its bytes deleted, the row deleted when nothing
  refers to it, else kept soft-deleted with `fileName` "erased". Audit
  `DEALER_DEAL_PURGED` (counts only). Cron `asset-finance-dealer-draft-purge`
  (daily 03:50, `CRON_SECRET`).
- UI: the dealer deal page gains the signing method and remote identity
  fields and a "Cancel draft" form; the staff Dealer panel shows each
  attestation's method and identity check, a dealer cancellation, and the
  purge tombstone.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_DEALER_IT`)

| Rule | Test | Kind | Negative cases (§3 D) |
|---|---|---|---|
| v2 attestation carries a method; REMOTE needs the identity check | `lib/dealer/dealer-consent-v2.integration.test.ts` | IT | REMOTE without identity; IN_PERSON with one; v1 insert after the change |
| v1 rows unchanged | same | IT | a v1 row altered (text, method added) |
| Statement wording and snapshot | `lib/dealer/consent-v2.test.ts` | unit | "in my presence" absent; method line per method; input bounds |
| Dealer cancels its own draft | `lib/dealer/dealer-cancel.integration.test.ts` | IT | another dealer's draft (404); SALES on a colleague's (404); a handed-over deal (409); SQL: dealer cancel on SUBMITTED, by another dealer's user, both cancellers set |
| Purge eligibility | `lib/dealer/draft-purge.integration.test.ts` | IT | a deal active within 90 days; a booked deal; a handed-over declined deal at 91 days; tombstone for an ineligible deal by SQL |
| Purge scope | same | IT | a Client shared with another deal or loan kept; a booked deal's client, entity and documents byte-identical after the run; erase by SQL on a staff-captured or linked client refused |
| Purge erases and keeps the tombstone | same | IT | rerun is a no-op; tombstone UPDATE/DELETE refused |
| Cron route | `app/api/cron/asset-finance-dealer-draft-purge/route.test.ts` | unit | no `CRON_SECRET` |
| Cancel route | `app/api/dealer/deals/[id]/cancel/route.test.ts`, `app/api/dealer/dealer-route-guards.test.ts` | unit | short reason; refusal mapping; no session, staff/client/other lender's session, portal off |

### Known limitations (part D)

- **What stays after a purge.** The deal row, its application (the purpose
  names the asset), the consent attestations (no personal data beyond the
  dealer's remote identity-check note), `ClientConsent` flags, every audit row
  (a business's capture audit holds its legal name and registration number),
  staff document-request notes, and the dealer-captured asset. The goal asks
  that the audit and a tombstone remain; the rest carries no identity once the
  people and business rows are erased, except where staff typed one into a
  note.
- **Free-text status notes on a person** (risk flag, blacklist, deceased,
  KYC rejection reasons) are not overwritten; a dealer draft never has them.
- **A handed-over deal's people are usually kept.** Once the lender screened
  or checked them, those rows link the person elsewhere, so the three-year
  purge erases the documents and keeps the person (counted as kept). Erasing
  them is a DSAR decision, as today.
- **Batch.** At most 500 deals per lender a run (oldest first); the rest wait
  for the next night.
