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

## Part W — Commission disclosure (§2a 2)

On the asset-finance documents of a deal a dealer or broker introduced: a
labelled **Introducer** row naming it, and one fixed, protected paragraph
saying the lender may pay it a commission, from its own funds, and that this is
no part of what the borrower pays. A statement, never a figure. The wording is
DRAFT for the SA-legal reviewer (goal §2a 7); the lender's legal team still
approves its rendered documents. Reworked after review round 1 (security,
architecture, SA legal): the name is a field, not a part of the sentence.

### Decisions and deviations

1. **Dealer deals only.** Printed when `AssetFinanceDeal.dealerId` is set, on
   no other deal. A non-dealer deal renders byte-identical to before.
2. **The name is a labelled field, the paragraph is fixed text.** The
   introducer prints as the row `Introducer | <name> (dealer)` or `(broker)`
   (`Dealer.kind`), the supplier pattern. The paragraph says "the introducer
   named above" and never contains the name, so the fingerprint covers its
   exact bytes and no name can add wording to it.
3. **The CPA variants are included.** They share their renderers with the
   commercial ones (one branch), and a consumer is owed the disclosure at
   least as much as a company. The goal lists only the commercial and NCA
   variants; this is the one addition. Suretyships and the resolution print
   nothing.
4. **Placement.** Instalment sale and leases: the Introducer row ends the
   price table (section 5, "PRICE AND FINANCE" / "RENTALS") and the unnumbered
   paragraph follows it, so no clause number moves and `protectedClauses`,
   `additionalTermNumber` and the starters' cross-references are unchanged.
   NCA quotation and agreement: a section of its own, "COMMISSION TO THE
   INTRODUCER" (row, then paragraph), outside the cost-of-credit disclosure:
   in the agreement between "FINANCIAL TERMS" and "TERMS AND CONDITIONS", in
   the quotation after the repayment schedule and before "ACKNOWLEDGEMENT".
5. **The NCA quotation is not a template** (legacy flag, no fingerprint): no
   pin and no demo approval to renew; it is protected by the unit tests below.
   See limitation 1.
6. **No commission amount, rate or total is ever printed**, and the paragraph
   does not warrant that the commission increases nothing: it says it is not
   part of the listed amounts (the unprovable "does not increase any of them"
   was removed on the legal review). The commission snapshot
   (`dealerCommission*`) is read by no document.
7. **The introducer is pinned on issuance.** The e-sign and contract steps
   re-render an issued agreement to compare its hash; they now take the
   dealer, like the lender identity, from the input retained when it was issued
   (`pinnedIssuance` returns `dealer`), never from `Dealer` as it is now. A
   rename after preparation, even one that fails the shape rule, cannot stop a
   signer signing what they were shown. A retained input from before the
   disclosure has no `dealer` key: it reproduces its PDF without the clause.
8. **The name rule is a shape check only** (`wording/dealer-name.ts`). The name
   is data in a field, not wording, so the earlier word list and amount check
   are gone: they refused real names ("May & Sons", "Price Brothers Plant
   Hire", "Not Just Tractors") and could not stop an injection anyway. The
   rule: 1 to `MAX_DEALER_NAME` (80) characters; no leading, trailing or
   repeated spaces; only text the document font prints, with no line breaks,
   tabs, control, no-break-space, soft-hyphen, zero-width or non-Latin
   characters. Full stops and quotation marks are allowed ("Pty. Ltd."). It
   runs when staff create or edit a dealer (422 on `name`; the read limit is
   now 80, was 160) and again whenever a document is built, for names written
   before the rule: the Introducer row refuses with `DealDocumentError`
   (the instalment sale and leases refuse to prepare, 422), and nothing is
   rendered, issued or superseded. Only staff write `Dealer.name`; no dealer
   user can.
9. **The NCA stores keep their own pre-check** of the name (`not_ready` /
   `invalid_start` with the reason) although the render refusal would also stop
   them: the NCA routes do not map `DealDocumentError`, so the render refusal
   alone would be a 500, and the pre-check refuses before a quotation's file is
   saved or a signer row is touched. The refusal text says "the document", not
   "the agreement", so it reads right on the quotation.
10. **Lender text cannot say it.** `templates/validate.ts` keeps `commissions?`
    in its OVERRIDING list and now also refuses the soft hyphen and the
    zero-width characters (U+200B to U+200D, U+2060, U+FEFF), so "commis­sion"
    cannot slip past it.
11. **Why a dealer shape, not a dealer in every shape.** Each existing shape
    stays dealer-less so its PDF, and so its hash, does not change; one
    `dealer` shape per variant carries the row and paragraph into the
    fingerprint. `SYSTEM_REVISION` stays 2026-10-22.1 (not released yet).
12. **Registration number not printed.** It is unvalidated free text, and the
    name with its dealer or broker label identifies the introducer.

### The wording, per document (`wording/commission-disclosure.ts`)

The row, then the paragraph. `<name>` is `Dealer.name`; the paragraph never
contains it.

- **Instalment sale** (`af.isa.*`; the Seller, the Purchaser, the Schedule):
  > Introducer | `<name>` (dealer)
  >
  > Introducer's commission. The Seller may pay a commission to the introducer
  > named above, which introduced the Purchaser to the Seller for this
  > Agreement. The Seller pays any commission from its own funds. It is not
  > part of the cash price, the payments in the Schedule or any other amount
  > the Purchaser pays or owes under this Agreement.
- **Operating and full-maintenance leases** (`af.lease.*`; the lessor, the
  lessee):
  > Introducer's commission. The lessor may pay a commission to the introducer
  > named above, which introduced the lessee to the lessor for this agreement.
  > The lessor pays any commission from its own funds. It is not part of the
  > rentals or any other amount the lessee pays or owes under this agreement.
- **NCA agreement** (`af.nca.*`), under the heading COMMISSION TO THE
  INTRODUCER and the Introducer row:
  > The Credit Provider may pay a commission to the introducer named above,
  > which introduced the Consumer to the Credit Provider for this agreement.
  > The Credit Provider pays any commission from its own funds. It is not a fee
  > or charge to the Consumer: it is not part of the cash price, the principal
  > debt, the interest, the fees, the instalments or any other amount the
  > Consumer pays or owes, and it is not included in the total cost of credit
  > shown above.
- **NCA quotation:** the same, "for the proposed agreement".

### Rule-to-test matrix (IT = `RUN_ASSET_TEMPLATES_IT`)

| Rule | Test | Kind | Negative cases (§3 W) |
|---|---|---|---|
| Row and paragraph on each of 9 render paths, in the place the design puts them (price section, or the NCA section between its neighbours); broker labelled as a broker | `documents/commission-disclosure.test.ts` | unit | the paragraph carrying the name; a broker printed as a dealer; the NCA section after the acknowledgement |
| Exact wording (the constants in `commission-disclosure.test-helpers.ts`) | same | unit | any word of it changed (e.g. the old "does not increase") |
| No row, paragraph or section on a non-dealer deal; byte-identical to a deal with `dealer` absent | same | unit | `dealer` null and undefined, on every path |
| Amounts never change: every `R` figure, in order, is the same with and without a dealer, and nothing but the row, heading and paragraph differs | same | unit | any figure moved on a dealer deal |
| NCA cost-of-credit pinned: the "Total cost of credit" line (R 18,732.50) and the quotation's clause 1.5 sentence are identical | same | unit | cost of credit moved on the quotation or agreement |
| A name that fails the shape check is never printed: every path throws `DealDocumentError`; names the old word list refused, and full stops, print | same | unit | line break, soft hyphen, zero-width, no-break space, control, CJK, empty, leading space, 81 characters |
| Staff write refuses a bad name on create and edit; accepts real names | `lib/dealer/staff-input.test.ts` | unit | the same shapes |
| The shape rule and the refusal text | `wording/dealer-name.test.ts` | unit | 21 refused shapes, 14 accepted; refusal says "document", not "agreement" |
| The NCA stores refuse a bad name and hand the dealer (with its kind) to the renderer | `legal-wording-flag-nca-{quote-store,agreement-store,entity-signing}.test.ts` | unit | a deal with no dealer hands `null`; a bad name renders and writes nothing |
| Lender text cannot carry a commission, or hide the word with an invisible character | `commission-disclosure-templates.test.ts` | unit | three phrasings in each editable variant; six invisible characters; an editable clause |
| Preview shapes: only the `dealer` shape prints the row, and it differs from the first shape by exactly the disclosure; suretyships and the resolution have no dealer shape | same | unit | the disclosure in a dealer-less shape |
| The disclosure is fingerprinted; pins moved | `templates/fingerprint.test.ts` (`PINNED`, `BRANCHES`) | unit | a variant whose dealer shape is missing |
| Demo re-approval after the revision bump: exactly the eight lapsed variants lapse, are approved again with the lender's wording unchanged, the three others keep theirs, a second run adds nothing, documents issue again; a dealer deal's agreement names the introducer, moves no figure, and its retained input reproduces the PDF; a pre-rule bad name is refused at preparation with nothing superseded | `templates/commission-reapproval.integration.test.ts` | IT | prepare before the re-approval refused (422) and writes nothing |
| The introducer is pinned: rename (valid, then shape-invalid), then e-sign, resolution, wet-ink sureties and the contract step all succeed; an input retained with no dealer key reproduces and e-signs though the deal now has a dealer | `templates/commission-pinned-issuance.integration.test.ts` | IT | a rename making the live render differ |

### Proof of what changed in the fingerprints

`SYSTEM_REVISION` 2026-10-19.1 → 2026-10-22.1. Eight pins moved; three did
not. Per-shape hashes before and after are committed
(`evidence/slice5-followups/commission/`, with the command to reproduce; the
"after" file is for the reworked design).

| Variant | Pin before → after |
|---|---|
| `af.isa.commercial` | `99337242…2910` → `86e5629d…222b` |
| `af.isa.cpa` | `ebe0d4c1…9cec` → `811c6e52…1ec0` |
| `af.lease.operating.commercial` | `a192a558…0814` → `741a608e…e54f` |
| `af.lease.operating.cpa` | `ed970f47…4c55` → `7c13830e…0eb3` |
| `af.lease.fml.commercial` | `45434a91…a596` → `3e6bf1f8…301b` |
| `af.lease.fml.cpa` | `59323cd3…e73e` → `ec1b899b…4d2c` |
| `af.nca.instalment_sale` | `edb5b49d…75bb` → `1bee05ba…f009` |
| `af.nca.finance_lease` | `c868e667…cff2` → `e89a635f…9ff4` |
| `af.suretyship.commercial`, `af.suretyship.nca`, `af.resolution.standard` | unchanged |

(Full values: `templates/fingerprint.test.ts` `PINNED`.)

1. **Every existing shape renders byte-identical.** All 7, 7, 9, 10, 9, 10, 9
   and 9 pre-existing shapes of the eight variants have the same PDF SHA-256
   before and after. The only reason a pin moved is the added shape.
2. **The added shape is the first shape plus the disclosure, nothing else.**
   `commission-disclosure-templates.test.ts` renders both and shows that
   taking the heading, row and paragraph out of the dealer shape gives the
   first shape's text exactly.
3. **No other change:** the three variants that print nothing new keep their
   pins (`commission-reapproval.integration.test.ts` asserts this against the
   previous values).

Release effect: from deploy, a lender's published version of the eight
variants stops issuing until re-approved. On a demo lender
`scripts/asset-finance/ensure-demo-templates.ts` does it (proved on real
Postgres). A real lender approves again, its own wording unchanged. Recorded
in `DESIGN.md` as `fingerprint.test.ts` asks.

### Known limitations and open points (part W)

1. **The quotation's wording approval is a flag, not a fingerprint.** The NCA
   quotation (`FORM_20_PRE_AGREEMENT`) is approved by
   `TenantConfig.assetFinanceLegalWordingApproved`, which nothing lapses when
   the wording changes. A lender that already set the flag prints the new
   section without the DRAFT mark; no lender is live. The goal requires the
   clause on the quotation. A quotation fingerprint like the templates' is a
   design decision for the planner tier.
2. **Counsel items on the wording** (confidence MEDIUM-LOW; DRAFT):
   - whether extra text on the pre-agreement statement and quotation stays
     within the prescribed form's content;
   - whether "it is not included in the total cost of credit" is the right way
     to say it under the NCA's definition (true here because nothing is added
     to the consumer's charges);
   - "may" versus "will" when a commission rate is on record for the dealer;
   - whether the borrower must be offered the amount on request (no rule
     found; the amount is not disclosed, MEDIUM confidence);
   - whether to print when the commission source is `NONE` (no rate in force);
   - commission calculated on the financed amount, and whether that is a
     conduct matter;
   - Consumer Protection Act s27 and the CPA variants (the paragraph is in the
     price section, not in the CPA notices);
   - when the supplier and the introducer are the same business, the
     supplier's legal name versus the dealer's trading name;
   - the scope of insurance commission, which this paragraph does not cover.
3. **A name written before the shape rule** that fails it blocks preparation of
   that dealer's deals until staff edit the name (the refusal says so). Names
   like "Pty. Ltd." or "Smith "Quick" Motors" now pass.
4. **Pre-existing documents.** An issuance's retained input from before this
   release has no `dealer`; it reproduces without the clause, as issued. A
   dealer deal prepared before the release carries the clause only once
   prepared again (its templates lapse at the release anyway).
5. **Other documents.** Statements, the s129/s127/s131 notices, the lease
   servicing documents and the post-sale statement print no disclosure; the
   goal lists only the agreements and the quotation. Nothing under `lib/pdf/`
   is touched.
6. **Commission amounts stay out.** No document, and no template token,
   exposes the commission snapshot.
