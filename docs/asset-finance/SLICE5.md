# Asset finance slice 5 — dealer portal, telematics, valuation guides

Build spec for slice 5. The goal file is
`.claude/handoffs/2026-10-19-asset-finance-slice5-goal.md` (in the main
checkout); its §2a product decisions are fixed. One PR per part, A → B → C.
Where the code made a §2a default unsafe or impossible, the safer option is
taken and recorded under "Deviations".

## Part A — Dealer/broker portal and commission

### Deviations from the goal's defaults (and why)

1. **Dealer "submit" hands the deal to the lender; a staff member's accept runs
   `submitDeal`.** `submitDeal` → `classifyApplication` writes
   `NcaRegimeOverride.requestedById` (FK → `User`) for a juristic NON_NCA
   result, and the NCA regime is the lender's determination. The dealer's
   submit records `AssetFinanceDeal.dealerSubmittedAt` (deal stays DRAFT); the
   staff "accept submission" calls the unchanged `submitDeal` with the staff
   actor. This is what keeps §7.3 ("unchanged staff credit flow") literally true.
2. **Tenant default commission is a date-effective `DealerCommissionRate` row
   with `dealerId` NULL**, not `TenantConfig` columns: a column has no history,
   and the approval snapshot must resolve the default in force on the approval
   date. `TenantConfig` gains only the flag and the clawback months.
3. **No new input-VAT role.** `INPUT_VAT` already exists (slice 4b); commission
   VAT posts there. Two roles are appended: `DEALER_COMMISSION_EXPENSE`,
   `DEALER_COMMISSION_PAYABLE`.
4. **"Lockout like staff" = the staff rate-limit buckets.** Staff have no
   account lockout: `lib/auth.ts` blocks on three in-memory buckets (per email,
   per IP, combined; 10/30/10 per 15 min) and records `FailedLoginAttempt`. The
   dealer path sits after the same gate, unchanged. `LoginLog.userId` is a
   `User` FK, so dealer sign-ins are audited (`DEALER_SIGNED_IN`) instead.
5. **Commission base = the goods advance**: the asset's cash price incl. VAT
   less the deposit and the trade-in (what the supplier payout is), taken from
   the deal and asset at approval. Not the financed amount, which carries the
   financed fees, and not `Loan.principal`, which for a lease is every rental
   and for an instalment sale includes capitalised interest. Commission never
   depends on the rate or the fees (review round 1, deviation 29; it was
   `COALESCE(approvedAmount, appliedAmount)`).
6. **A loan that becomes CANCELLED always reverses commission**, whatever the
   window (the contract was unwound, like a cancelled deal). Early COMPLETED and
   WRITTEN_OFF reverse only inside the window. Default window 0 = off.
7. **Dealer bank accounts are captured by staff only** (requester and approver
   are two `User`s). A dealer user has password-only sign-in; self-service bank
   details would let one stolen password redirect commission.
8. **Dealer consent is evidence, not consent.** The dealer uploads the signed
   form and attests; a staff member verifies it, which then records
   `ClientConsent.creditBureauEnquiry` through `lib/consent.ts` with the staff
   actor. Bureau checks keep reading `ClientConsent` unchanged.
9. **Provenance.** A dealer deal may name only a borrower (entity or client)
   and asset that the same dealer captured (`createdByDealerId`, DB-enforced).
   A duplicate (`Client` unique on idNumber/email, entity on registration
   number, asset identifiers) answers 409 "already on the lender's book — ask
   the lender" and shows nothing of the existing row. This is §2a.4 "never data
   the borrower didn't give through that dealer".
10. **Dealer-uploaded documents never satisfy staff-evidence gates**: the
    existing SQL requires `uploadedByType = 'staff'` for checklist, legal and
    surplus evidence. Staff verify or re-upload. Nothing is relaxed.
11. **The dealer host runs on the staff container.** `roleRefusedOnThisHost`
    refuses every non-CLIENT role on `APP_MODE=client`.

Build-time deviations (tasks 1–2, migration `20261019120100_dealer_portal`),
each the safer reading of the text below:

12. **Snapshot shape with no rate.** Source `NONE` has no rate row, so
    `dealerCommissionRateId` is NULL exactly when the source is `NONE`; the
    other five snapshot columns are all set or all NULL.
13. **Snapshot writes.** Any caller change to a snapshot column is refused,
    including on the move into APPROVED (not only values that differ from the
    computed ones), and a dealer deal is inserted with no snapshot and no
    `dealerSubmittedAt`.
14. **Line dating and signs.** An EARNED line must be dated today (no
    backdating by hand); a REVERSED line is dated today and negates
    `baseCents`, `flatCents`, `netCents`, `vatCents`, `grossCents` (bps, VAT
    rate, vendor flag and months copied), so `net = round(base × bps / 10 000)
    + flat` holds on every line.
15. **Maturity** is compared on the Johannesburg calendar date of
    `Loan.maturityDate`, as the booking gate compares `startDate`.
16. **Runs.** `DealerPayableRun_totals` also requires `totalNetCents > 0`
    (the lines-wait rule enforced in the database, not only in TS);
    `_status_shape` requires a non-blank `releaseReference` on RELEASED and
    none otherwise; cancelling cannot add or change the approval.
17. **Deletes refused.** `DealerBankAccount` rows are never deleted (the
    supplier guard allows DELETE; a run names its account).
18. **Same-dealer checks.** A dealer-user creator belongs to the same dealer;
    a consent document's uploader is a user of the deal's dealer and the
    attesting user is active; a document request is made on a dealer deal and
    fulfilled only by a live document of the same deal and `docType`; its note
    is 1–500 non-blank characters.
19. **IT booking fixture.** Until task 4 gives `createDeal` its `dealer`
    parameter, `lib/dealer/dealer-booking.integration-fixture.ts` INSERTs the
    dealer deal and moves it with plain UPDATEs, every trigger on; only the
    rows a real booking already has by then (Loan, ContractRate, checklist
    item, APPROVED Payout, DISBURSED application) are written with triggers
    off, and the CONTRACTED → BOOKED UPDATE itself runs every gate. The
    cost-of-credit IT (task 9) books through the real routes.

Hardening (security review of `20261019120100`; migration
`20261019120200_dealer_portal_hardening`, additive, hand-written):

20. **Provenance is written once.** `createdByDealerId` on `Client`,
    `BusinessEntity` and `FinancedAsset` is set by the capturing INSERT and
    never changed (`guardCreatedByDealerFixed`): a staff row cannot be
    re-badged as a dealer's to pass the deal provenance check. These tables
    get no `_no_truncate` trigger for it (the rule is about UPDATE; their
    existing guards are unchanged).
21. **A dealer deal's borrower and asset are fixed from insert**
    (`AssetFinanceDeal_dealer_parties_fixed`), rather than re-checked on
    UPDATE: no code path changes a deal's `entityId`, `clientId` or `assetId`
    (grep of every `assetFinanceDeal.update*`), and the staff flow already
    freezes them from APPROVED. Staff deals are unaffected.
22. **Runs net clawbacks.** An EARNED line joins a run only after its REVERSED
    line (if any) is linked to the same run (`DealerPayableRunLine_netting`;
    the run-create code links REVERSED lines first). On approval
    (`DealerPayableRun_netting`): an EARNED line in the run with a reversal has
    it in the run; a REVERSED line in the run has its EARNED line in a live
    run; and every line of the dealer effective by `periodEnd` is in a live
    run, except an EARNED line whose reversal is also in none (the pair nets to
    zero and waits for the run that takes the reversal). A line written after
    the run was created but dated by its period end (only when `periodEnd` is
    today) blocks approval: cancel and recreate. The run-create code (task 7)
    must leave out an EARNED line whose reversal falls after `periodEnd`.

Build-time deviations (tasks 3-5):

23. **Dealer host writes.** Besides the spec's refusals, a write on the dealer
    host must say it is same-origin (Origin or Sec-Fetch-Site), as on the
    console host (`crossSiteWrite`, now exported from `operator-host.ts`). No
    JSON requirement: uploads are multipart. An operator session there is
    refused by the operator off-host rule, which runs first (API 403, page 404).
24. **Guards that let DEALER through, fixed** (found by the guard census,
    `lib/dealer/staff-guards-refuse.test.ts`): `getDocumentCaller` looked any
    non-staff session up as a client by email (a dealer user sharing a
    client's email would have read that client's documents); it now does so
    for CLIENT only. `getStaffTenantId`, `requireLoanBookPage` and the
    dashboard layout 404 a DEALER. `hasMinRole`/`canDo` refuse it explicitly.
25. **Dealer people.** A dealer-captured person is always a new `Client`
    (no linking of an existing client). A person the lender links to a
    dealer's entity is shown to the dealer as "A person added by the lender",
    never by name.
26. **Missing items before signing** are the people without a consent
    attestation and the open document requests: there is no fixed list of
    required document types to compare against.
27. **Audit:** one more action, `DEALER_DOCUMENT_REQUEST_FULFILLED`. Setting a
    password through a link bumps `tokenVersion`; deactivating a user or a
    dealer also clears any pending link.
28. **Test files:** cross-dealer and cross-tenant 404s are in
    `lib/dealer/dealer-deal-access.integration.test.ts`; capture, consent,
    submit and accept in `lib/dealer/dealer-submit.integration.test.ts`.

Review round 1 (PR #216 reviews; migration
`20261019120300_dealer_portal_review_fixes`, additive except the two
replacements named in it):

29. **Goods-advance base** (deviation 5): `guardAssetDealDealer` is replaced
    with the new base; nothing else in it changes.
30. **No loan performance to the dealer.** The deal projection and the
    commission statement carry no reversal reason: a reversed line reads
    "Reversed (clawback)". Staff views keep the reason.
31. **Lender-added people are the lender's.** A dealer attests consent only for
    a person it captured (`DealerConsentAttestation_subject_captured`); a
    person the lender added to a dealer's entity is not needed for the dealer's
    submit and shows as "Consent taken by the lender". The lender records that
    consent through its own flow.
32. **Classification re-stamped on accept.** A sole proprietor's NCA
    classification, written with the dealer user at create, is re-stamped to
    the accepting staff member (`ncaClassifiedById`, a later `ncaClassifiedAt`)
    before `submitDeal`; an entity's is re-run as staff by `submitDeal`.
33. **Hand-over in the database.** `AssetFinanceDeal_dealer_handover`: a dealer
    deal leaves DRAFT (other than to CANCELLED) only with `dealerSubmittedAt`.
    After the hand-over a dealer uploads only to answer an open document
    request (409 otherwise).
34. **Dealer-typed contact details are untrusted** until a staff member
    verifies them (`Client.dealerContactVerifiedAt/ById`, a button per person
    on the staff deal's Dealer panel, audited `DEALER_CONTACT_VERIFIED`, once).
    Until then the portal register route issues no activation code and
    activates nothing (same generic answers), the database refuses a portal
    password (`Client_dealer_contact_guard`), and no signing code is sent.
35. **Reset links.** A staff reset link clears the old password (sign-in
    refuses until the link is used) and is refused for a deactivated dealer.
36. **Refusals audited.** Each "already on the lender's book" capture refusal
    (`DEALER_CAPTURE_REFUSED_ON_BOOK`: the dealer user and the kind of row,
    never the values typed); a run's self-approval
    (`DEALER_PAYABLE_RUN_APPROVAL_REFUSED`) and a bank account's self-decision
    (`DEALER_BANK_ACCOUNT_DECISION_REFUSED`). Captures are rate limited per
    dealer user, 30 per 15 minutes (429).
37. **Dealer tax invoice at release.** A run carrying VAT is released only with
    the VAT-vendor dealer's own tax invoice number and date
    (`DealerPayableRun_tax_invoice_shape`, `_on_vat`). A recipient-created tax
    invoice is not supported.
38. **Smaller.** `DealerUser_email_lower_case`; the duplicate unique index on
    `DealerCommissionLine.reversesLineId` dropped (the `(tenantId,
    reversesLineId)` one stays); the four dealer GET routes nothing called
    (`me`, `products`, `suppliers`, `commission`) removed; a run's unique
    conflict is named by its index; a document request answered concurrently
    is a typed 409.
39. **A dealer's borrower carries its address** (browser acceptance): booking
    refuses a borrower without one (the tax invoice) and the address is fixed
    at approval, so the dealer captures it with a business or a sole
    proprietor (street line and city required; a person of a business needs
    none), and the staff accept refuses a borrower without one (422).

Review rounds 2 and 3 (migrations `20261019120400_dealer_booking_contacts_verified`,
`20261019120500_booking_contacts_verified_every_deal`):

40. **Booking needs verified contacts.** No deal, a dealer's or a staff one,
    moves into BOOKED while its sole proprietor or an active person of its
    entity was captured by a dealer and has unverified contact details
    (`AssetFinanceDeal_dealer_contacts_verified`); booking's load step refuses
    first (`dealer_contact_unverified`). Staff verify from any deal the person
    is on (a "Contacts a dealer captured" panel on a staff deal). Before
    booking, nothing goes to an unverified dealer-typed contact: the portal
    register/forgot/reset routes, the selfie, PASQ and agreement links, the
    agreement and signing-packet emails, application status emails and event
    notifications (`triggerNotification`) skip or refuse it, and an entity's
    servicing recipients exclude it, and the website's identity-conflict
    notice is withheld. No Loan, consumer or asset-finance, is created for
    such a client (`Loan_dealer_contact_verified`, migration
    `20261019120700`; the consumer disburse route answers 409 first), so
    loan-scoped sends (reminders, Section 129, collections) need no check; staff-chosen conversation
    sends (CRM WhatsApp, inbox, AI agent) go to a Contact's identity, which a
    dealer capture never creates. A person with unverified dealer-typed contacts joins a
    business only while it has no deal beyond that dealer's own unsubmitted
    draft (`EntityRelationship_dealer_contact_link`; the dealer's capture
    answers 409). Migration `20261019120600` holds that trigger and a partial
    index serving these checks. The on-book refusal audit names the dealer user as its row
    (entity `DealerUser`).

### Data (prisma/schema/asset-finance-dealers.prisma, new file)

Two migrations: `20261019120000_dealer_portal_enum_values` (only
`ALTER TYPE "EntityDocumentType" ADD VALUE 'POPIA_CONSENT'`: a new enum value
cannot be used in the transaction that adds it) and `20261019120100_dealer_portal`
(everything else). All new tables are tenant-scoped like slice 4: `tenantId`,
`@@unique([tenantId, id])`, composite FKs `(tenantId, x)`, listed in
`lib/registry/tenant-scoped-models/240-dealer-portal.ts`, RLS policy
`tenant_isolation` as in `20261015130000_tenant_rls_new_scoped_models`. Every
guard trigger has a `_no_truncate` statement trigger. Errors
`RAISE EXCEPTION USING ERRCODE = '23514'`. Today =
`(now() AT TIME ZONE 'Africa/Johannesburg')::date`.

```prisma
enum DealerKind { DEALER BROKER }
enum DealerRole { DEALER_ADMIN DEALER_SALES }
enum DealerCommissionLineKind { EARNED REVERSED }
enum DealerCommissionReversalReason { LOAN_SETTLED_EARLY LOAN_WRITTEN_OFF LOAN_CANCELLED }
enum DealerCommissionRateSource { DEALER TENANT_DEFAULT NONE }
enum DealerPayableRunStatus { PENDING_APPROVAL APPROVED RELEASED CANCELLED }
enum DealerBankAccountStatus { PENDING APPROVED REJECTED SUPERSEDED }

model Dealer {            // name, kind, registrationNumber?, vatNumber?, vatVendor Boolean @default(false),
                          // supplierId? (→ Supplier, @@unique([tenantId, supplierId])), contactEmail, contactPhone?,
                          // active @default(true), deactivatedAt?, deactivatedById? (→ User), createdById (→ User),
                          // createdAt, updatedAt; @@unique([tenantId, name])
}
model DealerUser {        // dealerId, email (lower-cased), name, role DealerRole, passwordHash String?,
                          // setPasswordTokenHash String? @unique, setPasswordTokenExp DateTime?, active @default(true),
                          // tokenVersion Int @default(0), lastLoginAt?, createdByUserId? (→ User),
                          // createdByDealerUserId? (→ DealerUser), createdAt, updatedAt; @@unique([tenantId, email])
}
model DealerCommissionRate { // dealerId? (NULL = tenant default), effectiveFrom @db.Date, bps Int, flatCents Int,
                             // createdById (→ User), createdAt
}
model DealerCommissionLine { // dealerId, dealId, loanId, kind, reversesLineId? @unique, reason?, effectiveOn @db.Date,
                             // baseCents, bps, flatCents, netCents, vatRate Decimal(6,4), vatCents, grossCents,
                             // dealerVatVendor Boolean, clawbackMonths Int, createdAt
}
model DealerPayableRun {  // dealerId, periodEnd @db.Date, bankAccountId (→ DealerBankAccount), status,
                          // totalNetCents, totalVatCents, totalGrossCents, createdById, approvedById?, approvedAt?,
                          // releasedById?, releasedAt?, releaseReference?, cancelledById?, cancelledAt?, createdAt
                          // (all *ById → User)
}
model DealerPayableRunLine { runId, lineId, voided Boolean @default(false), createdAt }
model DealerBankAccount { // field-for-field SupplierBankAccount with dealerId; requestedById/decidedById → User
}
model DealerConsentAttestation { // dealId, clientId (the data subject), documentId (→ EntityDocument),
                                 // dealerUserId, statementVersion, statementText, attestedAt,
                                 // verifiedById? (→ User), verifiedAt?
}
model DealerDocumentRequest { // dealId, docType EntityDocumentType, note (≤500), requestedById (→ User), requestedAt,
                              // fulfilledDocumentId? (→ EntityDocument), fulfilledAt?
}
```

Additive columns:

- `TenantConfig`: `featureDealerPortal Boolean @default(false)`,
  `dealerCommissionClawbackMonths Int @default(0)` (tenancy.prisma).
- `AssetFinanceDeal`: `dealerId?`, `dealerUserId?`, `dealerSubmittedAt?`,
  `dealerCommissionSource DealerCommissionRateSource?`,
  `dealerCommissionRateId?`, `dealerCommissionBps Int?`,
  `dealerCommissionFlatCents Int?`, `dealerCommissionBaseCents Int?`,
  `dealerCommissionSnapshotAt DateTime?` (FKs `(tenantId, dealerId)`,
  `(tenantId, dealerUserId)`; index `(tenantId, dealerId, status)`).
- `BusinessEntity`, `Client`, `FinancedAsset`: `createdByDealerId?` (FK → Dealer).
- `EntityDocument.uploadedByType` gains the value `'dealer'` (text, no DDL);
  `uploadedById` = the DealerUser id.

Back-relations alphabetical (`prisma/schema-order.test.ts`).

#### CHECKs

- `TenantConfig_dealer_portal_demo_only`: `NOT "featureDealerPortal" OR "isDemoLender"`.
  `isDemoLender` is a plain column on the same row, so a CHECK suffices; it
  also refuses clearing `isDemoLender` while the portal is on. Dealer 2FA's PR
  replaces this constraint.
- `TenantConfig_dealer_clawback_months_range`: `BETWEEN 0 AND 60`.
- `Dealer_vat_vendor_shape`: `"vatVendor" = ("vatNumber" IS NOT NULL)`.
- `DealerUser_creator_xor`: exactly one of `createdByUserId`, `createdByDealerUserId`.
- `DealerCommissionRate_bounds`: `bps BETWEEN 0 AND 1000 AND "flatCents" BETWEEN 0 AND 10000000`
  (a 10 % / R100k sanity ceiling; changed only by migration).
- Unique `(tenantId, dealerId, effectiveFrom)`; partial unique
  `(tenantId, effectiveFrom) WHERE "dealerId" IS NULL`.
- `AssetFinanceDeal_dealer_pair`: `("dealerId" IS NULL) = ("dealerUserId" IS NULL)`;
  `dealerUserId IS NULL OR "createdById" = "dealerUserId"`;
  `"dealerSubmittedAt" IS NULL OR "dealerId" IS NOT NULL`.
- `AssetFinanceDeal_dealer_snapshot_shape`: the six snapshot columns all NULL or
  all set; set only when `dealerId` is set.
- `DealerCommissionLine_shape`: EARNED: `reversesLineId`, `reason` NULL,
  `netCents > 0`; REVERSED: both set, `netCents < 0`;
  `"grossCents" = "netCents" + "vatCents"`; `"vatCents" = 0` unless
  `dealerVatVendor`. Partial unique `(tenantId, dealId) WHERE kind = 'EARNED'`.
- `DealerPayableRun_status_shape` (as `Payout_status_shape`, plus CANCELLED
  needing `cancelledById/At`), `DealerPayableRun_four_eyes`:
  `"approvedById" IS NULL OR "approvedById" <> "createdById"`,
  `DealerPayableRun_totals`: `gross = net + vat AND gross > 0`. Partial unique
  `(tenantId, dealerId, periodEnd) WHERE status <> 'CANCELLED'`.
- `DealerPayableRunLine`: partial unique `(tenantId, "lineId") WHERE NOT voided`
  (one live run per line).
- `DealerBankAccount_four_eyes`, `_decision_complete`, `_approval_evidence`,
  partial unique `_one_approved_per_dealer` — copies of the supplier ones.

#### Triggers and functions

- `dealerCommissionRateAt(tenant, dealer, on date)` → `(id, source, bps, flatCents)`:
  the dealer's row with greatest `effectiveFrom ≤ on`, else the tenant default
  row, else `(NULL, 'NONE', 0, 0)`.
- `guardDealerCommissionRate`: INSERT any date; UPDATE refused; DELETE only
  while `effectiveFrom > today`.
- `guardDealer` / `guardDealerUser`: tenant, dealer, `createdBy*` immutable;
  DELETE refused. `tokenVersion` may only increase.
- `guardAssetDealDealer` (BEFORE INSERT OR UPDATE ON "AssetFinanceDeal"):
  - INSERT with `dealerId`: dealer active and the tenant's; dealer user active
    and the dealer's; the tenant's `featureDealerPortal` true; the borrower
    (`entityId` or `clientId`) and `assetId` carry `createdByDealerId = dealerId`.
  - `dealerId`, `dealerUserId` immutable after insert.
  - `dealerSubmittedAt`: set once, only while status DRAFT.
  - Snapshot: on the transition into APPROVED with `dealerId` set, the trigger
    SETS the six columns: rate from `dealerCommissionRateAt(tenant, dealer,
    today)`, base the goods advance (deviation 29). Any other change to them is refused
    (including a caller passing values on the transition that differ).
- `accrueDealerCommission` (AFTER INSERT OR UPDATE OF status ON
  "AssetFinanceDeal"): when `NEW.status = 'BOOKED'` (and OLD was not) and
  `dealerId` set and `round(base × bps / 10000) + flat > 0`, inserts the EARNED
  line: `effectiveOn` today, `loanId = NEW.loanId`, `dealerVatVendor` from the
  dealer now, `vatRate` from `VatRate` in force today, `vatCents =
  round(net × vatRate)` if vendor else 0, `clawbackMonths` from TenantConfig
  now. Both booking paths (`booking.ts`, `lease-booking.ts`) set BOOKED with
  `loanId` in one UPDATE, so this covers them and any future path.
- `guardDealerCommissionLine` (BEFORE INSERT; UPDATE/DELETE/TRUNCATE refused):
  recomputes every amount column and refuses a mismatch. EARNED: deal BOOKED,
  `dealerId`/`loanId` the deal's. REVERSED: `reversesLineId` names the same
  deal's EARNED line, amounts are its exact negatives (`vatRate`, vendor flag,
  `clawbackMonths` copied), the loan's status is COMPLETED / WRITTEN_OFF /
  CANCELLED and the window rule below holds.
- `clawbackDealerCommission` (AFTER UPDATE OF status ON "Loan"): when the loan
  moves into COMPLETED, WRITTEN_OFF or CANCELLED from any other status and has
  an unreversed EARNED line, inserts the REVERSED line if:
  `CANCELLED` (reason LOAN_CANCELLED), or `clawbackMonths > 0 AND today <
  earned.effectiveOn + clawbackMonths months AND` (`WRITTEN_OFF`, or
  `COMPLETED AND today < maturityDate::date` → LOAN_SETTLED_EARLY).
  A loan reopened COMPLETED → ACTIVE (`lease-charges.ts`) keeps its reversal
  (known limitation; staff cannot edit lines).
- `guardDealerPayableRun`:
  - INSERT: status PENDING_APPROVAL, `periodEnd ≤ today`, the bank account is
    the dealer's and APPROVED.
  - PENDING_APPROVAL → APPROVED: ≥ 1 live link; totals equal the sums of the
    live links' lines; bank account still APPROVED; four-eyes by CHECK.
  - APPROVED → RELEASED: bank account still APPROVED (a superseded or rejected
    account refuses; cancel and recreate).
  - PENDING_APPROVAL | APPROVED → CANCELLED. RELEASED and CANCELLED immutable.
    `dealerId`, `periodEnd`, `bankAccountId`, totals, `createdById` fixed.
    DELETE refused.
  - AFTER UPDATE to CANCELLED: sets `voided = true` on its links.
- `guardDealerPayableRunLine`: INSERT only while the run is PENDING_APPROVAL;
  line same tenant and dealer, `effectiveOn ≤ periodEnd`. UPDATE only
  `voided false → true` while the run is CANCELLED. DELETE refused.
- `guardDealerBankAccount`: copy of `guardSupplierBankAccount`.
- `guardDealerConsentAttestation`: document is the same deal's, docType
  POPIA_CONSENT, `uploadedByType = 'dealer'`, not deleted; the subject is the
  deal's client or an active `EntityRelationship` client of its entity; the
  attesting dealer user belongs to the deal's dealer. Only
  `verifiedById/verifiedAt` may be set, once. DELETE refused.
- `guardDealerDocumentRequest`: `fulfilledDocumentId/At` set once, document of
  the same deal; nothing else changes. DELETE refused.

### Principal and hosts

- **Host.** New env `DEALER_APP_HOST` (`lib/config/deployment-urls.ts`
  `dealerAppHost()`; throws `DeploymentConfigError` if equal to the staff or
  operator host). Unset ⇒ no dealer sign-in anywhere and `/dealer*` 404s, as
  `OPERATOR_APP_HOST`. The host needs a `TENANT_HOST_MAP` entry (the subdomain
  fallback would read `acme-dealer` as the slug). Runs on the staff container.
- **`lib/proxy/dealer-host.ts`** (model: `operator-host.ts`):
  `dealerHostGate(req, session, forward, appMode)` — `appMode === "client"` →
  404; no tenant slug → 404; serves `/dealer`, `/dealer/*`, `/api/dealer/*`,
  NextAuth endpoints; public: `/dealer/login`, `/dealer/set-password`,
  `/api/dealer/set-password`; anything else 404; a `next-action` header → 403
  (the portal has no server actions); no session → `/dealer/login` or 401; a
  session whose role is not `DEALER` → 404. `dealerOffHostRefusal(path, role)`
  — off the host, dealer paths 404 and a `DEALER` session is refused except
  NextAuth endpoints. `proxy.ts` calls both right after the operator checks,
  using `buildTenantHeaders(req, resolveTenantSlug(req))`.
- **Session claims** (`lib/auth-config.ts`): `AppRole` gains `"DEALER"` (not a
  `UserRole`, so `hasMinRole`/`canDo`/`requireApiRole` refuse it by
  construction: `ROLE_HIERARCHY.indexOf` is −1). New claims `dealerId`,
  `dealerRole` (`DEALER_ADMIN | DEALER_SALES`). `roleRefusedOnThisHost`: an
  explicit `role === "DEALER" && mode === "client"` → refused (already true;
  made explicit and tested).
- **Sign-in** (`lib/dealer/sign-in.ts` `authorizeDealer`, called from
  `authorize()` like `authorizeOperator`): `loginType "dealer"` accepted only
  on the dealer host, every other loginType refused there (one more clause in
  the existing host check). Order: rate buckets (existing) → tenant from host
  (`getTenantFromRequest`) → `withoutTenantScope` lookup of
  `DealerUser (tenantId, email)` → bcrypt always (`equalizeAuthTiming` when no
  row) → `dealerPrincipalRefusal` (user inactive, no password set, dealer
  inactive, tenant SUSPENDED, portal not enabled = `featureAssetFinance &&
  featureDealerPortal && isDemoLender`) → `dealerSecondFactor(user, code)`
  (the TOTP seam: returns `{kind:"not_enrolled"}` today; dealer 2FA fills it)
  → `lastLoginAt`, audit `DEALER_SIGNED_IN`. Failures: `FailedLoginAttempt`
  reasons `dealer_wrong_password | dealer_inactive | dealer_portal_off`.
- **Revalidation** (`lib/dealer/principal.ts` `revalidateDealerPrincipal`): in
  the `jwt` callback a `DEALER` branch runs BEFORE the staff branch (else
  `revalidatePrincipal` finds no `User` and signs out). Same refusal set as
  sign-in plus `tokenVersion` equality; `"error"` keeps a tenant-bound token
  like staff. Picks up `dealerRole` changes.
- **Revocation.** Deactivating a user bumps its `tokenVersion`; deactivating a
  dealer sets `active=false` and bumps every user's `tokenVersion` in the same
  transaction; turning the flag off ends all sessions on the next request.
- **Guard** `requireDealer(req, opts?: { admin?: true })` (`lib/dealer/guards.ts`):
  session role `DEALER`, `tenantId` equal to the host tenant
  (`withTenantContext`), portal enabled, role check for admin routes. Every
  refusal for a valid dealer session is 404 (cross-tenant included); no
  session 401.
- **Passwords.** Creating a dealer user (staff or DEALER_ADMIN) returns a
  one-time set-password link (token 32 bytes, stored as sha256, 72 h). The UI
  shows it to the creator to pass on; nothing is emailed in this slice. Staff
  can issue a fresh link (`reset-link`), which also bumps `tokenVersion`.

### Dealer deal flow (`lib/dealer/`, every write through existing deal code)

- **Actor.** `DealerActor { tenantId, dealerId, dealerUserId, email }`.
  `dealerAuditFields(actor)` → `{ userId: undefined, userEmail: email }` plus
  `newValue.actor = { type: "dealer", dealerId, dealerUserId }` (the
  `actorType: "client"` precedent in `lib/compliance/pasq-acknowledgement.server.ts`;
  `AuditLog.userId` is a `User` FK, so no AuditLog DDL).
- **Extract, don't fork.** The inline staff logic moves into lib functions the
  staff routes then call unchanged in behaviour: entity create →
  `lib/asset-finance/entity-create.ts`; asset create →
  `lib/asset-finance/asset-create.ts`. Both take
  `actor: { kind: "staff"; … } | { kind: "dealer"; … }` and set
  `createdByDealerId` for a dealer. A dealer person = a minimal `Client`
  (idNumber validated by `isValidSaIdNumber`, names, email, phone; flag
  `createdByDealerId`) linked through the existing `parseRelationshipInput` /
  `relationshipRowValues` (`lib/dealer/capture.ts`).
- **`createDeal`** gains `dealer?: { dealerId, dealerUserId, email }`: when set,
  `createdById = ncaClassifiedById = dealerUserId` (plain text columns, no FK),
  `dealerId/dealerUserId` written, audit through `dealerAuditFields`. Nothing
  else in it changes. Supplier: the lender's active suppliers (`id, name` only),
  defaulting to `Dealer.supplierId`. Products: the lender's active
  asset-finance products. Structure preview: the existing preview lib.
- **Documents.** `EntityDocumentUploader.type` and `serveEntityDocument`'s
  accessor gain `"dealer"` (`DocumentAccessLog.accessorType = 'dealer'`).
  `DEALER_UPLOAD_DOC_TYPES`: CIPC_REGISTRATION, TRUST_DEED,
  LETTERS_OF_AUTHORITY, RESOLUTION, AFS, MANAGEMENT_ACCOUNTS, BANK_STATEMENT,
  SUPPLIER_INVOICE, NATIS_DOCUMENT, INSURANCE_NOTING, POPIA_CONSENT, OTHER, via
  `storeDealEvidenceDocument`. A dealer reads only documents its own users
  uploaded on its own deals; every read logged.
- **Consent.** `attestDealerConsent`: an uploaded POPIA_CONSENT document + a
  `DealerConsentAttestation` per subject with the fixed statement
  (`DEALER_CONSENT_STATEMENT`, version `dealer-consent-v1`, snapshot text).
  Staff `verifyDealerConsent` sets `verifiedById/At`, marks the document
  verified, and applies `computeConsentTransition` (creditBureauEnquiry=true,
  reason `Dealer consent <id> verified`) in one transaction.
- **Submit** (`submitDealerDeal`, dealer): deal DRAFT and the dealer's; every
  subject (sole-prop client, or each active relationship person) has an
  attestation; at least one document; sets `dealerSubmittedAt`; audit
  `DEALER_DEAL_SUBMITTED`. **Accept** (staff, `manage_asset_finance`): requires
  `dealerSubmittedAt`, calls `submitDeal(tx, staffActor, dealId)`; audit
  `DEALER_SUBMISSION_ACCEPTED`. From here the staff flow is unchanged.
- **Document requests.** Staff `POST …/document-requests`; the dealer fulfils by
  uploading with `requestId`. The note is shown to the dealer (UI warns: no
  credit reasons).
- **Dealer projection** (`lib/dealer/deal-view.ts`, a whitelist `select`):
  reference, createdAt, dealerSubmittedAt, borrower display name, asset
  (make, model, year, serial), contractType, financed amount (applied), base
  instalment, dealer status (DRAFT→Draft; DRAFT+submitted, SUBMITTED,
  REFERRED→In review; APPROVED→Approved; CONTRACTED→Signed; BOOKED→Booked;
  DECLINED, REFUSED_NCA→Declined; CANCELLED→Cancelled), missing items
  (before CONTRACTED: absent consents/doc types; after: unconfirmed checklist
  kinds), document requests, own documents, signing progress (document kind,
  signer role, signed yes/no), booking (date, loan reference), its commission
  lines. Never: decision, decisionReasons, approvalExceptions, financials,
  affordability, bureau/screening, NCA regime/rule/override, payout, other
  dealers' rows. Lists filter `{ tenantId, dealerId }`; a miss is 404.

### Commission, runs and journals

- Accrual and clawback are the DB functions above (no TS writer, no TS
  mirror: the accrual and edge IT suites compute the expected figures).
- **Rates** (staff `manage_dealers`): insert a dealer or tenant-default row;
  audited `DEALER_COMMISSION_RATE_SET`. Settings PATCH
  (`app/api/settings/asset-finance`) gains `featureDealerPortal` and
  `dealerCommissionClawbackMonths`; a 23514 from the demo-only CHECK → 422
  "The dealer portal can be switched on only for a demo lender until dealer
  two-factor sign-in ships"; audited `DEALER_PORTAL_ENABLED/DISABLED`,
  `DEALER_CLAWBACK_MONTHS_CHANGED`.
- **Runs** (`lib/dealer/payable-runs.ts`): create (`manage_dealers`) takes
  every unlinked line of the dealer with `effectiveOn ≤ periodEnd` (a month
  end), refuses a net ≤ 0 (lines wait); approve / release / cancel
  (`decide_asset_finance`), each locking the run row, audited. Release records
  `releaseReference` (the lender's own EFT reference); no bank rail.
- **VAT.** Commission is computed ex VAT; a VAT-vendor dealer adds VAT at the
  rate in force on the line date (snapshot `dealerVatVendor` on the line).
  // UNTESTED: tax — whether commission for arranging credit is a taxable
  supply, and how much input VAT a lender making exempt supplies may claim
  (apportionment). **Tax reviewer confirms.**
- **Roles** appended to `ACCOUNT_ROLES` after `AF_PRICE_CREDITS`:
  `DEALER_COMMISSION_EXPENSE` (6500, "Dealer commission"),
  `DEALER_COMMISSION_PAYABLE` (2600, "Dealer commission payable");
  `DEALER_COMMISSION_EXPENSE` joins `NOT_CARRIED_AT_OPENING`. Being after
  `AF_INSTALMENT_DEBTORS`, both fall in `ASSET_FINANCE_ROLES`, so a tenant
  re-confirms its mapping before a month posting them closes.
- **Sources** (`lib/accounting/sources-dealer-commission.ts`, dispatched from
  `assetFinanceSources`; `SourceAssetFinance.dealerCommission` loaded in
  `store-asset-finance.ts`). Per line, signed:
  `af:<loan>:dealer-commission:<lineId>` on `effectiveOn` (SAST midnight):
  Dr EXPENSE net, Dr INPUT_VAT vat, Cr PAYABLE gross (event
  `DEALER_COMMISSION`); `af:<loan>:dealer-commission-paid:<lineId>` on the
  run's `releasedAt`: Dr PAYABLE gross, Cr BANK gross (event
  `DEALER_COMMISSION_PAID`).
- **Reconciliation** (`reconcile-controls.ts`): new control
  `DEALER_COMMISSION_PAYABLE` per loan = −Σ gross of lines effective before
  `asOf` + Σ gross of those lines in runs released before `asOf`, in SQL; the
  `AF_INPUT_VAT` book adds the lines' `vatCents`.
- **IsaFlow.** No push code changes: closed-month lines carry the mapped codes.
  A test proves a month with commission lines builds a draft with both codes
  and the chart check demands them.

### NCA cost of credit untouched

Commission is never a borrower charge. The borrower figures come from
`solveWithRate` / `solveNcaDealStructure` (`deal-structure.ts`,
`nca-structure.ts`), `assetCalculatorEvidence` / `createAssetPasqEvidence`
(`nca-evidence.ts`), `calculatePasqTotalCostOfCreditCents`
(`lib/compliance/pasq.ts`) and `planBooking` (`booking-plan.ts`); none may
import `lib/dealer/*` or read a `dealerCommission*` column.
`lib/dealer/cost-of-credit.integration.test.ts` books the same NCA
sole-proprietor deal twice (dealer with bps 250 + flat R1,500, and staff) and
asserts identical PASQ evidence (`totalCostOfCreditCents`,
`totalRepayableCents`, schedule), `Loan` figures and schedule rows;
`lib/dealer/no-borrower-charge.test.ts` checks the import graph and column
reads. Legal reviewer confirms (§2a.5).

### Routes

Dealer (`app/(dealer)/dealer/…`, `app/api/dealer/…`, guard `requireDealer`):
pages `login`, `set-password`, `/dealer` (deals), `deals/new`, `deals/[id]`,
`users` (admin), `commission` (lines + runs, own dealer; read server-side, as
the profile, products and suppliers are). API: `set-password` POST (public,
token); `users` GET/POST, `users/[id]/deactivate` POST (admin; not self);
`borrowers/entities` POST, `borrowers/entities/[id]/people` POST,
`borrowers/clients` POST; `assets` POST; `deals` GET/POST; `deals/preview`
POST; `deals/[id]` GET; `deals/[id]/documents` GET/POST,
`deals/[id]/documents/[docId]` GET; `deals/[id]/consents` POST;
`deals/[id]/submit` POST.

Staff (`app/api/asset-finance/…`, house pattern `requireApiRole` →
`withTenantContext` → `requireAssetFinanceEnabled` → `canDo`): `dealers`
GET/POST; `dealers/[id]` GET/PATCH (deactivate); `dealers/[id]/users` POST;
`dealers/[id]/users/[userId]/deactivate|reset-link` POST; `dealers/[id]/rates`
POST; `dealer-commission/default-rate` POST; `dealers/[id]/bank-accounts` POST;
`dealers/bank-accounts/[accountId]/decide` POST; `dealers/[id]/runs` POST;
`dealer-runs/[runId]` GET, `…/approve|release|cancel` POST;
`deals/[id]/dealer-submission/accept` POST;
`deals/[id]/dealer-consents/[attestationId]/verify` POST;
`deals/[id]/dealer-people/[clientId]/verify-contact` POST;
`deals/[id]/document-requests` POST. Pages:
`(dashboard)/asset-finance/dealers` (list), `dealers/[id]` (users, rates,
bank accounts, lines, runs), `dealer-runs/[runId]` (statement), a Dealer
panel on the staff deal view (submission, consents, requests, snapshot).

Permissions (`lib/registry/permissions/060-dealer-portal.ts`):
`manage_dealers: "LOAN_ADMIN"`. Audit actions
(`lib/registry/audit-actions/420-dealer-portal.ts`): DEALER_CREATED,
DEALER_UPDATED, DEALER_DEACTIVATED, DEALER_USER_CREATED,
DEALER_USER_DEACTIVATED, DEALER_USER_PASSWORD_LINK_ISSUED,
DEALER_USER_PASSWORD_SET, DEALER_SIGNED_IN, DEALER_COMMISSION_RATE_SET,
DEALER_PORTAL_ENABLED, DEALER_PORTAL_DISABLED, DEALER_CLAWBACK_MONTHS_CHANGED,
DEALER_DEAL_SUBMITTED, DEALER_SUBMISSION_ACCEPTED, DEALER_CONSENT_ATTESTED,
DEALER_CONSENT_VERIFIED, DEALER_DOCUMENT_REQUESTED,
DEALER_BANK_ACCOUNT_REQUESTED, DEALER_BANK_ACCOUNT_DECIDED,
DEALER_PAYABLE_RUN_CREATED, _APPROVED, _RELEASED, _CANCELLED; review round 1
adds DEALER_CONTACT_VERIFIED, DEALER_CAPTURE_REFUSED_ON_BOOK,
DEALER_BANK_ACCOUNT_DECISION_REFUSED, DEALER_PAYABLE_RUN_APPROVAL_REFUSED. No
cron.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_DEALER_IT` unless noted)

| Rule | Test file | Kind | Negative cases (§3 A) |
|---|---|---|---|
| Portal flag only on a demo lender | `lib/dealer/dealer-flag.integration.test.ts` | IT | flag on non-demo lender; clearing isDemoLender while on |
| Dealer host serves only dealer paths; others refuse dealers | `lib/proxy/dealer-host.test.ts` | unit | dealer → staff page/API, client portal; staff/client session → dealer paths; client-mode container |
| Audience at sign-in; claims; revalidation | `lib/dealer/sign-in.test.ts`, `lib/auth-dealer-jwt.test.ts` | unit | wrong loginType per host; staff token never revalidated as dealer and reverse |
| Staff guards refuse DEALER | `lib/dealer/staff-guards-refuse.test.ts` | unit | requireApiRole, requireMinRole, requireOwnerOrStaff, canDo |
| Deactivation / tokenVersion / flag off / suspended | `lib/dealer/dealer-principal.integration.test.ts` | IT | deactivated user; deactivated dealer; flag off mid-session |
| Cross-dealer and cross-tenant 404 | `lib/dealer/dealer-deal.integration.test.ts` | IT | dealer B reads/uploads/submits A's deal; other tenant's session |
| Provenance; dealerId immutable; audit actor | `lib/dealer/dealer-deal.integration.test.ts` | IT | staff-captured borrower/asset on a dealer deal; audit userId null |
| Projection never leaks | `lib/dealer/deal-view.test.ts` | unit | sentinels in memo, reasons, bureau, regime, payout |
| Submit → accept runs unchanged `submitDeal` | `lib/dealer/dealer-submit.integration.test.ts` | IT | submit without consent; accept without dealer submit |
| Consent attestation guard + verification | `lib/dealer/dealer-consent.integration.test.ts` | IT | non-dealer doc; subject not on deal |
| Snapshot at approval (history) | `lib/dealer/commission-accrual.integration.test.ts` | IT | caller-supplied snapshot refused |
| Earned at BOOKED; no commission when cancelled; immutable | `lib/dealer/commission-accrual.integration.test.ts` | IT | cancelled deal; manual EARNED on non-booked; UPDATE/DELETE/TRUNCATE |
| Clawback window | `lib/dealer/commission-clawback.integration.test.ts` | IT | inside window; outside; months 0; at maturity; double reversal; CANCELLED always |
| One run per line | `lib/dealer/payable-runs.integration.test.ts` | IT | a line in two runs; cancel frees it |
| Four-eyes run approval | same | IT | self-approval |
| Release only to APPROVED account | same | IT | pending, rejected, superseded account; release before approval |
| Dealer bank account four-eyes + evidence | `lib/dealer/dealer-bank-accounts.integration.test.ts` | IT | self-decision; details changed |
| Cost of credit unchanged | `lib/dealer/cost-of-credit.integration.test.ts`, `lib/dealer/no-borrower-charge.test.ts` | IT + unit | NCA deal with commission |
| Commission math (SQL) | `lib/dealer/commission-accrual.integration.test.ts`, `edge-commission.integration.test.ts` | IT | half-up rounding, vendor/non-vendor |
| Journals, control, IsaFlow | `lib/accounting/sources-dealer-commission.test.ts`, `lib/accounting/dealer-commission.integration.test.ts` (`RUN_ACCOUNTING_IT`) | unit + IT | payable mismatch detected; unmapped role refuses close |
| RLS on new models | existing `RUN_TENANT_ISOLATION_IT` catalog test | IT | — |
| Base = goods advance (29) | `lib/dealer/commission-accrual.integration.test.ts`, edge E15 | IT | fees on every fixture deal |
| No reversal reason to the dealer (30) | `lib/dealer/deal-view-loan-performance.test.ts`, `commission-statement.test.ts` | unit | written-off line |
| Lender-added people (31) | `lib/dealer/dealer-consent.integration.test.ts`, `dealer-submit.integration.test.ts`, `deal-view.test.ts` | IT + unit | attest a lender-added or other dealer's person |
| Classification re-stamp (32) | `lib/dealer/cost-of-credit.integration.test.ts` | IT | — |
| Hand-over; uploads after it (33) | `lib/dealer/dealer-handover-contact.integration.test.ts`, `documents.test.ts`, edge F04 (`edge-principal-flow`) | IT + unit | SUBMITTED before hand-over; free upload after it |
| Linking unverified dealer-typed people (40) | `lib/dealer/dealer-entity-people.integration.test.ts` | IT | own deal handed over, staff deal, another dealer's draft, re-activation, re-pointing |
| Untrusted dealer contacts (34, 40) | `lib/dealer/dealer-borrower-identity.integration.test.ts`, `dealer-handover-contact.integration.test.ts`, `lib/signing-otp/subject-dealer-contact.test.ts` | IT + unit | register, OTP, password, signing code, booking before verification |
| Row-shape CHECKs | `lib/dealer/dealer-row-shapes.integration.test.ts` | IT | each clause of `DealerCommissionLine_shape` and `DealerPayableRun_status_shape`, triggers off |
| Reset link (35) | `lib/dealer/dealer-reset-link.integration.test.ts` | IT | old password after reset; deactivated dealer |
| Refusal audits, capture limit (36) | `dealer-borrower-identity.integration.test.ts`, `capture-limits.test.ts`, `staff-routes.test.ts` | IT + unit | 31st capture; self-approval |
| Borrower address (39) | `lib/dealer/capture-address.test.ts`, `dealer-submit.integration.test.ts` | unit + IT | business or sole proprietor without one; accept without one |
| Portal switch on a demo lender | `lib/dealer/staff-admin.integration.test.ts` | IT | upsert's INSERT row met the demo-only CHECK |
| Tax invoice at release (37) | `lib/dealer/payable-runs.integration.test.ts`, `payable-run-actions.integration.test.ts` | IT | VAT run without invoice; half an invoice; invoice off RELEASED |

Mutation evidence (`evidence/slice5/MUTATIONS.md`): drop each CHECK and
trigger branch above, drop the `dealerId` filter in `deal-view.ts`, drop the
host-gate role check, invert the window comparison; each must turn a named
test red.

### Build task DAG (sequential; each file ≤ 300 lines)

1. **Failing DB suites first.** Write the IT files for flag, accrual,
   clawback, runs, bank accounts, consent (fixture
   `lib/dealer/dealer.integration-fixture.ts` on `deal.integration-fixture.ts`).
   verify: they fail against a migrated IT DB.
2. **Schema + migrations + registries.** New schema file, columns, both
   migrations, tenant-scoped/permission/audit registries,
   `npm run gen:registries`. verify: `npx prisma migrate deploy` on
   `it-db.sh`, step-1 suites green, `npx tsc --noEmit`, registry snapshot tests.
3. **Principal.** auth-config types, `dealerAppHost`, `lib/dealer/{sign-in,principal,guards}.ts`,
   `lib/proxy/dealer-host.ts`, wiring in `lib/auth.ts` and `proxy.ts` (a few
   lines each; both files are already over 300). verify: the unit tests in the
   matrix + principal IT.
4. **Origination plumbing.** Extract entity/asset create; `createDeal`
   `dealer` param; uploader/accessor `"dealer"`. verify: existing
   `app/api/asset-finance/**` and `lib/asset-finance/deal-*` tests unchanged and
   green; dealer-deal IT.
5. **Dealer domain lib.** capture, consent, submit/accept, document requests,
   projection, users and password links. verify: dealer-submit, consent IT,
   deal-view unit.
6. **Dealer API + pages** (`app/api/dealer`, `app/(dealer)`). verify: route
   tests (404s, admin-only), `npm run lint`.
7. **Staff admin.** Dealers, users, rates, bank accounts, runs, settings
   fields, deal-view Dealer panel. verify: runs IT, route tests.
8. **Accounting.** Roles, defaults, sources, store, control, EventTypes.
   verify: `npx vitest run lib/accounting`, `RUN_ACCOUNTING_IT` suites.
9. **Cost of credit + seed.** The cost-of-credit IT and import test; seed two
   synthetic dealers (users, rates, approved bank account) on the demo tenant,
   idempotent. verify: IT green, `npx prisma migrate reset` twice.
10. **Docs.** `lib/dealer/.claude.md`, `lib/asset-finance/.claude.md`,
    ARCHITECTURE.md (dealer principal next to the operator one), DEPLOY-ENV.md
    (`DEALER_APP_HOST`), DESIGN.md slice 5 status; `npm run agents:mirror`.
    verify: `npm run claude-md:check && npm run agents:check`.
11. **Gates.** `npm run ci:full` in a fresh clone; mutations; browser
    acceptance (§5 A) with screenshots in `evidence/slice5/browser/A/`.

### Known limitations

Recorded by review round 1; each is a decision to keep, not an open bug.

- **One lender per dealer host.** `DEALER_APP_HOST` resolves to one tenant
  (`TENANT_HOST_MAP`), which matches one instance and database per lender.
  A shared multi-lender instance needs a dealer host per lender.
- **A reopened loan keeps its reversal.** A loan reopened COMPLETED → ACTIVE
  (`lease-charges.ts`) keeps the REVERSED line; staff cannot edit lines.
- **A dealer's debit balance has no settlement path.** Clawbacks larger than
  the commission due wait in later runs (a run never nets to zero or less);
  recovering a balance the dealer will never earn back is off-system.
- **Rates have no maker-checker.** One `manage_dealers` user sets a dealer or
  default rate (audited, date-effective, bounded by a CHECK). Four-eyes on
  rates is a later change.
- **Owed commission survives deactivation.** A deactivated dealer's earned
  lines stay payable: an open run is approved and released, and a new run can
  be created for it.
- **The capture 409 is still an existence oracle** (deviation 9, by design: a
  dealer must learn the borrower is already the lender's). It is audited per
  refusal and rate limited per dealer user; the limiter is in memory, per
  instance, like the sign-in buckets.
- **A dealer lease keeps the dealer user as classifier.** A lease application
  is written NON_NCA (`LEASE_NOT_CREDIT_AGREEMENT`, fixed by contract type) and
  the database freezes a NON_NCA snapshot, so the accept cannot re-stamp it.
- **Verification is enforced at booking, not at CONTRACTED.** A deal is not
  booked while a person on it has unverified dealer-typed contacts
  (deviation 40); a wet-ink contract can still complete before the
  verification (the signing paths would need their own refusal).
- **Servicing messages skip unverified dealer-typed people.** No one with
  unverified dealer-typed contacts joins a business with a live deal beyond
  the dealer's own draft, and an entity's servicing messages (reminders,
  notifications, rate notices) go only to people whose dealer-typed contacts
  staff verified. The link check reads committed deals: a deal created in a
  transaction still open while the link is made is not seen (READ
  COMMITTED); the servicing filter still applies to that person.
- **A run covers a finished period.** `periodEnd` is a month end not after
  today, so commission earned this month, and a clawback netting it, is paid
  in next month's run at the earliest.

### Review items

- **Legal:** dealer/broker as intermediary and the lender's POPIA operator
  agreement with it; the consent statement text; commission not part of cost
  of credit; dealers seeing decline (never reasons).
- **Tax:** commission VAT by vendor status; input VAT apportionment;
  reversal on clawback.

Lender legal sign-off (SA legal review, PR #216), before a lender switches
the portal on:

1. Dealer agreement: POPIA s20/s21 operator terms for data the dealer collects
   for the lender, plus NCA s68 confidentiality; states the dealer is a
   separate responsible party for its own sale data. Follow-up: record the
   operator-agreement version/date on the Dealer before activation.
2. The signed POPIA consent form the dealer uploads: the system accepts any
   PDF typed POPIA_CONSENT. The form must carry the s18 notification (lender
   as responsible party, purposes, bureau enquiry, that the dealer learns the
   application outcome and commission status of the account).
3. DEALER_CONSENT_STATEMENT text (lib/dealer/consent.ts, UNTESTED: legal)
   asserts signature "in my presence" and an ID check; confirm it matches the
   lender's actual dealer process (remote signing would make it false).
4. Whether to disclose dealer commission to the consumer. No express NCA/CPA
   rule known for commission paid from the lender's own funds (s92/Form 20
   silent; FAIS only if the dealer intermediates insurance). LOW confidence:
   counsel to confirm against current NCR / Credit Ombud guidance on dealer
   incentives (UK motor-finance precedent).
5. Dealer pricing discretion (rate/fees proposed per deal): consistency with
   the lender's pricing policy and NCA s61/s13 unfair-discrimination exposure.
   Commission must never depend on rate or fees.
6. Retention: dealer-captured Clients and documents on abandoned/declined
   drafts (dealer cannot cancel drafts): set a POPIA s14 retention period;
   DSAR responses name the dealer as source and recipient (s23(1)(b)).
7. VAT treatment of commission (see tax items).

Lender tax sign-off (SA tax/accounting review, PR #216):

a) Commission from a VAT-vendor dealer is standard-rated (s2(2) fee/commission
   carve-out from financial services); a non-vendor charges none.
b) s17(1) apportionment of input VAT on commission for instalment-sale /
   finance-lease contracts (taxable goods + exempt finance charges) versus the
   100% claim the system posts; who adjusts and where (VAT201).
c) Tax invoice basis for the s16(2) claim: the dealer's own s20 tax invoice
   per run (reference captured at release) or a SARS-approved recipient-
   created tax invoice.
d) Clawback: the dealer's s21 credit note and the period of the input VAT
   reversal (s21(4)); netted runs need dealer credit notes.
e) VAT rate and vendor status are fixed at booking, not at time of supply
   (s9(1)); per-line rounding may differ by cents from a dealer invoice on the
   run total.
f) Accounting policy: commission expensed at booking (management-accounts
   basis) versus IFRS 9 EIR transaction cost / IFRS 16 initial direct cost
   deferral; auditor and FD confirm the basis and any year-end adjustment.
g) Income tax: commission deductible under s11(a) when incurred; adviser to
   confirm whether a clawback is an s8(4)(a) recoupment or a reduction of the
   deduction in the clawback year.

- **Open risks:** `isDemoLender` has no DB guard of its own (set only by the
  seed and demo scripts; provisioning refuses it), so the demo-only CHECK is as
  strong as that control. Rate limiting is in-memory (single replica). Dozens
  of call sites treat any non-CLIENT role as staff; the dealer host gate is
  the boundary, backed by the guard census. A reopened lease keeps its
  clawback. Dealer drafts cannot be edited or cancelled by the dealer (staff
  cancel).

## Part B — Tracker/telematics adapter and simulator

Goal §2a items 8–12, §3 PR B negative cases, §5 B acceptance. Names below were
re-checked against the `CredaFlow-s5b` worktree (PR A #216 with main 0d29dddc)
on 2026-10-20 and corrected where the code differs; "Built" at the end lists
what changed while building.

### Deviations from the goal's defaults (and why)

1. **Coordinates live in their own table, `TelematicsPosition`.** Events
   (`TelematicsEvent`) carry no coordinates and no raw payload. The purge
   deletes position rows (plus HEARTBEAT/IGNITION/POSITION events) past
   retention, while METER and ALERT events stay because meter readings,
   held readings and alerts refer to them. No other copy of a coordinate
   exists, so retention is one DELETE.
2. **A position is never server-rendered.** The only read path is
   `POST /api/asset-finance/loans/[loanId]/telematics/position`
   (`lib/telematics/position-view.ts`). It writes the access-log row first and
   returns the position second, in one transaction. Pages show a "Show last
   known position" button. Because the access is an explicit act, "every view
   logged" holds by construction, and a READONLY page load can never
   materialise a coordinate. A static test allows only three modules to select
   the coordinate columns: the ingest writer, the purge and `position-view.ts`.
3. **Purpose and tenure gates (POPIA minimality).** The position is shown only
   for a purpose the loan has *now*, named by the request's context: DEFAULT
   (the loan is DEFAULTED), RECOVERY (an open `Recovery`, status not
   CLOSED/WITHDRAWN) or LEGAL_MATTER (an OPEN `LegalMatter`). A context the
   loan does not have is a 409, even when another purpose holds (review round
   1: RECOVERY used to pass on any of the three). It must also fall inside
   *this* loan's tenure of the asset: `occurredAt ≥ loan.startDate` and earlier
   than the first of the next loan's start on the same asset, the loan's
   `closedAt`, and the SAST start of the earliest recovery's `recoveredOn`
   (a WITHDRAWN recovery aside: the asset went back to the borrower). On an
   asset that has been re-leased, recovered and sold, or a loan that closed,
   the old borrower's page never sees anyone else's movements, and the reverse.
4. **`view_asset_position` is a role list, not `"COLLECTIONS_OFFICER"`.**
   `ROLE_HIERARCHY` puts COLLECTIONS_OFFICER at index 1, so `hasMinRole(…,
   "COLLECTIONS_OFFICER")` would admit INSURANCE_OFFICER. That role lost
   loan-book access for POPIA least privilege
   (`lib/registry/permissions/050-insurance-officer-scope.ts`). The list
   matches `act_on_collections`: COLLECTIONS_OFFICER, COLLECTIONS_AGENT,
   CREDIT_OFFICER, LOAN_ADMIN, BRANCH_MANAGER, ADMIN, SUPER_ADMIN. READONLY,
   INSURANCE_OFFICER, operator roles and DEALER are refused (DEALER and the
   operator roles because they are not in the hierarchy).
5. **The work item is a new `TelematicsAlert` table.** No collections or
   recovery work-item model exists. `AgentTask` is CRM-shaped: it is not
   tenant-scoped, its `type`/`status` are free text, and
   `lead-task-reminders` sends outbound reminders from it. `Notification`
   (bell) has an outbound twin for reminders. Raising an alert writes only
   `TelematicsAlert`, and `lib/telematics/**` imports nothing from
   `lib/messaging`, `lib/notifications`, `lib/whatsapp` or `lib/email`
   (static test), which keeps "no outbound message" provable.
6. **"Implausible" = the existing portal pace ceiling, enforced in SQL.**
   An unattended TELEMATICS write must be ≤ start reading +
   ceil(allowance × `PORTAL_PACE_LIMIT` (3) × (days + 31) / 365), the rule
   `recordMeterReading` already applies to the portal. It is extracted as
   `paceCeiling()` and has an SQL twin, `telematicsPaceCeiling`. A staff accept
   of a held IMPLAUSIBLE reading is a vouching act (`recordedById` = the
   accepter) and skips the ceiling. A LOWER or ABOVE_LATER reading can never be
   accepted, because the existing monotonic trigger refuses it. Staff can only
   reject it, or record a corrected STAFF reading with evidence.
7. **TELEMATICS writes stop when the asset's use under the lease stops.** A
   device reading taken on or after the inspection would block the staff final
   reading (`lease-end-of-term.ts` refuses "a reading … later than the
   inspection", and the monotonic trigger refuses a lower final reading). So
   TELEMATICS needs: loan ACTIVE/DEFAULTED; `readingDate < leaseTermEnd(loan)`;
   no ACCEPTED `LeaseTerminationQuote`; and no `LeaseEndOfTerm` row that ends
   the use early: outcome TOTAL_LOSS or origin EARLY_TERMINATION. A RETURN,
   EXTEND or PURCHASE elected at expiry is recorded up to six months before
   the term ends, and the asset is in use until then; its inspection is never
   before `leaseTermEnd` (extension rentals move that date), so readings go on
   until the term end (review round 1 narrowed this: any end-of-term row used
   to stop them). Readings outside these bounds are device readings only.
8. **One TELEMATICS reading per lease per SAST day** (partial unique). Later
   same-day METER events are kept as device readings (outcome `SAME_DAY`). The
   simulator emits one per day.
9. **Leases with usage only = OPERATING_LEASE and FULL_MAINTENANCE_LEASE**,
   the set `recordMeterReading` already uses. FINANCE_LEASE and INSTALMENT_SALE
   telemetry is stored as device readings only, and the DB refuses a
   TELEMATICS `AssetMeterReading` on them.
10. **Position access log = new tenant-scoped `TelematicsPositionAccess`**, not
    `DocumentAccessLog`, which has no `tenantId` and keys on a document id. It
    stores who, when, which loan, which context, and the position row's id and
    time. It stores no coordinate, so it is kept after the purge. Since the
    review round 1 (browser finding BR7) every reveal also writes an AuditLog
    row `TELEMATICS_POSITION_VIEWED` through `lib/audit.ts`, in the same
    transaction (context, access row id, position id and time; no
    coordinate), and every refused one `TELEMATICS_POSITION_REFUSED`.
11. **Retention range 1–365 days** (CHECK). Default 90 days. A longer period
    needs a migration and legal sign-off.
12. **No "poll now" route.** Acceptance drives
    `GET /api/cron/asset-finance-telematics-poll` with `x-cron-secret`, which
    is the production code path. Determinism comes from the simulator's
    scenario fixture and the anchoring below, not from a dev-only action.
13. **The device id is not forced to equal `FinancedAsset.trackerId`.** The
    payout item reads `trackerId` unchanged. The heartbeat row shows "matches /
    does not match the recorded tracker id" as information only.

Added by the review round 1 (PR #222):

14. **Collection ends with the agreement (POPIA s10/s11).** A position is
    stored, and an alert raised, only while a running loan's tenure covers
    the event: `telematicsLoanAt(tenant, asset, at)` = the ACTIVE or DEFAULTED
    loan on the asset that started on or before `at`'s SAST day, with no later
    loan on the asset started by then and no recovery under it (a withdrawn
    one aside) dated on or before that day. `guardTelematicsPosition` and
    `guardTelematicsAlert` enforce it; an alert's `loanId` is that loan (NOT
    NULL). The poll takes only devices on an asset under an agreement: a
    running loan, or a deal awaiting payout (Deviation 19). After
    settlement, closure, write-off or recovery nothing is polled or kept.
15. **Only the latest position per device.** `TelematicsPosition` is unique on
    `(tenantId, deviceId)`; the ingest (holding the device row lock) keeps a
    newer position and deletes the older one, and drops an older or equal one.
    Retention still applies to that one row. There is no movement trail: a
    theft or affidavit trail would need a counsel decision (review item 3).
16. **A real provider's meter feeds the lease only once verified.** A device
    whose hour meter is offset from the asset's would bill the lessee
    unattended, or floor the true staff reading. `TrackerDevice.meterVerifiedAt
    / meterVerifiedById / meterVerifiedNote` are set once, by an audited staff
    action (`manage_asset_finance`, note 3–500 characters,
    `TRACKER_METER_VERIFIED`) after comparing the device with the dashboard
    meter. Until then every METER event of a non-simulated device has outcome
    METER_UNVERIFIED (a device reading only), and `guardTelematicsMeterReading`
    refuses a TELEMATICS reading from a non-simulated event of an unverified
    device. One held reading per lease per day (unique), and SAME_DAY counts
    the held rows of that day too. Accepting a held reading needs a note
    (CHECK on ACCEPTED and the route). The portal shows who took the latest
    reading ("from the tracker", "recorded by the lessor", "submitted through
    the portal").
17. **Alert queues: SERVICING, COLLECTIONS, RECOVERY.** An alert on a loan in
    good standing is a neutral SERVICING item; COLLECTIONS only when the loan
    is DEFAULTED; RECOVERY when it has an open recovery or an OPEN legal
    matter. Nothing is sent in any of them.
18. **One bad event never wedges a device.** `invalidEvent` also refuses a
    meter value or accuracy outside INTEGER, a control character in an id, an
    event dated before the device's installation (SAST) and one more than five
    minutes ahead of the poll. An event whose own transaction the database
    refuses for what it is (23514, 22021, 22003, 22P05, P2000, P2002, P2020,
    or the driver's INT4 refusal) is skipped and counted as rejected, audited
    `TELEMATICS_EVENT_REJECTED` (provider event id with control characters
    replaced, the reason, no payload), and the cursor moves past it. An event
    ahead of the poll's clock (within the five minutes) is deferred: the
    device keeps its cursor and the next poll takes it. A provider or
    transport failure still keeps the cursor. The device row is locked
    (`FOR UPDATE`) at the start of each event's transaction, so overlapping
    sweeps take turns and fold an alert.
19. **Before payout: a heartbeat, nothing else.** The payout checklist shows a
    tracker's heartbeat beside its TRACKER_CONFIRMED item, before the loan is
    booked. So the poll also takes a device on an asset whose deal is in a
    pre-booking status: APPROVED or CONTRACTED (`PRE_BOOKING_DEAL_STATUSES`
    in `poll.ts`; the enum has no separate SIGNED, a signed deal is
    CONTRACTED). With no booked loan no `telematicsLoanAt` covers its events,
    so the database stores no position and raises no alert (an ALERT event is
    kept, its work item is not), and a METER event is a device reading only
    (LEASE_NOT_RUNNING; no `AssetMeterReading`, since no loan exists). A
    CANCELLED, DECLINED, REFUSED_NCA, REFERRED, SUBMITTED or DRAFT deal is not
    polled; neither is an asset with no deal (`pre-payout.integration.test.ts`).

### Data (prisma/schema/asset-finance-telematics.prisma, new file)

Two migrations, after main's latest `20261020042833_message_dunning_flag`:

- `20261020160000_telematics_enum_values`: only
  `ALTER TYPE "MeterReadingSource" ADD VALUE 'TELEMATICS';`. A new value cannot
  be used in the transaction that adds it.
- `20261020160100_telematics`: everything else.

Every new table is tenant-scoped in the same way as PR A: `tenantId`,
`@@unique([tenantId, id])`, composite FKs `(tenantId, x)` ON DELETE/UPDATE
RESTRICT, listed in `lib/registry/tenant-scoped-models/250-asset-finance-telematics.ts`,
with RLS `tenant_isolation` copied from `20261019120100_dealer_portal`
(`cf_rls_unrestricted() OR "tenantId" = cf_rls_tenant()`). Every guard has a
`_no_truncate` statement trigger. Errors use ERRCODE `23514`. Today =
`(now() AT TIME ZONE 'Africa/Johannesburg')::date`.

```prisma
enum TrackerDeviceStatus { ACTIVE REMOVED }
enum TelematicsEventKind { HEARTBEAT POSITION METER IGNITION ALERT }
enum TelematicsAlertKind { TAMPER POWER_CUT GEOFENCE_EXIT }
enum TelematicsMeterOutcome { RECORDED HELD SAME_DAY NOT_LEASE LEASE_NOT_RUNNING NO_USAGE_TERMS METER_UNVERIFIED }
enum TelematicsHeldReason { LOWER ABOVE_LATER IMPLAUSIBLE }
enum TelematicsHeldStatus { HELD ACCEPTED REJECTED }
enum TelematicsAlertQueue { SERVICING COLLECTIONS RECOVERY }
enum TelematicsAlertStatus { OPEN ACKNOWLEDGED RESOLVED }
enum TelematicsPositionContext { DEFAULT RECOVERY LEGAL_MATTER }

model TrackerDevice {      // assetId (→ FinancedAsset), provider String (registry key), externalDeviceId String,
                           // installedOn @db.Date, status @default(ACTIVE), removedOn @db.Date?, removedById? (→ User),
                           // createdById (→ User), pollCursor String?, lastPolledAt?, lastPollError String?,
                           // meterVerifiedAt?, meterVerifiedById? (→ User), meterVerifiedNote?, createdAt, updatedAt
}
model TelematicsEvent {    // deviceId, provider (copied from device), providerEventId, kind, occurredAt, receivedAt @default(now()),
                           // meterValue Int?, meterUnit UsageUnit?, ignitionOn Boolean?, alertKind TelematicsAlertKind?,
                           // simulated Boolean, meterOutcome TelematicsMeterOutcome?; @@unique([tenantId, provider, providerEventId]);
                           // @@index([tenantId, deviceId, kind, occurredAt]), @@index([tenantId, kind, occurredAt]) (the purge)
}
model TelematicsPosition { // eventId @unique (→ TelematicsEvent), deviceId, occurredAt, latitude Decimal(9,6), longitude Decimal(9,6),
                           // accuracyM Int?; @@unique([tenantId, deviceId]) (the latest only); @@index([tenantId, occurredAt]) (the purge)
}
model TelematicsHeldReading { // eventId @unique, loanId, assetId, readingDate @db.Date, value, unit UsageUnit, reason, status @default(HELD),
                              // decidedById? (→ User), decidedAt?, decisionNote?, meterReadingId? @unique (→ AssetMeterReading), createdAt;
                              // @@unique([tenantId, loanId, readingDate]) (one held reading per lease per day)
}
model TelematicsAlert {    // eventId @unique (first event), deviceId, assetId, loanId (the tenure's), kind, queue, status @default(OPEN),
                           // firstOccurredAt, lastOccurredAt, occurrences Int @default(1), acknowledgedById?, acknowledgedAt?,
                           // resolvedById?, resolvedAt?, resolutionNote?, createdAt, updatedAt (all *ById → User)
}
model TelematicsPositionAccess { // userId (→ User), loanId, assetId, deviceId, context, positionId String? (no FK: survives purge),
                                 // positionOccurredAt?, ipAddress?, userAgent?, createdAt
}
```

Additive columns:

- `TenantConfig.telematicsPositionRetentionDays Int @default(90)` (tenancy.prisma).
- `AssetMeterReading.telematicsEventId String? @unique` (FK `(tenantId,
  telematicsEventId)` → `TelematicsEvent`). `ADD COLUMN` does not fire the
  row trigger.
- Back-relations stay alphabetical (`prisma/schema-order.test.ts`):
  `FinancedAsset.trackerDevices`, `Loan.telematicsAlerts`,
  `Loan.telematicsHeldReadings`, `User.*` as needed, `Tenant.*`.

#### CHECKs

- `TenantConfig_telematics_retention_range`: `BETWEEN 1 AND 365`.
- `TrackerDevice_provider_key`: `provider ~ '^[a-z0-9-]{1,40}$'`;
  `TrackerDevice_external_id`: `length(btrim("externalDeviceId")) BETWEEN 1 AND 100`;
  `TrackerDevice_status_shape`: ACTIVE ⇔ `removedOn`/`removedById` NULL;
  `TrackerDevice_meter_verified_shape`: the three `meterVerified*` columns are
  all NULL or all set, the note 3–500 non-blank characters.
- Partial uniques: `(tenantId, assetId) WHERE status='ACTIVE'` (one live device
  per asset); `(tenantId, provider, externalDeviceId) WHERE status='ACTIVE'`.
- `TelematicsEvent_kind_shape`: METER ⇔ `meterValue`, `meterUnit` set and
  `meterValue >= 0`; IGNITION ⇔ `ignitionOn` set; ALERT ⇔ `alertKind` set.
  Each field is NULL on the other kinds. `meterOutcome` is NULL unless METER.
  `TelematicsEvent_provider_event_id`: `length("providerEventId") BETWEEN 1 AND 200`.
- `TelematicsPosition_range`: `latitude BETWEEN -90 AND 90`,
  `longitude BETWEEN -180 AND 180`, `accuracyM IS NULL OR accuracyM >= 0`.
- `TelematicsHeldReading_decision_shape`: HELD ⇔ `decidedById`/`decidedAt`
  NULL; ACCEPTED ⇒ `meterReadingId` set; REJECTED ⇒ `meterReadingId` NULL;
  ACCEPTED and REJECTED both ⇒ `length(btrim(decisionNote)) BETWEEN 3 AND 500`.
  Unique `(tenantId, loanId, readingDate)`: one held reading per lease per day.
- `TelematicsPosition` unique `(tenantId, deviceId)`: the latest position only.
- `TelematicsAlert_status_shape`: ACKNOWLEDGED ⇒ ack pair set; RESOLVED ⇒
  resolved pair set and the note is 3–500 non-blank characters;
  `occurrences >= 1`; `lastOccurredAt >= firstOccurredAt`. Partial unique
  `(tenantId, deviceId, kind) WHERE status <> 'RESOLVED'` (repeats fold into
  the open item).
- `AssetMeterReading_telematics_shape`:
  `("source" = 'TELEMATICS') = ("telematicsEventId" IS NOT NULL) AND ("source" <> 'TELEMATICS' OR "recordedByClientId" IS NULL)`.
  Partial unique `AssetMeterReading_telematics_one_per_day` on
  `(tenantId, loanId, readingDate) WHERE source = 'TELEMATICS'`.

#### Triggers and functions

- `telematicsPaceCeiling(tenant text, loan text, on date) → integer`: NULL when
  the deal has no `usageAllowancePerYear`. Otherwise it is the start reading's
  value plus `ceil(allowance × 3 × (on − start.readingDate + 31) / 365.0)`,
  where the start reading is the loan's earliest reading. This is the same
  arithmetic as `meter-readings.ts`. The TS twin `paceCeiling()` is tested
  equal to it.
- `telematicsLoanAt(tenant text, asset text, at timestamp) → text`: the loan
  whose tenure of the asset covers `at` (Deviation 14), or NULL.
- `guardTrackerDevice` (BEFORE INSERT OR UPDATE OR DELETE):
  - INSERT: status ACTIVE, unverified (`meterVerifiedAt` NULL),
    `installedOn ≤ today` (the composite FK keeps the asset the tenant's).
  - UPDATE: `tenantId, assetId, provider, externalDeviceId, installedOn,
    createdById` are immutable. ACTIVE → REMOVED is one-way, with `removedOn`
    between `installedOn` and today. A REMOVED device is final: nothing on it
    changes, so `pollCursor/lastPolledAt/lastPollError` change only while ACTIVE.
    The meter verification is set once: once `meterVerifiedAt` is set, none of
    the three columns changes.
  - DELETE refused.
- `guardTelematicsEvent`:
  - INSERT: the device is the tenant's and ACTIVE, and `provider` = the
    device's provider. `occurredAt` is no later than `now() + interval '5 minutes'`
    and its SAST date is no earlier than `installedOn`. `meterOutcome` is NULL.
  - UPDATE: only `meterOutcome` may change, NULL → a value, METER only, and
    consistently at ingest: RECORDED exactly when an `AssetMeterReading` names
    the event, HELD exactly when a `TelematicsHeldReading` does. It is the
    outcome at ingest: a held reading accepted later keeps HELD.
  - DELETE: only kinds HEARTBEAT, IGNITION, POSITION with `occurredAt < now() −
    retentionDays` (the purge). METER and ALERT events are refused (they are
    referenced business records).
- `guardTelematicsPosition`: INSERT only for its event's device and
  `occurredAt` (event kind POSITION or ALERT), while `telematicsLoanAt` covers
  it, with `occurredAt ≥ now() − retentionDays`, so a stale backfill is never
  stored. UPDATE refused. DELETE allowed (the ingest replacing it, the purge,
  or a DSAR erasure). TRUNCATE refused.
- `guardTelematicsMeterReading` (trigger `AssetMeterReading_telematics`, BEFORE
  INSERT ON "AssetMeterReading" FOR EACH ROW WHEN (NEW."source" = 'TELEMATICS');
  its name sorts after the existing `AssetMeterReading_guard`, which fires
  first and still enforces the monotonic, immutable and date rules):
  - Event: the tenant's, kind METER, `meterValue = NEW.value`,
    `meterUnit = NEW.unit`, SAST date of `occurredAt` = `readingDate`, and its
    device's `assetId = NEW.assetId`; simulated, or of a device whose meter is
    verified.
  - Loan: `loanId` NOT NULL, same tenant and asset, `contractType IN
    ('OPERATING_LEASE','FULL_MAINTENANCE_LEASE')`, status IN
    ('ACTIVE','DEFAULTED'), `readingDate < leaseTermEnd(loan_id, tenant_id)`
    (a lease without rentals is refused), no `LeaseEndOfTerm` for the loan
    with outcome TOTAL_LOSS or origin EARLY_TERMINATION, and no
    `LeaseTerminationQuote` with status ACCEPTED.
  - `recordedById IS NULL` (unattended) ⇒ no `TelematicsHeldReading` for the
    event, and `NEW.value ≤ telematicsPaceCeiling(...)` when that is not NULL.
    `recordedById` set ⇒ a HELD `TelematicsHeldReading` for the event and the
    same loan exists (the accept path), and the deferred constraint trigger
    `AssetMeterReading_telematics_accepted` (`guardTelematicsReadingAccepted`)
    requires that hold to be ACCEPTED with this reading by the end of the
    transaction.
- `guardTelematicsHeldReading`:
  - INSERT: status HELD, and event, asset, date, value and unit equal the
    event's and its device's; the loan is an operating or full-maintenance
    lease of that asset. The event's `meterOutcome` is set to HELD in the same
    tx (the event guard checks that a HELD outcome has its held reading).
  - UPDATE: HELD → ACCEPTED requires the `meterReadingId` row's
    `telematicsEventId = eventId` and `recordedById = decidedById`. HELD →
    REJECTED requires the note. Nothing else changes.
  - DELETE refused.
- `guardTelematicsAlert`:
  - INSERT: status OPEN, `occurrences` 1, first and last occurrence the event's
    time; the event kind is ALERT with `alertKind = kind`, and device and asset
    are the event's. `loanId` is `telematicsLoanAt` of the event.
  - UPDATE: `occurrences` +1 and `lastOccurredAt` forward only while not
    RESOLVED. OPEN → ACKNOWLEDGED, and OPEN or ACKNOWLEDGED → RESOLVED. The
    identity columns and `queue` are fixed.
  - DELETE refused.
- `guardTelematicsPositionAccess`: INSERT only, by a `User` of the same tenant
  (composite FK), naming a loan on its asset and, if any, a device of that
  asset (`deviceId` is NULL when the asset never had one). UPDATE, DELETE and
  TRUNCATE are refused.

### Provider adapter (lib/telematics/)

- `types.ts`: `NormalisedTelematicsEvent { providerEventId; externalDeviceId;
  occurredAt: Date; kind; position?: { latitude; longitude; accuracyM | null };
  meter?: { value; unit: "HOURS" | "KM" }; ignitionOn?; alert?:
  TelematicsAlertKind }`; `TelematicsProvider { id; label; simulated: boolean;
  poll({ devices: { externalDeviceId; cursor: string | null; installedOn:
  string }[]; now: Date }): Promise<{ events; cursors: Record<string, string>;
  simulated: boolean; simulationSource?: "simulated-telematics" }>;
  deviceIdError(externalDeviceId): string | null; assertUsable(): void }`
  (registration asks both: a simulated device id is `SIM-<SCENARIO>-<n>`);
  `TelematicsProviderError` with codes `NOT_CONFIGURED | UNAVAILABLE |
  BAD_RESPONSE`. Device status and heartbeat come from the HEARTBEAT events
  (`lastSeenAt` = the newest event of any kind). No real provider is included.
- `registry.ts`: `registerTelematicsProvider`, `getTelematicsProvider`,
  `registeredTelematicsProviderIds`, copied from `lib/bureau/registry.ts`.
  Device registration refuses an unregistered key (422).
- `providers/simulated.ts` (`SIMULATED_TELEMATICS_ID = "simulated"`, guard key
  `"simulated-telematics"`, registered in
  `lib/registry/simulated-integrations/050-telematics.ts` with
  `sandboxEnvVar: null`). It calls `assertSimulationAllowed("simulated-telematics",
  true)` when `poll` is invoked and when a simulated device is registered. On
  a deployed build without `SIMULATED_INTEGRATIONS=simulated-telematics` it
  throws `NOT_CONFIGURED`. Every result and every stored event carries
  `simulated: true`. The UI shows an amber "Simulated" chip on the device, the
  readings ("Telematics, simulated"), the alerts and the position.
- **Deterministic scenarios** (`__fixtures__/simulated-telematics-scenarios.ts`).
  The device id `SIM-<SCENARIO>-<n>` picks the scenario. The timeline is a
  pure function of `(externalDeviceId, installedOn, now)` with no state. Day
  *d* after `installedOn` (SAST) emits HEARTBEAT 06:00, POSITION 12:00 (a
  synthetic point that clearly is not real: a fixed origin plus a
  deterministic offset under 0.05°), and METER 18:00 = `startValue + perDay ×
  d` HOURS. Scenarios:
  - STEADY: start 1 000, 6 h/day (2 190/yr, over a 1 500 allowance, so a
    projected excess shows).
  - TAMPER: STEADY + TAMPER on day 25 at 19:00 + POWER_CUT on day 26.
  - GEOFENCE: STEADY + GEOFENCE_EXIT with a position on day 20.
  - ROLLBACK: STEADY, but day 15 reads 200 lower.
  - SPIKE: STEADY, but day 10 reads +50 000.
  - SILENT: nothing after day 5.

  The event id is `sim:<device>:<installedOn>:<d>:<kind>[:<alert>]`, so a
  re-poll yields the same ids, and a device id removed and registered again
  with a later installation date never replays the old installation's ids. The cursor is the last emitted `occurredAt` ISO. A poll returns
  events in (cursor, now], at most 500 per device (the next poll pages on).

### Ingest (lib/telematics/ingest.ts, poll.ts)

- **Sweep** `runTelematicsPoll(now)`, in the style of
  `runRecoveryDeadlineSweep`. For each tenant with `featureAssetFinance`, take
  its ACTIVE devices on an asset under an agreement (Deviation 14) grouped by
  provider and call `provider.poll`. A provider error sets `lastPollError` on
  those devices (audited `TELEMATICS_POLL_FAILED`), adds to `run.failed`, and
  the sweep goes on. Unknown device ids in a result are counted and dropped; a
  malformed event (`event-shape.ts`) or one the database refuses is counted as
  rejected, audited and skipped, and an event ahead of the poll's clock is
  counted as deferred (Deviation 18).
- **Per event, one transaction** (`ingestEvent(tx, device, event, now)`):
  1. `SELECT … FROM "TrackerDevice" … FOR UPDATE`: overlapping sweeps take
     turns on one device. Then `INSERT … ON CONFLICT
     ("tenantId","provider","providerEventId") DO NOTHING RETURNING id`. No
     row means a duplicate: stop, with no side effects. This is the only
     idempotency key, and a replayed batch changes nothing.
  2. If there is a position and `telematicsLoanAt` covers the event, keep it
     as the device's one position if it is newer than the stored one (that
     one is deleted) and not older than retention. Otherwise drop the
     position and keep the event.
  3. A METER event goes to `routeMeterReading`:
     - A non-simulated device whose meter is not verified: `METER_UNVERIFIED`.
     - Find the asset's loan where `startDate ≤ event date`, status ACTIVE or
       DEFAULTED. If there is none, the outcome is `LEASE_NOT_RUNNING`.
     - Not an operating or full-maintenance lease: `NOT_LEASE`.
     - No usage terms, or terms in another unit than the meter's: `NO_USAGE_TERMS`.
     - On or after the term end, or after an accepted termination, a total
       loss or an early termination: `LEASE_NOT_RUNNING`.
     - A TELEMATICS reading or a held reading already exists that day:
       `SAME_DAY`.
     - Otherwise call
       `recordMeterReading(tx, { tenantId, telematics: { eventId } }, {
       loanId, readingDate, value, evidenceDocumentId: null, today })`. A
       recorded reading gives `RECORDED`. A refusal with `not_monotonic` (below
       an earlier reading gives LOWER; above a later one gives ABOVE_LATER) or
       `implausible_reading` (IMPLAUSIBLE) inserts `TelematicsHeldReading` and
       gives `HELD` (audit `TELEMATICS_READING_HELD`).
     - The event's `meterOutcome` is set at the end.
  4. An ALERT event under a covering loan goes to `raiseAlert`. If an
     unresolved alert exists for the same (device, kind), increment it.
     Otherwise insert OPEN on that loan with queue RECOVERY when it has an
     open `Recovery` or an OPEN `LegalMatter`, COLLECTIONS when it is
     DEFAULTED, and SERVICING otherwise. Audit `TELEMATICS_ALERT_RAISED`.
     Nothing is sent.
  5. After the batch, advance the device's `pollCursor`/`lastPolledAt`, unless
     one of its events failed for a reason worth retrying (then only
     `lastPolledAt` and `lastPollError` move) or waits in the future (then
     only `lastPolledAt` moves). The device's later events wait, and the next
     poll retries from the old cursor (the ingest is idempotent). A rejected
     event never holds the cursor.
- **`recordMeterReading` change.** `ReadingActor` gains a third arm,
  `{ tenantId; telematics: { eventId: string; acceptedById?: string } }`. For
  it, source is `TELEMATICS`, `telematicsEventId` is set, `recordedById` is
  `acceptedById ?? null`, the loan must be ACTIVE/DEFAULTED, the date must be
  ≤ today, and the pace ceiling applies unless `acceptedById` is set.
  `paceCeiling()` is extracted and shared with the portal. The audit is
  `METER_READING_RECORDED` with `source: "TELEMATICS"`, `userId` set to the
  accepter or undefined, and `newValue.actor = { type: "system", source:
  "telematics", eventId }`. The STAFF and PORTAL behaviour is unchanged, and
  the existing tests stay green.
- **Held readings** (`held-readings.ts`, `manage_asset_finance`):
  - `acceptHeldReading` needs a note (400 without one), locks the row and
    calls `recordMeterReading` with `acceptedById`. A monotonic refusal
    surfaces as 422 "a lower reading cannot be accepted; reject it or record a
    corrected reading with evidence". On success it sets ACCEPTED with the
    note.
  - `rejectHeldReading` requires a note.
  - Both are audited (`TELEMATICS_HELD_READING_ACCEPTED/_REJECTED`).

### Heartbeat beside the certificate

`trackerHeartbeat(tenantId, assetId)` (`lib/telematics/devices.ts`) →
`{ deviceId, provider, externalDeviceId, simulated, lastSeenAt, matchesTrackerId }`
is loaded by the deal page and shown on the TRACKER_CONFIRMED row of
`app/(dashboard)/asset-finance/deals/[id]/PayoutPanel.tsx`, as "Live heartbeat
2026-10-19 06:00 (simulated) — evidence still required: tracker certificate".
`payout-checklist.ts`, `payout-checklist-store.ts` and
`guardPayoutChecklistItem` are not touched. The SQL still demands a
staff-uploaded TRACKER_CERTIFICATE (migration 20261013114400). A static test
asserts that no payout module imports `lib/telematics`.

### Position view and POPIA

- `revealPosition(actor, loanId, context, req)`:
  1. `canDo(role, "view_asset_position")`; failure is 403 with no access row.
  2. Context: DEFAULT, RECOVERY or LEGAL_MATTER (400 otherwise). Loan: the
     tenant's, on an asset (404 otherwise).
  3. Purpose gate (Deviation 3); failure is 409 "Position is shown only for a
     loan in default, legal action or recovery".
  4. Context: DEFAULT needs the loan DEFAULTED, RECOVERY an open recovery,
     LEGAL_MATTER an OPEN matter (409 "This loan is not in default", "… has
     no open recovery", "… has no open legal matter").
  5. Pick the latest `TelematicsPosition` of the asset's devices within the
     tenure window (Deviation 3) and with `occurredAt ≥ now() − retentionDays`
     (the filter holds even if the purge has not run).
  6. Insert `TelematicsPositionAccess` and then return
     `{ latitude, longitude, accuracyM, occurredAt, simulated }`, or
     `{ none: true }`. Both outcomes are logged.

  Every 403 and 409 writes an audit row, `TELEMATICS_POSITION_REFUSED`
  (`auditRefusal`: who, the loan, the role, the context, the reason; no
  coordinate). No map tile and no third-party link: the coordinates are shown
  as text and never sent off-box.
- **Retention.** Admins set `telematicsPositionRetentionDays` through
  `PATCH app/api/settings/asset-finance` (existing ADMIN guard). A 23514 error
  becomes 422. Audit `TELEMATICS_RETENTION_CHANGED`.
- **Purge.** `purgeTelematicsPositions()` runs nightly for every tenant that has
  a device (whatever its feature flag), using that tenant's days and the
  database's clock (the one `guardTelematicsEvent` checks). It deletes in 5 000-row batches as
  `lib/lender-api/retention.ts` does: first `TelematicsPosition`, then
  HEARTBEAT/IGNITION/POSITION events older than the cutoff that nothing
  references. Each tenant with deletions gets one audit row,
  `TELEMATICS_POSITIONS_PURGED` (counts only). Access-log rows are kept.
- **Dealers.** They are refused in four ways: the dealer host gate 404s
  `/api/asset-finance/*`; `canDo("DEALER", …)` is false by construction; the
  dealer projection (`lib/dealer/deal-view.ts`) whitelists nothing from
  telematics; and a sentinel test proves it.

### Routes

Staff (house pattern `requireApiRole` → `withTenantContext` →
`requireAssetFinanceEnabled` → `canDo`):

| Route | Permission |
|---|---|
| `POST /api/asset-finance/assets/[id]/tracker-devices` (register) | `manage_asset_finance` |
| `POST /api/asset-finance/tracker-devices/[deviceId]/remove` | `manage_asset_finance` |
| `POST /api/asset-finance/tracker-devices/[deviceId]/verify-meter` (body `{ note }`) | `manage_asset_finance` |
| `GET /api/asset-finance/telematics/alerts?queue=&status=` | `work_telematics_alerts` |
| `POST /api/asset-finance/telematics/alerts/[alertId]/acknowledge` and `…/resolve` (one `[action]` route) | `work_telematics_alerts` |
| `GET /api/asset-finance/telematics/held-readings` | `manage_asset_finance` |
| `POST /api/asset-finance/telematics/held-readings/[id]/accept` and `…/reject` (one `[action]` route) | `manage_asset_finance` |
| `POST /api/asset-finance/loans/[loanId]/telematics/position` (body `{ context }`: DEFAULT, RECOVERY or LEGAL_MATTER) | `view_asset_position` |

Cron (`verifyCronSecret`, registered in
`lib/registry/cron-jobs/140-asset-finance-telematics.ts`):

| Route | Schedule | Freshness |
|---|---|---|
| `GET /api/cron/asset-finance-telematics-poll` | `*/15 * * * *` | `HOUR` |
| `GET /api/cron/asset-finance-telematics-purge` | `40 3 * * *` | `DAY + 2 * HOUR` |

Both answer 503 when any tenant failed.

Pages and components:

- `(dashboard)/asset-finance/telematics`: work queue, with tabs for alerts by
  queue/status and for held readings.
- Asset page `assets/[id]`: a "Tracker devices" card (register or remove; last
  seen; simulated chip).
- Staff loan page: `TelematicsPanel` (device, heartbeat, alerts, held readings),
  in `AssetLoanRecoveryPanels`; TELEMATICS readings appear in the existing
  readings table via `components/asset-finance/lease/lease-staff-data.ts`,
  which already feeds `projectedExcessUsage` with every source.
- `LastKnownPosition` client button inside `RecoveryPanel` (context RECOVERY
  while a recovery is live; context DEFAULT before one exists, which the
  server answers only for a loan in default) and `LegalMatterPanel` (context
  LEGAL_MATTER, while the matter is open). It renders only when the server
  passes `canDo(role, "view_asset_position")`. Where the reveal would be
  refused now (the purpose gate, `lib/telematics/position-purpose.ts`, shared
  with the reveal), the panel shows "Last known position: <reason>." instead
  of the button.
- Loan page readings tiles: "Projected usage at term end" is the usage the
  projected excess is priced on (projected meter reading less the start
  reading), against the allowance; the projected meter reading is its detail.
  `projectedExcessUsage` is unchanged.
- Tracker work queue: below the md breakpoint each alert and held reading is
  a stacked card with its actions; the table is the md-and-up layout.
- Asset page "Tracker devices" card: a device that is not the asset's
  recorded tracker id is flagged amber ("Tracker id mismatch") with the next
  action. a real provider's live device shows
  "Meter not verified: its readings feed no lease" and, for
  `manage_asset_finance`, a note and "Verify meter".
- Settings → Asset Finance: the retention field. Navigation: "Tracker alerts"
  (minRole COLLECTIONS_OFFICER; the page re-checks the permissions).

Registries:

- Permissions (`lib/registry/permissions/070-asset-finance-telematics.ts`):
  `view_asset_position` and `work_telematics_alerts`, both the
  `act_on_collections` list.
- Audit actions (`lib/registry/audit-actions/430-asset-finance-telematics.ts`):
  TRACKER_DEVICE_REGISTERED, TRACKER_DEVICE_REMOVED, TELEMATICS_READING_HELD,
  TELEMATICS_HELD_READING_ACCEPTED, TELEMATICS_HELD_READING_REJECTED,
  TELEMATICS_ALERT_RAISED, TELEMATICS_ALERT_ACKNOWLEDGED,
  TELEMATICS_ALERT_RESOLVED, TELEMATICS_RETENTION_CHANGED,
  TELEMATICS_POSITIONS_PURGED, TELEMATICS_POLL_FAILED, and from the review
  round 1 TELEMATICS_EVENT_REJECTED, TELEMATICS_POSITION_REFUSED,
  TRACKER_METER_VERIFIED.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_TELEMATICS_IT` unless noted)

DB rules use the `ruleRefuses(db, rule, message, attack)` helper
(`lease-servicing.integration-fixture.ts`): the attack passes with the rule
dropped and fails with it in place. Fixture: `lib/telematics/telematics.integration-fixture.ts`
on `createLeaseFixture` / `payoutAndBook` / `shiftLease`, plus an
instalment sale through `approveDeal` (`payout-booking.integration-fixture.ts`).

| Rule | Test file | Kind | Negative cases (§3 B) |
|---|---|---|---|
| Simulated provider refused on a deployed build | `lib/telematics/providers/simulated.test.ts`, `lib/telematics/poll.test.ts`, `lib/telematics/devices.integration.test.ts` | unit + IT | NODE_ENV=production with no allow-list: poll throws NOT_CONFIGURED, no event written, `lastPollError` set; registering a simulated device is refused; `SIMULATED_INTEGRATIONS=simulated-telematics` allows it; every event `simulated: true` |
| Scenario determinism | `lib/telematics/providers/simulated.test.ts` | unit | the same (device, installedOn, now) gives identical ids; the cursor pages without gaps or repeats |
| Idempotent ingest | `lib/telematics/ingest.integration.test.ts` | IT | duplicate events: the same batch twice, and two concurrent sweeps, give one event, one reading, one alert increment; the unique index dropped makes the duplicate pass |
| Lower meter value held, not written | same | IT | ROLLBACK day 15 → HELD/LOWER, no `AssetMeterReading`; a direct TELEMATICS insert is refused by `AssetMeterReading_guard`; accept is refused 422; reject sets REJECTED |
| Implausible value held | same + `lib/telematics/pace-ceiling.test.ts` + `lib/asset-finance/meter-readings-telematics.test.ts` | IT + unit | SPIKE → HELD/IMPLAUSIBLE; a direct unattended insert above the ceiling is refused by `guardTelematicsMeterReading` (rule-dropped passes); staff accept writes it with `recordedById`; `paceCeiling()` equals `telematicsPaceCeiling` on the table in `lib/telematics/__fixtures__/pace-table.ts` (SQL side in the meter-route IT) |
| Instalment-sale write refused | `lib/telematics/meter-route.integration.test.ts` | IT | an INSTALMENT_SALE (and FINANCE_LEASE, the loan's type set inside the rolled-back attack) METER event → `NOT_LEASE`, a device reading only; a direct TELEMATICS insert on such a loan is refused |
| Writes stop at end of term | same | IT | a reading on or after `leaseTermEnd`, with a `LeaseEndOfTerm` row, or with an ACCEPTED termination → `LEASE_NOT_RUNNING`; the staff final reading at inspection still succeeds |
| One per day; event binding | same | IT | a second same-day event → SAME_DAY; a TELEMATICS insert whose value or date or asset differs from its event is refused; the `_telematics_shape` CHECK |
| `recordMeterReading` unchanged for STAFF/PORTAL | existing `lib/asset-finance/meter-readings.test.ts`, `lease-servicing-rules-readings.integration.test.ts` | unit + IT (`RUN_*` existing) | no edits other than additions |
| Alert raises a work item, no message | `lib/telematics/alerts.integration.test.ts`, `lib/telematics/no-outbound.test.ts` | IT + unit | TAMPER → OPEN COLLECTIONS item; with an open LegalMatter → RECOVERY; a repeat folds in (occurrences 2); zero `Message`/`Notification`/`EmailLog` rows; import graph has no messaging modules |
| Alert lifecycle guard | same | IT | resolve without a note; reopen RESOLVED; change `queue`; DELETE |
| Position visible to COLLECTIONS_OFFICER+, logged | `lib/telematics/position-view.integration.test.ts` | IT | READONLY → 403 and no access row; INSURANCE_OFFICER → 403; COLLECTIONS_OFFICER → position plus one access row; `{ none }` is logged too |
| Position refused to a dealer | `lib/telematics/dealer-refusal.test.ts` | unit | DEALER session → `requireApiRole` 403; `dealerOffHostRefusal`/`dealerHostGate` 404 for the position route; `deal-view` sentinel (a telematics value is never in the projection) |
| Purpose and tenure gates | `position-view.integration.test.ts` | IT | ACTIVE loan with no default, matter or recovery → 409; on a re-leased asset the old loan sees no new-lease positions, and the reverse |
| Coordinates have one read path | `lib/telematics/position-read-path.test.ts` | unit | a grep over `lib app components` finds `latitude`/`longitude` selects only in the three allow-listed modules; pages contain no `telematicsPosition` query |
| Access log immutable | `position-view.integration.test.ts` | IT | UPDATE, DELETE and TRUNCATE are refused |
| The purge | `lib/telematics/purge.integration.test.ts` | IT | positions older than the tenant's days are deleted and younger ones kept; per-tenant days (30 vs 90); METER/ALERT events and access rows survive; a stale position insert is refused; deleting a METER event is refused; the view never returns a position past retention even before the purge; retention 0 and 366 are refused by the CHECK |
| Heartbeat without a certificate does not complete TRACKER_CONFIRMED | `lib/telematics/tracker-certificate.integration.test.ts`, `lib/telematics/payout-isolation.test.ts`, `PayoutPanel.test.tsx` | IT + unit | live heartbeats and no TRACKER_CERTIFICATE → confirm refused (route 422; a direct confirm with no evidence by CHECK `PayoutChecklistItem_evidence_required`, with a non-certificate document by `guardPayoutChecklistItem`); the payout modules import nothing from `lib/telematics`; the panel shows the heartbeat and still "Open" |
| Device guard | `lib/telematics/devices.integration.test.ts` | IT | two ACTIVE devices on one asset; changing `externalDeviceId`; REMOVED → ACTIVE; DELETE; an event for a REMOVED device |
| Cron secret and registry | `instrumentation.cron-census.test.ts`, `app/api/cron/asset-finance-telematics-{poll,purge}/route.test.ts` | unit | missing or wrong secret → 401; 503 on any failure |
| Staff route contract | `app/api/asset-finance/telematics/routes.test.ts` | unit | flag off → 404 everywhere; READONLY and INSURANCE_OFFICER → 403 everywhere, no lib call; lib status and fields as is; unknown action 404 |
| Retention setting | `app/api/settings/asset-finance/route.test.ts` | unit | change audited `TELEMATICS_RETENTION_CHANGED`; the range CHECK → 422; a non-number → 400 |
| RLS on the new models | existing `RUN_TENANT_ISOLATION_IT` catalog test | IT | cross-tenant device, event and alert reads |

Added by the review round 1 (each row's mutation is in `evidence/slice5/MUTATIONS.md`, Part B round 1):

| Rule | Test file | Kind | Negative cases |
|---|---|---|---|
| Collection ends with the agreement (`telematicsLoanAt`) | `lib/telematics/after-settlement.integration.test.ts`, `guards.integration.test.ts`, `guard-clauses.integration.test.ts`, `alerts.integration.test.ts` | IT | a completed agreement stores no position; a closed lease refuses a position and an alert; a tenure not begun, or overtaken by a later loan, refuses a position; a recovery dated today raises no alert for today's event |
| Only devices under an agreement are polled | `lib/telematics/poll.test.ts`, `tracker-certificate.integration.test.ts` | unit + IT | the device query names a running loan or a CONTRACTED deal; the payout heartbeat still shows before booking |
| One position per device, the latest | `guards.integration.test.ts`, `edge-cases.integration.test.ts`, `ingest.integration.test.ts` | IT | a second position on a device refused (unique dropped: admitted); an older one not stored; a newer one replaces it; a poll leaves one |
| Tenure ends at recovery and closing (view) | `lib/telematics/breaker.integration.test.ts`, `position-view.integration.test.ts` | IT | a recovered and sold asset, and a closed loan with an open matter, reveal nothing after; a re-leased asset shows each loan only its own fix |
| Each context needs its own purpose; refusals audited | `position-view.integration.test.ts`, `breaker.integration.test.ts` | IT | RECOVERY with only a matter → 409; DEFAULT on a loan not in default → 409; LEGAL_MATTER after the matter closes → 409; 403s and 409s each write `TELEMATICS_POSITION_REFUSED` with no coordinate |
| Alert queues | `alerts.integration.test.ts` | IT | good standing → SERVICING; DEFAULTED → COLLECTIONS; an open matter, or an open recovery alone → RECOVERY |
| Alert binding clauses | `guard-clauses.integration.test.ts`, `review-gaps.integration.test.ts` | IT | another device, another asset, another kind, a first or last occurrence off the event's time, a repeat moving the last occurrence back; a repeat folds into an ACKNOWLEDGED item |
| Position binding clauses | `review-gaps.integration.test.ts` | IT | a position bound to another asset's device, or a minute off its event's time |
| Meter verification | `meter-offset.integration.test.ts`, `guard-clauses.integration.test.ts`, `app/api/asset-finance/telematics/routes.test.ts` | IT + unit | an unverified real device → METER_UNVERIFIED and the true staff reading still goes in; a direct reading refused; verify needs a note, once, audited; registered verified refused; the shape CHECK; set once |
| One held reading a day; accept needs a note | `meter-offset.integration.test.ts`, `guards.integration.test.ts`, `ingest.integration.test.ts`, `edge-cases-ingest.integration.test.ts` | IT | four low events one day → one HELD, three SAME_DAY; a second hold the same day refused; accept without a note → 400, and ACCEPTED without a note refused by the CHECK |
| A staff reading is its own lease's hold, accepted in the same transaction | `guard-clauses.integration.test.ts` | IT | a hold of another lease; a reading left with its hold HELD (deferred trigger); another decider's reading |
| Narrowed end of term | `meter-route.integration.test.ts` | IT | RETURN and EXTEND elected at expiry still record through ingest; TOTAL_LOSS and EARLY_TERMINATION stop readings |
| Held reading binding clauses | `guard-clauses.integration.test.ts`, `meter-route.integration.test.ts` | IT | another unit, another asset, a non-usage lease; a full-maintenance lease records; a meter in another unit is NO_USAGE_TERMS; the pace ceiling ignores a reading in another unit |
| Poison events never wedge a device | `lib/telematics/event-shape.test.ts`, `poll.test.ts`, `edge-cases-ingest.integration.test.ts`, `poll-rejects.integration.test.ts` | unit + IT | INT4 meter and accuracy, control characters, before installation, more than five minutes ahead → rejected, audited, cursor past; the same events with the shape check bypassed → refused by the database (23514, 22021, the driver's INT4 refusal), skipped, cursor past; a transient failure keeps the cursor |
| An event ahead of the clock waits | `edge-cases.integration.test.ts`, `poll.test.ts` | IT + unit | deferred, cursor kept, recorded by the next poll |
| Overlapping sweeps fold an alert | `edge-cases-ingest.integration.test.ts`, `breaker.integration.test.ts` | IT | two alert events of one kind at once, six rounds: no failure, one item |
| Device ids | `edge-cases-ingest.integration.test.ts` | IT | a control character → 422, never a 500; a removed and re-registered device id gets its own events |
| The read path catches `positions:` | `lib/telematics/position-read-path.test.ts` | unit | the relation include, a select of it, an event include, a raw query |
| The portal names the reading's source | `components/portal/lease/LeaseMeterReadingForm.test.tsx` | unit | "…, from the tracker." |
| Before payout: a heartbeat only (Deviation 19) | `lib/telematics/pre-payout.integration.test.ts`, `poll.test.ts` | IT + unit | an APPROVED and a CONTRACTED deal's devices are polled: heartbeats, 0 positions, 0 alerts, 0 readings, every meter LEASE_NOT_RUNNING; no deal → not polled; CANCELLED and DECLINED → polling stops |
| A reveal is audited (BR7) | `position-view.integration.test.ts` | IT | one `TELEMATICS_POSITION_VIEWED` row per reveal, with the access row id and the position id, no coordinate |
| The reveal button follows the purpose gate (BR4) | `lib/telematics/position-purpose.test.ts`, `components/asset-finance/recovery/LegalMatterPanel.test.tsx` | unit | the button only when the gate is open, the reason otherwise |
| Usage tile (BR1), narrow queue (BR2), tracker id mismatch (BR5) | `components/asset-finance/lease/lease-panels.test.tsx`, `lease-staff-data.test.ts`, `components/asset-finance/telematics/TelematicsTables.test.tsx`, `TrackerDevicesPanel.test.tsx` | unit | projected usage (not the meter) on the tile; cards with actions below md; the amber mismatch with its hint |

Mutation evidence (`evidence/slice5/MUTATIONS.md`, Part B): drop each CHECK,
partial unique and trigger branch above; drop the `ON CONFLICT` clause; drop
the role list (replace it with `"COLLECTIONS_OFFICER"`); remove the
access-log insert; remove the tenure filter; remove the retention filter in
the view; remove `assertSimulationAllowed` from the simulator. Each one must
turn a named test red.

### Build task DAG (sequential; each file ≤ 300 lines)

1. **Failing DB suites first.** Fixture and the IT files for ingest,
   meter-route, alerts, position view, purge, devices and tracker certificate.
   verify: they fail against a migrated IT DB (`it-db.sh up
   cf-it-telematics-<id>`).
2. **Schema, migrations and registries.** The new schema file, the columns,
   both migrations, the tenant-scoped/permission/audit/cron/simulated
   registries, and `npm run gen:registries`. verify: `npx prisma migrate
   deploy` and the guard-level parts of step 1 green; `npx tsc --noEmit`;
   registry snapshot tests.
3. **Adapter.** types, registry, the simulated provider and the scenario
   fixture. verify: `npx vitest run lib/telematics/providers`.
4. **Meter path.** `paceCeiling` extraction, the `ReadingActor` telematics
   arm, `routeMeterReading` and held readings. verify: meter-route and ingest
   IT, plus the existing `meter-readings.test.ts` and readings IT unchanged.
5. **Ingest, poll and alerts.** `ingestEvent`, `runTelematicsPoll` and
   `raiseAlert`. verify: ingest and alerts IT, `poll.test.ts`,
   `no-outbound.test.ts`.
6. **Position, access log and purge.** `position-view.ts` and `purge.ts`.
   verify: position-view and purge IT, `position-read-path.test.ts`.
7. **Cron routes.** verify: the cron registry/secret tests.
8. **Staff API and UI.** Device card, `TelematicsPanel`, `LastKnownPosition`
   in the Recovery and LegalMatter panels, the PayoutPanel heartbeat, the
   queue page and the settings field. verify: route tests (403/404/422),
   `dealer-refusal.test.ts`, `npm run lint`.
9. **Browser seed** `lib/telematics/telematics-browser-seed.test.ts` (how to
   run it: `evidence/slice5/browser/B/README.md`), gated by
   `TELEMATICS_BROWSER_SEED=1` (the `lease-final-browser-seed.test.ts`
   pattern). It works on an owned disposable PG and does the following:
   - books an OPERATING_LEASE (HOURS, allowance 1 500) with `shiftLease` back
     30 days and a start reading of 1 000;
   - registers `SIM-TAMPER-0001` installed 30 days ago, plus `SIM-ROLLBACK-0002`
     on a second lease and `SIM-STEADY-0003` on an instalment sale;
   - creates a COLLECTIONS_OFFICER, a READONLY user and a dealer user (demo
     lender, portal on);
   - writes the logins to a local file (`/tmp/cf-telematics-browser.json`,
     mode 600; `TELEMATICS_BROWSER_SEED_OUT` overrides).

   verify: running it twice on fresh DBs gives the same rows.
10. **Docs.** `lib/telematics/.claude.md` (summary line), a
    `lib/asset-finance/.claude.md` line about the TELEMATICS source,
    DEPLOY-ENV.md (the two crons; `simulated-telematics` in
    `SIMULATED_INTEGRATIONS` for demo stacks only), DESIGN.md slice 5 status,
    and `npm run agents:mirror`. verify: `npm run claude-md:check && npm run
    agents:check`.
11. **Gates.** `npm run ci:full` in a fresh clone, the mutations, and the
    browser acceptance (§5 B) with `curl -H "x-cron-secret: …"
    /api/cron/asset-finance-telematics-poll`. Screenshots go in
    `evidence/slice5/browser/B/`:
    - the device card with heartbeat and the simulated chip;
    - the PayoutPanel heartbeat beside the certificate requirement;
    - the readings table with TELEMATICS rows and the projected excess;
    - the held ROLLBACK reading and its reject;
    - the TAMPER work item;
    - after a matter is opened, the Recovery and LegalMatter panels revealing
      the last position with its time;
    - READONLY with no button and an API 403;
    - the dealer getting a 404;
    - 0 page errors.

### Known limitations

- **No void path for a TELEMATICS reading.** A written tracker reading is
  immutable like every meter reading; staff cannot void or supersede one.
  Meter verification (Deviation 16) keeps an offset real device out, and
  held readings are decided before they are written, but a verified device
  that later drifts can still floor the staff final reading. A void or
  supersede action is counsel item 6.
- **Per-tenant provider credentials (A6).** `provider.poll()` takes no tenant
  credentials; a real adapter would need per-lender keys from the vault before
  it can poll more than one lender's devices.
- **DSAR for telematics data is manual.** Positions, events and the access log
  are not in the DSAR export or erasure flow; an operator answers a request
  by hand (DELETE of a position is allowed). Counsel item 5.
- **No start reading, no ceiling.** With no meter reading on the lease, neither
  `paceCeiling` nor `telematicsPaceCeiling` applies, so an unattended reading
  is recorded whatever its size. Booking always writes the start reading, so
  this is reachable only by deleting it with the triggers off
  (`edge-cases.integration.test.ts` pins the behaviour).
- **No movement trail.** Only the latest position per device is kept
  (Deviation 15); a theft trail or an affidavit of movements cannot be
  produced. Counsel item 3.
- **Meter verification is one-way.** It cannot be undone or redone on the same
  device; a device whose meter is replaced is removed and registered again.
- **The alert queue is fixed at raise time.** An alert raised before a matter
  opens stays in its queue.
- **Polling only:** no provider webhook.

### Review items

- **Legal (POPIA / NCA): counsel sign-off items 1 to 10** (the legal review of
  PR #222). None is decided in code; each needs the lender's counsel before a
  real provider or real borrowers.
  1. **Lawful basis and disclosure.** Tracking location needs a lawful basis
     under the agreement and disclosure in the lender-owned templates (#183)
     and the s18 POPIA notice. No template wording is changed here.
  2. **Purpose gate.** The position is shown for default, an open recovery or
     an open legal matter only (Deviation 3). Is that right, and is a THEFT
     purpose needed (an asset stolen from a borrower in good standing)?
  3. **Retention and the trail.** 90 days by default (1 to 365), and only the
     latest position per device (Deviation 15). Is the latest position
     enough, or does a theft or affidavit trail need a counsel decision?
  4. **Drivers of juristic borrowers.** An entity's asset is driven by
     employees: are they data subjects whose location is processed, and what
     notice do they get?
  5. **DSAR for telematics data.** Access, correction and erasure of events,
     positions and the access log (manual today).
  6. **Excess billing from device readings.** Unattended readings feed the
     projected excess and the end-of-term billing; the lessee's right to
     dispute a device reading, and whether staff need a void or supersede
     path (Known limitations).
  7. **Collections handling of alerts.** A tamper or geofence alert must not
     lead to self-help repossession: s129, s130 and s131 still govern; the
     SERVICING queue keeps a loan in good standing out of collections.
  8. **Device removal and collection stop at closure.** Collection stops when
     the agreement ends (Deviation 14), but the device stays on the asset:
     who removes it, and is the borrower told?
  9. **Operator agreement with a real provider.** A POPIA s21 operator
     agreement, and s72 for any cross-border transfer of location data.
  10. **s57 prior authorisation.** Whether processing location information
      for credit purposes needs the Information Regulator's prior
      authorisation.
- **Security / policy-breaker.**
  - Any path that returns coordinates without an access row.
  - INSURANCE_OFFICER, READONLY, DEALER or operator reaching the position.
  - Cross-tenant device or event injection through the provider id map.
  - Forged `providerEventId` collisions across providers (the key includes
    the provider).
  - The `SIMULATED_INTEGRATIONS` allow-list on deployed demo stacks.
- **Open risks.**
  - **Device meter offset.** Addressed for real providers by meter
    verification (Deviation 16); an offset that appears after verification is
    a Known limitation (no void path).
  - Simulated readings feed the projected excess on the demo stacks
    (labelled); a simulated device needs no verification.
  - Purge batches are per tenant in one process, as with the lender-API
    retention.

### Built (PR B): what changed against this spec while building

- Migrations renamed to `20261020160000_telematics_enum_values` and
  `20261020160100_telematics`; the registry file numbers (250, 070, 430, 140,
  050) were free.
- The PR A carry-overs already on the branch: the breaker's
  `dealer-entity-link-attacks` IT (committed in #216, gated by
  `RUN_ASSET_FINANCE_DEALER_IT`), the capture pre-check's NULL arm (#216
  0aea36c0) and the section129 note in `lib/notifications.ts` (same commit).
  This PR adds the website identity-notice IT's `noticeWithheld` assertion and
  its verified positive control.
- `TelematicsEvent`'s provider-event-id length is its own CHECK; the event
  guard also keeps `meterOutcome` consistent with what was written; the alert
  guard fixes the first occurrence; the access-log guard checks the loan,
  asset and device agree (all above).
- A meter in another unit than the lease's is `NO_USAGE_TERMS`, not written
  (the binding check would refuse it).
- Malformed provider events are skipped and counted; a device whose event
  failed keeps its cursor.
- `purgeTelematicsPositions()` uses the database's clock and covers every
  tenant with a device.
- The retention parser takes any whole number; the CHECK is the bound, mapped
  to 422.
- The browser seed marks the lender as a demo lender after the bookings: its
  templates were approved as the lender's own (`LENDER_LEGAL`), which a demo
  lender's documents refuse.

Review round 1 (PR #222, legal, architecture, breaker, code, edge and test
reviews): Deviations 3 and 7 changed and 14 to 18 added (above), the round-1
rows of the rule-to-test matrix, Known limitations and the counsel items. The
migrations were edited in place (never applied to a shared database). One
choice beyond the review decisions, approved by the team lead: the poll also
takes a device on an asset whose deal awaits payout (Deviation 19), so the
payout panel's heartbeat keeps working before booking. A WITHDRAWN recovery
does not end the tenure (the asset went back to the borrower). The browser
review's findings BR1 to BR8 are in "Pages and components", Deviation 10, the
matrix and `evidence/slice5/browser/B/README.md` (the seed's second state,
the auth settings and the in-process scheduler).


## Part C — Valuation guides

Specified in PR C.
