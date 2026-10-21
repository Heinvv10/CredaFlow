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

## Part B — Telematics

Specified in PR B.

## Part C — Valuation guides

A lender loads a dated valuation guide (make, model, year, variant → trade and
retail value). A second admin publishes it. Deals, the book and recoveries
then read values from it. A guide value is a reference: it never counts as an
independent valuation.

### Deviations from the goal's defaults (and why)

1. **A provider is a guide source, not a live lookup.** `ValuationProvider`
   reads a whole guide (`readGuide`), which is stored as a DRAFT
   `ValuationGuide` and published by a second admin, as the SARB feed's values
   wait for a person's approval. Every lookup then reads published guide rows,
   whatever the provider. A GUIDE valuation therefore always names a guide row
   that two people put live. Two providers ship: `csv` (the upload) and
   `synthetic` (fixture rows, for tests and demo stacks). A future feed
   (an auto or plant guide API) is a third provider that fills a draft the
   same way. The synthetic provider is a simulated integration
   (`simulated-valuation-guide`): refused on a deployed build unless
   `SIMULATED_INTEGRATIONS` names it. Its guides carry `simulated = true` and
   show a "Simulated" label wherever their values appear.
2. **`purchaseValuationOk` needs no change.** It already admits only
   `source IN ('ASSESSOR', 'DEALER')`, and so do the purchase re-base clause and
   the TS check (`MARKET_VALUATION_SOURCES`). A real-PG test proves that a
   GUIDE valuation is refused for a lease purchase. Only the recovery-sale rule
   (`guardRemarketingSale`, three `<> 'INTERNAL'` clauses) and its TS mirror
   (`valuationFacts`, `loadSaleValuations`) change to
   `NOT IN ('INTERNAL', 'GUIDE')`.
3. **A GUIDE valuation's amount is the trade value.** Trade is the
   conservative figure (what a forced sale realises). The row snapshot keeps
   both values, and the deal panel shows the LTV against each.
4. **Guide values are VAT-inclusive**, as the guide states them. The deal's
   advance is the goods advance: cash price incl. VAT less deposit and
   trade-in (Part A's commission base), the same formula for a lease. LTV =
   advance ÷ guide value.
5. **The book revaluation report reads and never writes.** It values each
   live asset-finance loan's asset against the current guides: on the
   variant of the asset's latest GUIDE valuation if one exists, else on the
   only matching row. With several candidate variants it says how many and
   links to the asset. LTV (outstanding ÷ trade) is shown only for
   instalment-sale loans: a lease's outstanding balance is its remaining
   rentals, not capital. Staff record a dated GUIDE valuation on the deal or
   asset page.
6. **Recovery: a reference only, and GUIDE refused as a statutory
   valuation until counsel decides.** The recovery panel shows the asset's
   latest guide value labelled "not an independent valuation". Whether a guide
   value may serve as the NCA s127(3)/s131 estimate is an open legal item, so
   the database fails closed (review round 1): `guardSurrenderRequest` refuses
   a GUIDE valuation as an s127 surrender's valuation, and `guardRecovery`
   refuses one as any recovery's VALUED valuation (NCA and non-NCA alike).
   Migration `20261021090200` patches both in place (DO blocks, as
   `20261018110000` does), so every sibling migration's rules stay. The
   manual valuation routes never accept `GUIDE` either: `VALUATION_SOURCES`
   leaves it out and the database requires a guide row for it.
7. **The file itself is not kept.** The rows are the guide. `fileSha256` is
   recorded, and the same bytes cannot be loaded twice while a DRAFT or
   PUBLISHED guide carries them. The synthetic provider's sha256 is the hash of
   its canonical rows plus the effective date.
8. **Publishing rules.** A guide is published only on or after its effective
   date, never dated before the guide of the same name it replaces, and it
   replaces that guide (SUPERSEDED) in the same transaction. A DRAFT may be
   discarded by any `manage_valuation_guides` user, the uploader included.
9. **A GUIDE valuation is dated today**, valued on a guide in force (PUBLISHED,
   effective on or before today), for a row whose make, model and year are the
   asset's (case-insensitive, trimmed). The variant is the user's choice
   among the matching rows.

Review round 1 (PR #229; migration `20261021090300_valuation_guide_review_fixes`,
additive, and `20261021090200` edited in place before any shared database
applied it):

10. **GUIDE is refused as a statutory valuation** (deviation 6), in the
    database, until counsel decides.
11. **A supersede always leaves a current guide.** The successor is another
    guide of the same name, dated on or after it, that is a DRAFT put live in
    the same transaction; at commit it is PUBLISHED (the deferred check no
    longer accepts a SUPERSEDED successor). No self-supersede, no cycle.
12. **The database dates every move** (`uploadedAt` on insert, `publishedAt`,
    `discardedAt`, `supersededAt` on the move; a caller's value is replaced
    by `clock_timestamp()`, not the transaction-start `now()`, review round 2),
    with `ValuationGuide_times` behind it; a residual clock race with a rival
    publish is mapped to the 409 `concurrent_publish`. A synthetic-provider
    guide is always stored simulated (`ValuationGuide_synthetic_simulated`).
13. **One case fold.** The store re-checks a file's rows with `lower()` before
    it writes (`case-fold.ts`): a clash the JS reader missed is a 422 with line
    reasons, audited. The revaluation's matching moved into its SQL, so it
    agrees with the asset page.
14. **Smaller.** The lease purchase picker offers ASSESSOR and DEALER
    valuations only. The upload's body is counted as it arrives and refused
    over 5 MB (plus 64 KB for the envelope) before it is parsed. The rows
    page clamps `?offset`. The recovery-sale refusal says guide values do not
    count. A record or publish that crosses SAST midnight is a 409, not a
    500. The manual valuation form reuses the label map.

### Data (prisma/schema/asset-finance-valuation-guides.prisma, new file)

Three migrations, hand-written below the generated DDL:
`20261021090000_valuation_guide_enum_values` (only
`ALTER TYPE "ValuationSource" ADD VALUE 'GUIDE'`, which must commit before
use), `20261021090100_valuation_guides` (tables, columns, rules, RLS) and
`20261021090200_guide_not_independent` (`guardRemarketingSale` replaced; the
only change is the three source clauses). Tenant-scoped like Part A: `tenantId`,
`@@unique([tenantId, id])`, composite FKs, listed in
`lib/registry/tenant-scoped-models/260-valuation-guides.ts`, RLS
`tenant_isolation`, `_no_truncate` on every guarded table, errors `23514`.

```prisma
enum ValuationGuideStatus { DRAFT PUBLISHED SUPERSEDED DISCARDED }

model ValuationGuide {     // name, effectiveOn @db.Date, provider, simulated, fileSha256, rowCount, status,
                           // uploadedById (→ User), uploadedAt, publishedById? (→ User), publishedAt?,
                           // supersededById? (→ ValuationGuide), supersededAt?, discardedById? (→ User), discardedAt?
}
model ValuationGuideRow {  // guideId, lineNumber, make, model, year, variant @default(""), tradeCents, retailCents;
                           // @@unique([tenantId, guideId, id]) for the valuation's composite FK
}
```

`AssetValuation` gains `guideId?`, `guideRowId?`, `guideSnapshot Json?`: FK
`(tenantId, guideId)` → `ValuationGuide`, FK `(tenantId, guideId, guideRowId)`
→ `ValuationGuideRow(tenantId, guideId, id)`. A valuation can only name a row of
its own guide, and only in its own tenant.

#### CHECKs and indexes

- `ValuationGuide_name`: 1–100 characters, trimmed, not blank.
  `_provider`: `^[a-z0-9-]{1,40}$`. `_sha256`: `^[0-9a-f]{64}$`.
  `_row_count`: 1–20 000.
- `ValuationGuide_status_shape`: DRAFT has no publish, supersede or discard
  fields. PUBLISHED has publish fields only. SUPERSEDED has publish and
  supersede fields. DISCARDED has discard fields only.
- `ValuationGuide_four_eyes`: `"publishedById" IS NULL OR "publishedById" <> "uploadedById"`.
- `ValuationGuide_one_current_per_name`: unique `(tenantId, lower(name))` (the name CHECK keeps it trimmed)
  WHERE PUBLISHED. `ValuationGuide_live_file`: unique `(tenantId, fileSha256)`
  WHERE DRAFT or PUBLISHED.
- `ValuationGuideRow_text`: make and model 1–100 characters, trimmed, not
  blank; variant ≤ 100, trimmed. `_year`: 1950–2100 (as `FinancedAsset`).
  `_amounts`: `0 < tradeCents <= retailCents`. `_line`: `lineNumber >= 2`.
  `ValuationGuideRow_key`: unique `(tenantId, guideId, lower(make), lower(model), year, lower(variant))`.
- `AssetValuation_guide_shape`: `("source" = 'GUIDE') = ("guideId" IS NOT NULL)`,
  and `guideId`, `guideRowId`, `guideSnapshot` all set or all NULL.

#### Triggers

- `guardValuationGuide` (BEFORE INSERT/UPDATE/DELETE, `_no_truncate`):
  - INSERT: DRAFT only.
  - UPDATE: name, effective date, provider, simulated, sha256, row count,
    uploader and upload time never change. The only moves are:
    - DRAFT → PUBLISHED: the live row count equals `rowCount`, and
      `effectiveOn` ≤ today.
    - DRAFT → DISCARDED.
    - PUBLISHED → SUPERSEDED: the successor is another guide of the same
      tenant and name, dated on or after this one.
  - Anything else is refused. A published guide is immutable.
  - DELETE is refused.
- `ValuationGuide_successor_published` (DEFERRABLE INITIALLY DEFERRED): at
  commit, a SUPERSEDED guide's successor is PUBLISHED (or itself SUPERSEDED).
  No one can take a guide down without putting its replacement live.
- `guardValuationGuideRow`: INSERT only while the guide is DRAFT;
  UPDATE/DELETE/TRUNCATE refused.
- `guardAssetValuationGuide` (BEFORE INSERT ON `AssetValuation`, beside
  the existing `guardAssetValuation`): a GUIDE row's guide is PUBLISHED and
  effective by `valuedOn`. `valuedOn` is today. The guide row's make, model and
  year are the asset's. `amountCents` is the row's trade value. The caller
  passes no snapshot: the trigger writes `guideSnapshot` (guide id, name,
  effective date, provider, simulated; row make, model, year, variant, trade,
  retail, line).
- `guardRemarketingSale`: `NOT IN ('INTERNAL', 'GUIDE')` in the sale's
  valuation check, the highest current independent valuation and the
  self-valued tie check.

### Library (`lib/valuation-guides/`)

- `types.ts`: `ValuationProvider { id, label, simulated, assertUsable(),
  readGuide({ bytes?, effectiveOn }) → { ok: true, rows, sha256 } | { ok:
  false, problems: { line, reason }[] } }`.
- `csv.ts`: a strict RFC 4180 reader plus validation. Header exactly
  `make,model,year,variant,trade_cents,retail_cents`; UTF-8, an optional BOM;
  CRLF or LF. Quoted fields are allowed; a stray quote, a short or long row, or
  an empty file is refused. Money is integer cents (digits only, ≤ 2 147 483 647).
  Year 1950–2100. Make and model are required, ≤ 100 characters; variant
  ≤ 100. Trade must be ≤ retail and both > 0. A cell starting with `=`, `+`, `-`
  or `@` is refused (spreadsheet formula). A duplicate key
  (case-insensitive make, model, year, variant) is refused with both line
  numbers. At most 20 000 rows and 5 MB. Every problem is reported (the first
  200 shown, with the total). Nothing is stored unless the whole file is
  clean.
- `providers/csv-guide.ts`, `providers/synthetic.ts`, `registry.ts`
  (map registry like `lib/telematics/registry.ts`).
- `guide-store.ts`: `createDraftGuide`, `publishGuide` (locks the guide,
  refuses self-publish before the CHECK does, supersedes the current guide of
  that name, then publishes), `discardGuide`. Audited `VALUATION_GUIDE_*`.
- `lookup.ts`: `guideCandidates(tenantId, asset, today)` and
  `recordGuideValuation(actor, assetId, guideRowId)`, audited
  `ASSET_GUIDE_VALUATION_RECORDED`.
- `ltv.ts`: goods advance and LTV, as basis points rounded half-up.
- `revaluation.ts`: the report rows.

### Routes and pages

Staff, house pattern (`requireApiRole` → `withTenantContext` →
`requireAssetFinanceEnabled` → `canDo`); a miss in the tenant is 404:

- `GET/POST /api/asset-finance/valuation-guides`. POST is multipart (`name`,
  `effectiveOn`, `provider` default `csv`, `file` for csv) and needs
  `manage_valuation_guides`. A malformed file gets 422
  `{ problems, total }`, nothing is stored, and the refusal is audited
  `VALUATION_GUIDE_UPLOAD_REFUSED` (counts, never cell values).
- `POST …/valuation-guides/[id]/publish | discard` (`manage_valuation_guides`).
  A self-publish gets 403, audited `VALUATION_GUIDE_PUBLISH_REFUSED`. A guide
  that is not a DRAFT gets 409.
- `GET/POST /api/asset-finance/assets/[id]/guide-valuations`: GET is the
  candidates (READONLY+); POST `{ guideRowId }` (`manage_asset_finance`)
  records the valuation.
- Pages:
  - `(dashboard)/asset-finance/valuation-guides`: list, upload form and
    publish/discard.
  - `valuation-guides/[id]`: the rows, so the publisher sees what they put
    live.
  - `valuation-guides/revaluation`: the report.
  - A "Guide value" panel on the deal page and the asset page: candidates,
    record, and the latest guide valuation with advance and LTV.
  - A "Guide reference" line on the recovery panel.
  - Navigation entry "Valuation guides".
- Permissions (`lib/registry/permissions/080-valuation-guides.ts`):
  `manage_valuation_guides: "LOAN_ADMIN"`. Audit actions
  (`lib/registry/audit-actions/440-valuation-guides.ts`):
  - `VALUATION_GUIDE_UPLOADED`
  - `VALUATION_GUIDE_UPLOAD_REFUSED`
  - `VALUATION_GUIDE_PUBLISHED`
  - `VALUATION_GUIDE_PUBLISH_REFUSED`
  - `VALUATION_GUIDE_DISCARDED`
  - `ASSET_GUIDE_VALUATION_RECORDED`

  Simulated integration (`lib/registry/simulated-integrations/060-valuation-guides.ts`):
  `simulated-valuation-guide`. No cron, no env.

### Rule-to-test matrix (IT = `RUN_ASSET_FINANCE_VALUATION_IT`)

| Rule | Test file | Kind | Negative cases (§3 C) |
|---|---|---|---|
| Strict CSV, per-row reasons | `lib/valuation-guides/csv.test.ts` | unit | bad header, stray quote, short row, decimals, separators, year range, trade > retail, formula cell, duplicate key, empty, BOM |
| Malformed upload stores nothing, audited | `lib/valuation-guides/guide-routes.integration.test.ts` | IT | 422 with line reasons; no guide row; refusal audit |
| Four-eyes publish | `guide-rules.integration.test.ts` (CHECK), `guide-routes.integration.test.ts` (route) | IT | self-publish (DB and 403 + audit) |
| Published guide immutable; rows only in DRAFT | `guide-rules.integration.test.ts` | IT | rename, re-date, re-count a PUBLISHED guide; row insert/update/delete on it; DELETE/TRUNCATE |
| Status matrix and publish conditions | `guide-rules.integration.test.ts` | IT | publish with a missing row; publish before the effective date; DISCARDED → PUBLISHED; SUPERSEDED → PUBLISHED |
| One current guide per name; successor live at commit | `guide-rules.integration.test.ts` | IT | two PUBLISHED with the same name; superseded by a draft never published; superseded by an older guide |
| Same file twice while live | `guide-rules.integration.test.ts` | IT | DRAFT with a PUBLISHED guide's sha |
| Row CHECKs and key | `guide-rules.integration.test.ts` | IT | trade > retail, zero, blank make, duplicate key |
| GUIDE valuation shape and trigger | `guide-valuation.integration.test.ts` | IT | GUIDE without a guide; a guide on a DEALER row; DRAFT or SUPERSEDED guide; another guide's row; another asset's make; amount ≠ trade; caller snapshot; backdated |
| Cross-tenant guide use | `guide-valuation.integration.test.ts` (FK), `guide-routes.integration.test.ts` (404) | IT | other tenant's guide or row on a valuation; publish/discard/record across tenants |
| GUIDE is not independent: lease purchase | `lib/valuation-guides/not-independent.integration.test.ts` | IT | purchase election on a GUIDE valuation (DB, and `electEndOfTerm`) |
| GUIDE is not independent: recovery sale | `not-independent.integration.test.ts` | IT | sale on a GUIDE valuation; a GUIDE above the highest independent one does not raise `highestValuationCents`; `valuationFacts` refuses; `loadSaleValuations` leaves it out |
| Manual route never records GUIDE | `lib/asset-finance/asset-input.test.ts` | unit | `source: "GUIDE"` |
| Synthetic provider gated; registry | `lib/valuation-guides/providers/providers.test.ts` | unit | deployed build refused; allowed when listed |
| LTV and advance | `lib/valuation-guides/ltv.test.ts` | unit | lease, deposit and trade-in, rounding |
| Revaluation matching | `lib/valuation-guides/revaluation.test.ts` | unit | several variants; recorded variant; no match; lease LTV hidden |
| Sale guard's three clauses; TRUNCATE, deferred and index objects present | `lib/valuation-guides/migration.test.ts` | static | — |
| Panels: LTV, simulated label, no write control for a reader; recovery reference | `components/asset-finance/valuation-guides/GuideValuePanel.test.tsx`, `components/asset-finance/recovery/RecoveryPanel.test.tsx` | unit | — |
| Revaluation loader (SQL): live loans only, current guide only, newest guide value's variant, lower() matching | `lib/valuation-guides/revaluation-store.integration.test.ts`, `not-independent.integration.test.ts` | IT | COMPLETED, WRITTEN_OFF, CANCELLED loans; a superseded guide's rows; an older guide value's variant |
| GUIDE never a statutory valuation (round 1) | `lib/valuation-guides/guide-statutory.integration.test.ts` | IT | s127 surrender VALUED, NCA s131 and non-NCA recovery VALUED on a GUIDE valuation |
| Supersede: by a draft put live in the same transaction (round 1) | `guide-gaps.integration.test.ts`, `guide-breaker.integration.test.ts` (B1) | IT | self-supersede; equal-dated mutual supersede (cycle); no current guide left |
| Move columns and times (round 1) | `guide-gaps.integration.test.ts`, `guide-breaker.integration.test.ts` (B3) | IT | a publish rewriting uploader, upload time, source, simulated flag, file, date; a discard renaming; a supersede rewriting the publisher; a caller's move time (replaced by the clock; `ValuationGuide_times` behind it) |
| Guide CHECKs (round 1) | `guide-gaps.integration.test.ts`, `guide-breaker.integration.test.ts` (B2) | IT | name, provider, sha256, row count, status shape, line key, synthetic ⇒ simulated, times |
| GUIDE trigger: make and year, snapshot simulated flag (round 1) | `guide-gaps.integration.test.ts` | IT | another make, another year |
| TRUNCATE refused on both guide tables (round 1) | `guide-gaps.integration.test.ts` | IT | TRUNCATE with the FKs into them taken out |
| Publish route refusals and upload cap (round 1) | `guide-gaps-routes.integration.test.ts`, `upload-body.test.ts` | IT + unit | not yet effective, older than current, simulated on a deployed build (all 409); a 6 MB upload (422, never buffered whole) |
| Case folding (round 1) | `edge-unicode.integration.test.ts`, `guide-breaker.integration.test.ts` (B4) | IT | İsuzu/Isuzu (lower() clash: 422 with line reasons, audited); ΑΣ/ας (JS clash: a known false refusal) |
| Midnight race (round 1) | `guide-midnight.integration.test.ts` | IT | record and publish across SAST midnight: 409, nothing written |
| Purchase picker offers market valuations only (round 1) | `components/asset-finance/lease/lease-panel.test.tsx` | unit | GUIDE and INTERNAL never offered |
| Races and flows (round 1) | `guide-concurrency.integration.test.ts`, `edge-flows.integration.test.ts`, `guide-breaker.integration.test.ts` (B5–B7) | IT | concurrent publish; the same file at once; same-day supersede; older-dated; discard then reload; a 20 000-row guide |
| Rows page offset | `lib/valuation-guides/guide-view.test.ts` | unit | negative, fractional, `1e21`, past the last row |
| Move times by the clock; a residual race is a 409 (round 2) | `lib/valuation-guides/guide-breaker-r2.integration.test.ts` | IT | a publish whose transaction began before a rival's publish committed; a rival's publish time after this supersede |
| Revaluation keeps the recorded guide's name and variant (round 2) | `revaluation-store.integration.test.ts` | IT | another guide with the same variant; another variant of the same guide; a newer DEALER valuation |
| Statutory guards keep the GUIDE clause; the 409 sentences match the guards (round 2) | `lib/valuation-guides/migration.test.ts` | static | a later migration rewriting `guardRecovery`/`guardSurrenderRequest` without it; a reworded guard sentence |
| Read side: candidates, newest guide value, panel LTV, recovery reference (round 1) | `lib/valuation-guides/loaders.integration.test.ts` | IT | another make or year with the same model; an older value; another tenant's asset; trade/retail swapped; the simulated label |
| Simulation gate at record time (round 1) | `guide-gaps-routes.integration.test.ts` | IT | a simulated guide's value recorded on a deployed build |
| Browser seed shape | `lib/valuation-guides/valuation-browser-seed.test.ts` (`VALUATION_BROWSER_SEED=1`) | seed | — |
| RLS on the two models | existing `RUN_TENANT_ISOLATION_IT` catalog test | IT | — |

Mutation evidence (`evidence/slice5/MUTATIONS.md`, Part C): the database suites
use the slice 4 `refuses(rule, …)` proof. Each refusal is shown again with that
one clause, CHECK, index or trigger taken out, inside a rolled-back
transaction. TS gates are mutated by hand, and the named test must turn red.

### Build task DAG (each file ≤ 300 lines)

1. Spec and matrix (this section).
2. Failing suites: CSV unit tests and the three ITs against a database
   without the migrations. verify: red for the missing schema.
3. Schema, the three migrations, registries, `npm run gen:registries`.
   verify: the ITs are green on `it-db.sh`; tsc.
4. Library: providers, store, lookup, LTV, revaluation. verify: unit and IT.
5. Routes and pages. verify: the routes IT, lint.
6. The TS mirror of "independent" (`recovery-sale.ts`, `recovery-panel-data.ts`).
   verify: `not-independent` IT, recovery suites.
7. Browser seed and README (`evidence/slice5/browser/C/`). verify: two seeds
   on fresh databases give the same shape.
8. Docs (`lib/valuation-guides/.claude.md`, DESIGN.md slice 5 status) and
   `agents:mirror`. verify: `claude-md:check`, `agents:check`.
9. Gates: `ci:full` in a fresh clone, then mutations.

### Known limitations

- **Matching is textual.** A guide row matches an asset on make, model and
  year as typed (case and outer spaces ignored). "Toyota" and "TOYOTA SA" do
  not match. There is no make/model code (such as an M&M code) on the asset.
- **The variant is chosen by staff.** The asset carries no variant, so a
  wrong choice values the wrong variant. The chosen row is snapshotted and
  audited.
- **No staleness rule.** A published guide stays current until a newer guide
  of the same name replaces it. The panels show its effective date.
- **The uploaded file is not kept** (deviation 7).
- **Inner whitespace is not folded.** "320  GC" does not match "320 GC"; only
  case and outer spaces are ignored (`edge-flows.integration.test.ts`).
- **One case fold, PostgreSQL's.** Every match (asset page, deal panel,
  recording, revaluation) and the row key use `lower()`. The CSV reader's own
  duplicate check uses JS `toLowerCase()` first, so a pair JS folds together
  but `lower()` keeps apart (Greek final sigma: "ΑΣ" and "ας") is refused as a
  duplicate: a known false refusal. The reverse (İ) is caught by the store's
  `lower()` re-check (`case-fold.ts`) as a 422 with line reasons.
- **Four-eyes in the database checks the people, not their permission.**
  `ValuationGuide_four_eyes` refuses the uploader as publisher; that the
  publisher holds `manage_valuation_guides` is the route's check (`canDo`), as
  for the other four-eyes CHECKs in this codebase.
- **Only the self-publish and malformed-upload refusals are audited.** A 403
  for a missing permission and a 409 (not a DRAFT, not yet effective, older
  than current, simulated) write no audit row, as elsewhere in the repo.
- **The book revaluation is unbounded** (every live loan on one page), and its
  LTV is outstanding principal over trade: no interest, fees or arrears. Its
  Outstanding column says per row what the figure is: an instalment sale's
  principal, a lease's remaining rentals incl. VAT.
- **The simulation gate is the app's, not the database's.** Whether a
  deployment may use a simulated integration is a property of the app
  process's environment (`NODE_ENV`, `SIMULATED_INTEGRATIONS`), which the
  database cannot read; every simulated integration here (bureau, payouts,
  collections, telematics) is gated the same way, in TS, at the moment of use.
  For guides that is load (`providers.test.ts`), publish and record
  (`guide-gaps-routes.integration.test.ts`). The database keeps the label
  honest instead: a synthetic guide is always `simulated`, the flag never
  changes after load, and every GUIDE valuation snapshots it, so the
  "Simulated" label follows the value wherever it is shown.
- **A rollback past this part breaks once a GUIDE row exists**: an older
  image's Prisma client cannot read the enum value (handoff note).

### Review items

- **Legal:** whether a published guide value may stand as the NCA
  s127(3)/s131 estimated value of goods. Until counsel decides, the database
  refuses a GUIDE valuation as an s127 surrender's or any recovery's
  valuation (deviation 6). If counsel allows it, settle the VAT basis first:
  a GUIDE amount is VAT-inclusive (deviation 4), while the lease purchase
  path reads a valuation's amount as excl. VAT. Licensing terms of a
  commercial guide the lender loads: the system stores the rows in the
  lender's database.
- **Credit policy:** the trade-value basis for a guide valuation's amount, and
  the LTV thresholds the lender applies (none are enforced; the panel only
  displays).
