# KE (Kenya) demo plan: third jurisdiction, demo-first

Base: origin/main b088f98b. Goal: a browser walk of a Kenyan demo lender on a fresh local DB seeded with
`DEMO_LENDER=nairobi`, in the same shape as the LS walk (.claude/handoffs/2026-11-02-lpb-build-done.md).
ZA must not change (NCA fingerprints stay as pinned) and LS keeps working. KE facts are DRAFT until the
lender's Kenyan counsel confirms them; every unconfirmed fact gets a comment that says UNVERIFIED.

## What already works for KE without changes
- Non-NCA document path: the trigger at prisma/migrations/20261030090000_non_nca_documents/migration.sql:914
  stamps `KEY_FACTS` for any instance other than ZA, so a KE lender gets the offer letter, key facts
  statement (KFS), loan agreement and arrears letter through lib/non-nca-documents.
  The KFS must be acknowledged before the contract (pre-submission.ts), which already covers "KFS before contract".
- NCA gates: `isNcaJurisdiction()` reads `profile.ncaRegulated` (lib/jurisdiction/active.ts:69), so KE
  with `ncaRegulated:false` skips the rate cap, s129 and NCR returns. NCA PDFs refuse to render without an
  NCR number, and the KE identity has none.
- Instant approval's SQL guard tests `= 'ZA'` (20261105090000_key_facts_instant_approval:123). That holds for KE.
- Payout is MANUAL for KEY_FACTS (lib/non-nca-documents/disburse.ts:6). For the demo an M-Pesa transaction
  code goes in as the bank reference; `manualBankRef` (payout-terms.ts) accepts it.

## Traps found (each slice must handle its own)
1. lib/jurisdiction/business-days.ts:51-55 treats every jurisdiction that is not ZA as Lesotho. KE would
   silently get Lesotho holidays.
2. lib/validation/client-wizard.ts:105,120 fall back to the SA ID check for any scheme that is not LS_ID. A KE ID
   would be run through SA Luhn.
3. lib/contact/identity.ts:52 turns any 10-digit `0…` number into `27…`. A Kenyan "0712345678" becomes the SA
   number 27712345678 and gets no 254 identity. lib/whatsapp.ts:55 has the same bug.
4. The currency-to-jurisdiction rule exists in three places: active.ts:41, instance-write.ts:34, and two SQL CHECKs.
5. Time zone: the whole system is pinned to SAST (UTC+2) and `profile.timeZone` is data only. Nairobi is
   UTC+3, so between 00:00 and 01:00 EAT the system's date is still yesterday. For the demo we document this
   and do not fix it; run the demo in business hours.
6. `npm run seed` also runs seed-staging.ts, which knows nothing about jurisdiction. Use `npm run seed:base`.

## Slices and waves
Wave 1, in parallel: KE-0 and KE-2. Wave 2, in parallel after KE-0: KE-1 and KE-4.
Wave 3: KE-3 (needs KE-1 and KE-2). Wave 4: KE-5 (the walk). Stretch: KE-6 and KE-7.
Reserved migration timestamps (all after main's 20261107110000):
- KE-0: 20261108090000, 20261108090100
- KE-3: 20261108100000
- KE-4: 20261108110000, 20261108110100

---
### KE-0 Foundation: the KE jurisdiction, KES, capture rules, holidays, DB (blocks KE-1/3/4/5)
Files:
- lib/jurisdiction/profiles.ts:
  - Add "KE" to `JURISDICTIONS` (l.7) and "KES" to `CURRENCIES` (l.10).
  - Add the profile entry: idScheme `"KE_ID"`, defaultCurrency KES, timeZone Africa/Nairobi, label EAT,
    ncaRegulated false.
  - Add `allowedCurrencies` to every profile (ZA [ZAR], LS [LSL, ZAR], KE [KES]) and a `currencyAllowed(j, c)`
    helper. Copy the LS entry at l.105-124.
  - KE capture rules:
    - ID is numeric, idMaxLength 9, idEncodesDob false.
    - Mobile patterns `^\+254(7\d{8}|1[01]\d{7})$` and `^0(7\d{8}|1[01]\d{7})$`, with mobileAllowSpaces.
    - regionLabel "County", the 47 counties with the official codes 001-047.
    - postalDigits 5.
- lib/jurisdiction/active.ts:41 and lib/jurisdiction/instance-write.ts:34: call `currencyAllowed`. The ZA
  error strings stay word for word, because tests pin them.
- lib/jurisdiction/money.ts:11: KES symbol "KSh", which prints as "KSh 1,234.56".
- lib/jurisdiction/national-id.ts: KE shape-only check `^\d{8,9}$` (old 8-digit ID or 9-digit Maisha Namba).
  Copy the LS block at l.1-27 with its UNCONFIRMED header and a `KENYA_ID_SHAPE_ONLY` flag. Canonical form
  is trimmed with spaces removed.
- lib/validation/client-wizard.ts:105,120: replace the LS-or-SA ternaries with a `switch(idScheme)` that
  has an exhaustive `never` default.
- lib/jurisdiction/business-days.ts:
  - Add `kenyaPublicHolidays(year)`: 01-01, 05-01, 06-01, 10-10, 10-20, 12-12, 12-25, 12-26, plus Good Friday
    and Easter Monday. A holiday on a Sunday moves to Monday.
  - Add Eid al-Fitr from a per-year table, gazette-dependent and marked UNVERIFIED.
  - Dispatch through `holidaysFor(j, year)` so LS keeps its own list (fixes trap 1). Copy l.36-48.
- lib/jurisdiction/phone-region.ts: add `isValidKenyaMobile`, copying l.12-15.
- lib/contact/identity.ts:38-67 and lib/whatsapp.ts:46-57:
  - Add a branch for `^254[17]\d{8}$`.
  - Turn a local leading `0` into E.164 using the active profile's dial code (new `capture.dialCode`
    field: "27", "266", "254"). The ZA output must not change (fixes trap 3).
- lib/config/identity-schema.ts:208-218: add `keIdentityColumnsSchema` with kePhone. Copy `lsIdentityColumnsSchema`.
- prisma/schema/tenancy.prisma:245-253: enum values KE and KES.
- Migration 20261108090000_kenya_enum_values: only `ALTER TYPE "Jurisdiction" ADD VALUE 'KE'` and
  `ALTER TYPE "LenderCurrency" ADD VALUE 'KES'`. Postgres cannot use a new enum value in the same
  transaction. Precedent: 20261101100000_loan_change_enum_values followed by 20261101100100.
- Migration 20261108090100_kenya_jurisdiction_currency:
  - DROP and re-ADD `TenantConfig_jurisdiction_currency` and `InstanceJurisdiction_jurisdiction_currency`
    with `OR ("jurisdiction" = 'KE' AND "currency" = 'KES')`.
  - No trigger changes. The guard functions are generic; confirm that with the catalog query in
    CLAUDE.md:88-92 plus `grep -rn "'LS'" prisma/migrations`. The only hits on main are those two CHECKs and
    the original enum migration.
- Docs: lib/jurisdiction/.claude.md (summary "ZA vs LS" becomes "ZA, LS, KE"; add a KE ID line) and
  docs/ARCHITECTURE.md:192 ("ZA or LS"). Then run `npm run agents:mirror`.
Tests to write first and see fail:
- profiles.test.ts: the KE profile, `JURISDICTIONS` equals ["ZA","LS","KE"], `currencyAllowed`, and a KNOWN-GAP
  test asserting Nairobi is UTC+3 while SAST is UTC+2.
- money.test.ts and format-currency.test.ts: "KSh 1,234.56", "-KSh 0.05", "KSh2.5m".
- national-id.test.ts: accepts 12345678 and 123456789; rejects 1234567, A1234567 and 13-digit SA IDs.
- business-days.test.ts: 2026-06-01, 10-20 and 12-12 are not business dates under KE; under LS, 2026-03-11
  is still a holiday and 2026-06-01 is a business day.
- client-wizard tests: a KE ID is not checked with Luhn.
- identity tests: "0712345678" under KE gives "254712345678"; under ZA, "0821234567" still gives "27821234567".
- active.test.ts: KE with ZAR throws.
- lib/jurisdiction/migration.test.ts:12: update the pinned rule string. This test fails first.
- nca-gates.test.ts: the "LS skips" block runs for both LS and KE.
- nca-only-behaviour.test.ts:20: the mocked instance row runs once as LS and once as KE (`describe.each`).
- instance-guard.integration.test.ts: a KE instance refuses a ZA config and accepts KE/KES.
Verify:
- `npx tsc --noEmit`. The compiler finds every `Record<Jurisdiction|Currency,…>`.
- `npx vitest run lib/jurisdiction lib/validation lib/contact lib/pdf lib/non-nca-documents`
- `npm run ci:quick`
- RUN_DB_IT suites per CLAUDE.md:157-165.
- ZA invariance: `npx vitest run lib/pdf/charges-off-identity.test.ts` passes with no re-pin.
Conflicts: KE-1, KE-3 and KE-4 rebase onto this slice. Profile fields that later slices need are added here only.

### KE-2 Currency labels: every "(R)" form label uses the active symbol (wave 1, independent)
This is LS walk finding 1.
Files:
- lib/i18n/messages/en/portal-apply.ts:43-45: incomeR, expensesR and debtR get a `{symbol}` param.
  Add the same param in af/zu/xh.
- The website-apply netIncome label.
- components/clients/wizard/Step3Employment.tsx, ExpenseBreakdownSection.tsx, DebtObligationsSection.tsx,
  applications/LoanCalculator.tsx, wizard/Step2LoanParams.tsx, AffordabilityCapture.tsx,
  clients/ClientFormLegacy.tsx, crm/ConvertLeadForm.tsx, payments/QuickPaymentCapture.tsx,
  ClientNotifiedPayments.tsx, products/LoanProductForm.tsx, products/NonNcaArrearsFields.tsx.
- Pattern: `currencySymbol(activeCurrency())` (money.ts:16, active.ts:59).
- Do NOT touch asset-finance, insurance (both ZA-only) or lib/pdf.
Tests first: for each component or message, a test that it renders "KSh" under KE/KES and "R" under ZA.
Use the LS pattern in lib/jurisdiction/currency-sites.test.ts.
Verify: `npx vitest run components lib/i18n lib/jurisdiction`. Byte-identical ZA output is checked by the
existing snapshots.
Conflicts: KE-3 also edits LoanProductForm.tsx, so land KE-2 first.

### KE-1 Demo lender and seed: DEMO_LENDER=nairobi (wave 2)
Files:
- prisma/demo-lender.ts: add `nairobi`. Copy `basotho` at l.103-130: jurisdiction KE, currency KES,
  "Demo Nairobi Credit Ltd", companyRegNumber "PVT-2099DEMO1", ncr/fsca null, a "1 Demo Road, Nairobi, 00100"
  office, "+254 700 000 000" phones, `.example` and `.invalid` domains, bureau supplier NAIRO1.
- New file prisma/seed/kenya-clients.ts: `CLIENTS_KE`, copying lesotho-clients.ts.
  - IDs 99000001 to 99000005 (8 digits).
  - Phones +2547000000NN.
  - "Demo Bank" and Nairobi/Kiambu/Mombasa counties with their codes.
  - Postal codes 00100 and so on; incomes in KES cents.
- prisma/seed.ts:
  - l.219: choose clients through `{ZA: CLIENTS, LS: CLIENTS_LS, KE: CLIENTS_KE}[JURISDICTION]`.
  - l.113-118: add a KE product list (MPESA30 KES 1,000-50,000 over 30 days, PERSONAL KES 10,000-500,000).
    ZA and LS keep `PRODUCTS` unchanged.
  - l.163: KE gets `enabledLanguages: ["en"]` (no reviewed Swahili exists).
- New file prisma/seed/kenya-templates.ts:
  - KE bodies for the four keyed templates, using the same keys as non-nca-templates.ts:47-75 and the same
    SAMPLE gap. The KFS lists "Regulated by the Central Bank of Kenya" and the M-Pesa Paybill instructions.
  - non-nca-templates.ts gets one dispatch line that picks the KE bodies when the jurisdiction is KE.
- prisma/seed/key-facts-walk.ts:25 `LONG_AGO`: the walk borrower's statement is dated recently, so a new
  application does not open with NO_STATEMENT. This is LS walk finding 2 and also fixes LS.
Tests first:
- prisma/demo-lender.test.ts: l.87 lists `nairobi`; KE/KES, no NCR, +254 phones.
- A unit test that every CLIENTS_KE row passes the KE ID, mobile, county and postal rules under KE.
- prisma/seed.integration.test.ts runs a case with DEMO_LENDER=nairobi: the instance row is KE/KES, KEY_FACTS
  templates exist, and the apps are stamped KEY_FACTS.
Verify: on a throwaway DB, `DEMO_LENDER=nairobi SEED_PRINT_CREDENTIALS=1 npm run seed:base`, then sign in.
Conflicts: prisma/seed.ts is touched only here. KE-3 edits kenya-templates.ts after this lands.

### KE-4 M-Pesa repayments, simulated: C2B paybill and STK push (wave 2, parallel with KE-1)
New module lib/mobile-money/ (provider interface, no Daraja wire code):
- types.ts: `MobileMoneyProvider` with `id`, `simulation()`, `requestStkPush()` and `parseC2BCallback()`.
  Copy lib/payouts/types.ts:69-88.
- registry.ts: copy lib/payouts/registry.ts.
- providers/simulated.ts: an HMAC-signed callback, copying lib/payouts/providers/simulated.ts:20-60.
  - The phone's last digits pick the outcome: …0000 is cancelled by the user, anything else is paid.
  - For the demo, STK push writes the pending request and then delivers its own signed callback in-process.
- c2b-ingest.ts:
  - Match on BillRefNumber against `Loan.reference` (trimmed, case-folded).
  - Idempotency key `mpesa-c2b:<TransID>`.
  - Book with `applyManualReceipt`, copying lib/collections-engine/allocate.ts:45-85: paymentMethod
    MOBILE_MONEY, valueDateSource SYSTEM_OBSERVED, auditUserId null, and a SIMULATED note.
  - A simulated callback is refused unless `isSimulationPermitted("simulated-mpesa")` (allocate.ts:45).
  - Charges-refused goes to `recordHeldReceipt` (lib/payments/held-receipt.ts).
  - An unmatched callback is stored UNMATCHED for staff and books no Payment.
Registries, one new file each, never a line added to a shared list:
- lib/registry/simulated-integrations/070-mobile-money.ts
- lib/registry/audit-actions/420-mobile-money.ts
- lib/registry/tenant-scoped-models/<n>-mobile-money.ts
DB:
- Migration 20261108110000_payment_method_mobile_money: only the enum value.
- Migration 20261108110100_mobile_money_transactions: table `MobileMoneyTransaction` with tenantId,
  provider, transId, checkoutRequestId, msisdn (last 4 only, stored masked), billRef, amount, status,
  loanId?, paymentId?, simulated.
  - UNIQUE(provider, transId) and an amount > 0 CHECK.
  - Composite tenant foreign keys, ENABLE + FORCE ROW LEVEL SECURITY.
  - Copy 20261016150000_payment_notifications/migration.sql:27-80.
- prisma/schema/loans-payments.prisma:420: add MOBILE_MONEY.
Routes:
- POST app/api/webhooks/mobile-money/[provider]/route.ts: copy app/api/webhooks/payouts/[provider]/route.ts.
  It is public through lib/public-routes.ts:19 and verifies before reading.
- POST app/api/portal/payment/mpesa/route.ts (STK push): copy app/api/portal/payment/initiate/route.ts:11-50.
- app/api/payments/route.ts:17: add MOBILE_MONEY to `PAYMENT_METHODS` so staff can capture an M-Pesa receipt.
- app/(portal)/portal/payment/page.tsx:71-90: an M-Pesa panel (Paybill from `MPESA_PAYBILL_SHORTCODE`,
  account = loan reference) and a "Pay with M-Pesa" button. Shown only when the paybill env is set.
Tests first:
- ingest unit tests: matched books one receipt; a replayed TransID books nothing; an unmatched ref books
  nothing; simulation forbidden gives NEEDS_REVIEW.
- Webhook: a bad signature answers 401.
- A RUN_DB_IT ingest test against a seeded KE loan.
- The registry census tests (lib/registry/registries.test.ts).
Verify:
- `npx vitest run lib/mobile-money app/api/webhooks app/api/portal/payment lib/registry`
- The integration runner.
- `npx tsc` finds every exhaustive PaymentMethod map; give each one an "M-Pesa" label.
Conflicts: app/(portal)/portal/payment/page.tsx (only this slice). The KE-2 sweep touches the payments
components, so rebase on KE-2.

### KE-3 KFS disclosures for CBK: approval reference and excise duty (wave 3, after KE-1 and KE-2)
- New file lib/jurisdiction/kenya-rules.ts, pure data with an UNVERIFIED header:
  - `feeExciseRate` (KE 0.20, otherwise 0)
  - `crbListingMinCents` 100_000, `crbNoticeDays` 30
  - `termChangeNoticeDays` 30, `complaintResolutionDays` 30
  - `nplInterestCap: "PRINCIPAL_AT_NPL"`
  - `allocationOrder: ["PRINCIPAL","FEES","INTEREST"]` flagged UNVERIFIED and NOT WIRED
  - `guarantorContactNoticeDays` 14
- prisma/schema/loans-payments.prisma:1-27: `regulatorApprovalRef String?` on LoanProduct.
  Migration 20261108100000 is additive and nullable.
- components/products/LoanProductForm.tsx and the product API validator: the field appears only when not ZA.
- lib/documents/tokens.ts:161-230:
  - New tokens `product.regulatorApprovalRef`, `quote.exciseDuty` and `quote.totalCostOfCredit`.
  - They resolve to null when the rate is 0 or the ref is absent. lib/non-nca-documents/render.ts passes the product.
  - Excise is shown as INCLUDED in the fees: `round(fees*rate/(1+rate))`. It is DISCLOSED, not charged on top.
    Charging on top would change the calculator, which is out of scope. Finance and counsel must confirm this.
- prisma/seed/kenya-templates.ts: the KFS uses the new tokens. The seed sets a demo ref
  "CBK/DEMO/0001" on KE products.
Tests first:
- tokens.test.ts: under KE, quote.exciseDuty for SAMPLE_QUOTE (fees 146,400) is KSh 244.00; under ZA and LS it is null.
- render.test.ts: a KE KFS contains the approval ref.
- The ZA NCA PDF tests stay unchanged: lib/pdf is not touched.
Verify: `npx vitest run lib/documents lib/non-nca-documents lib/pdf prisma`. Render the KFS from the seeded app.

### KE-5 End-to-end proof and demo walk (wave 4)
- lib/non-nca-documents/ls-stack.integration-fixture.ts:21: widen `StackJurisdiction` to "LS" | "ZA" | "KE".
- New ke-end-to-end.integration.test.ts: copy ls-end-to-end.integration.test.ts. Apply, review, approve,
  KFS acknowledged, sign, pay out (with an M-Pesa code as the bank ref), then a simulated C2B receipt is
  allocated, then the arrears letter.
- docs/kenya-go-live.md: the KE counterpart of docs/non-nca-go-live.md, listing the UNVERIFIED facts and out-of-scope items.
- The browser walk: the six roles, KSh everywhere, +254 capture, a county dropdown, the KFS showing the CBK
  ref and excise, the M-Pesa panel and a paid STK push. Screenshots go to .claude/evidence/ke-walk/.
Verify:
- `npm run ci:full`
- ZA fingerprint: `npx tsx scripts/nca-pdf-fingerprint.ts .` must match the pins in charges-off-identity.test.ts.
- LS: `DEMO_LENDER=basotho npm run seed:base` on a separate DB, then walk the LS flow to the payout.

### Stretch (not needed for the demo)
- KE-6 Daraja sandbox adapter (lib/mobile-money/providers/daraja.ts):
  - OAuth, STK push, C2B RegisterURL, callback IP allow-list plus a shared secret in the URL path.
  - Credentials sealed through lib/integrations/tenant-credentials.ts.
- KE-7 M-Pesa B2C payout: a `PayoutProvider` in lib/payouts/providers (registry.ts:15). The beneficiary is
  an MSISDN, not a bank account. The key-facts disburse.ts must then dispatch to a provider instead of
  MANUAL, and the AVS rule (lib/payouts/.claude.md) needs a mobile-money exception. This is a real design change.

## OUT of scope for the demo
- Real CRB adapters (Metropol, TransUnion KE, Creditinfo), CRB submission, the 30-day pre-listing notice and
  the KES 1,000 floor in code. The demo uses the simulated bureau, which is permitted only by SIMULATED_INTEGRATIONS.
- Enforcing the NPL interest cap, the principal-first allocation order (UNVERIFIED), the 30-day notice plus
  acceptance for term changes, the guarantor-only third-party contact rule and the 30-day complaint SLA.
  These are recorded as data in kenya-rules.ts and not wired.
- Excise charged on top of fees, and excise remittance or reporting.
- Check-off/payroll deduction, USSD, Airtel Money, KRA PIN capture (needs a Client column) and iTax.
- SmileIdentity KE KYC (country is hardcoded "ZA" at smileidentity.ts:109/181); the demo uses in-person KYC.
- Swahili translations, a fix for the EAT/SAST time-zone gap, the snapshot bake for scripts/demo (it has no
  key-facts path), and freezing `regulatorApprovalRef` into ProductVersion.
- Wording for the automated-decision explanation and AI disclosure. Instant approval stays off, so every
  decision is made by a person.
- Any change to lib/pdf/* or other NCA wording.

## Risks and checks
- ZA bytes: KE-0 and KE-2 touch shared formatters and normalisers. Each needs a ZA-unchanged test, plus the
  pdf suite with no re-pin.
- Enum additions break exhaustive maps silently only where the code uses if/else (traps 1 and 2). Grep for
  `=== "ZA"`, `!== "ZA"` and `"LS_ID"` after KE-0.
- Each slice's migrations must sort after main at merge time. Rename the directories if main moves past
  20261108 (precedent b6c3afa3).
