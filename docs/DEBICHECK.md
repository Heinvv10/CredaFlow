# DebiCheck

Research note, 2026-10-16. What DebiCheck is, which South African providers
expose it to software, what CredaFlow already has, the gaps, and what is
needed before a live adapter can be built. No adapter is built here.

Facts marked **(unverified)** come from secondary sources or could not be
confirmed from a provider's own documentation. Provider facts change; re-check
the linked docs before signing anything.

## What it is

DebiCheck is the authenticated early debit order (AC/DebiCheck system) run by
the Payments Association of South Africa (PASA) with BankservAfrica as the
clearing operator, introduced on a SARB directive. Since 1 May 2021 every new
or renegotiated early debit order must originate as a DebiCheck mandate; it
replaces AEDO and NAEDO for new business.

The debtor confirms the mandate once, with their own bank, before any
collection. The bank then refuses a collection that does not match the
confirmed terms (amount, date, frequency). A collection made within the
confirmed terms cannot be disputed as unauthorised; one outside them can.

Sources: [PASA debit payments](https://pasa.org.za/about-payments/introduction-to-payments/debit-payments/),
[Stitch guide](https://stitch.money/blog/debicheck-the-ultimate-guide),
[BusinessTech, May 2021](https://businesstech.co.za/news/banking/486357/south-africas-new-debit-order-system-in-full-effect-from-may/).

### Authentication types

| Type | How the debtor authenticates | Response window |
|---|---|---|
| TT1 real-time | Push to banking app / USSD | 120 seconds (Stitch `authRealtime`, Netcash) |
| TT1 delayed | Banking app / online banking | Same day, until end of day (Stitch `authEndOfDay`; Netcash says within 1 day) |
| TT2 batch | Request sent overnight; app / online banking | 2 days (Stitch `auth48Hour`) |
| TT3 | Card and PIN at a point of sale | Real time (**unverified** for any API provider; only Altron FinTech markets it) |
| RM (registered mandate) | None: pre-authorised, or an unanswered TT1-delayed/TT2 request converted | — |

Stitch allows only RM for business-entity debtors. Netcash marks its RMS
service "no longer available" while its docs still describe conversion of
unanswered requests to RM. Treat RM as provider-specific.

### Mandate terms the debtor confirms

- **Contract reference** — the creditor's reference for the contract (Stitch:
  `contractReference`, max **14 characters**).
- **Instalment amount** and **maximum collection amount** — the maximum may
  not exceed 1.5 x the instalment for fixed/variable mandates (Stitch, Netcash).
  Netcash notes disputes are tested against the instalment, not the maximum.
- **First collection amount and date** — Stitch: date at least 4 days out.
- **Collection day and frequency.**
- **Adjustment category** — never / quarterly / biannually / annually / repo
  rate, with either an adjustment amount or an adjustment rate (one, not both).
  Adjustment is not automatic: the creditor sends the new instalment.
- **Date adjustment rule** — whether a collection may move to the next business
  day when the collection day is not one. Off: any other day is rejected.
  Netcash recommends on.
- **Tracking** — whether the debtor's bank may hold the debit and retry for
  funds after the action date; up to 10 days.
- **Creditor abbreviated short name** — what the debtor sees on their statement.
- **Debtor identity** — name (Stitch max 35 chars), SA mobile number, ID /
  passport / temporary-residence ID / company registration number, account
  number, branch, account type (current or savings only).

### Amendments

Some amendments need the debtor to authenticate again, others only notify.
Stitch's split ([amendments](https://docs.stitch.money/payment-products/payins/debicheck/mandate-amendments)):

- **Re-authentication:** collection day, first collection date/amount, date
  adjustment rule, adjustment amount/rate, creditor short name, instalment or
  maximum when the adjustment category is `never`.
- **Notification only:** tracking, debtor name, ID document, account type,
  account number at the same bank, contract reference before the first
  collection, instalment/maximum within the agreed adjustment.

### Scheme rules not confirmed from a rulebook

`lib/collections-engine/scheme-rules.ts` encodes a 2-presentment cap per
instalment and suspension after 2 consecutive NPF unpaids. Both come from
published summaries, not from the PASA rulebook or a provider contract
**(unverified)**. They must be checked against the chosen provider's rules
before a lender goes live; the file says so too.

## Providers

A credit provider cannot send DebiCheck messages itself. It needs either a
sponsoring bank (host-to-host, usually for large collectors) or a third-party
payment provider (TPPP) that holds the bank relationship. Every provider below
also requires its own merchant onboarding (FICA, collection risk limits).

| Provider | DebiCheck interface | Status for CredaFlow |
|---|---|---|
| **Stitch** | GraphQL API for mandates (`paymentConsentRequestCreate`, hosted debtor flow or `…Confirm`), signed webhooks for mandate status; **collections and results by SFTP files** (REPLY + OUTPUT files, announced by webhook). TT1, TT1-delayed, TT2, RM. Sandbox: test clients, outcome by instalment amount. [Docs](https://docs.stitch.money/payment-products/payins/debicheck/introduction) | **Already a CredaFlow integration** (`lib/stitch.ts`: OAuth client credentials + GraphQL pay-by-bank, per-tenant credentials). Best documented option found. |
| **Netcash** | NIWS SOAP web services: TT1 synchronous, trace, amend, cancel, batch file upload, mandate template, participating banks. [Docs](https://api.netcash.co.za/inbound-payments/dc/) | Adapter exists for AVS only; mandate/collect methods throw NOT_IMPLEMENTED. **Dropped for this product (Hein, 2026-10-16): Netcash no longer serves micro lenders.** Netcash's own help page does not state this. |
| **EasyDebit** | Lists DebiCheck and collections among its services ([Bizcommunity listing](https://www.bizcommunity.com/Company/EasyDebitPaymentSolutions)). No public developer documentation found. | Named as a collections partner in sales material. **No adapter in any repo** (2026-10-16). Interface **unverified**; `types.ts` assumes a file-based rail. |
| **BankTech** | Advertises a DebiCheck API: authentication, amendments, cancellations, status, collection results. [Solutions](https://bank.tech/solutions/), [docs](https://docs.bank.tech/) | Endpoint docs not confirmed **(unverified)**. |
| **Hyphen** | File-based, standard FACS format; no API mentioned. [Page](https://www.hyphen.co.za/debicheck/) | File rail only **(unverified beyond the marketing page)**. |
| **Altron FinTech (Realpay / NuPay)** | Portal and terminal product; markets microfinance and TT3. No developer docs found. [Page](https://fintech.altron.com/debicheck) | Integration method **unverified**. |
| **PayM8** | Named in `types.ts` as a file-based rail. No public DebiCheck API docs found. | **Unverified.** |
| **Peach Payments** | Developer site lists payouts and account verification for SA; DebiCheck not listed. | **No DebiCheck API found.** |
| **Paystack** | No SA DebiCheck product found. | **Not a candidate (unverified negative).** |
| **Bank host-to-host** (Absa, Nedbank, Standard Bank, FNB, RMB) | Bank-specific file/H2H integrations under a sponsoring-bank agreement. [RMB](https://www.rmb.co.za/debicheck) | Needs a direct bank collection agreement; not public. |

Recommendation: Stitch, unless the lender already contracts elsewhere. It is
the only provider found with public, current API documentation and a
self-serve sandbox, and CredaFlow already authenticates against it. The cost
is a split interface: mandates over GraphQL + webhooks, money over SFTP files.

## What CredaFlow already has

Two separate mandate layers exist.

**1. The signed debit-order mandate document** (application stage). Fields
`debitMandate*` on `LoanApplication` (`prisma/schema/applications.prisma`),
rendered by `lib/pdf/debitMandate.ts`, signed in the portal at
`app/(portal)/portal/mandate/[applicationId]/` with an OTP
(`app/api/applications/[id]/debit-mandate/sign/route.ts`). This is the
contractual authority, not a DebiCheck mandate: no bank sees it. It stays as
is; the DebiCheck mandate is raised after it.

**2. The collections engine** (`lib/collections-engine/`, adapters in
`lib/integrations/collections/`). Provider-agnostic, dark unless
`TenantConfig.collectionsEngineEnabled`, provider chosen by
`TenantConfig.collectionProvider`. Built for DebiCheck:

- `DebitMandate` (`prisma/schema/collections.prisma`): auth type
  (`TT1`, `TT1_DELAYED`, `TT2`), amount, max amount, debit day, frequency
  (`ONCE_OFF`, `MONTHLY`), adjustment category, tracking days, first
  collection date, a snapshot of the bank account, provider reference.
- State machine (`state-machine.ts`, mirrored by a DB trigger):

  ```
  CREATED -> SUBMITTING -> PENDING_REGISTRATION -> PENDING_AUTH -> ACTIVE -> SUSPENDED
                 |              (file-based rail)        |-> REJECTED / EXPIRED
                 |-> PENDING_AUTH / ACTIVE / REJECTED     '-> CANCELLED (any live state)
  ```

  SUSPENDED never returns to ACTIVE (a fresh mandate is required).
- `CollectionBatch` / `CollectionInstruction` / `CollectionResult`:
  presentments, a 2-presentment cap per instalment enforced by CHECK + unique
  index, idempotent result ingestion, NPF stop rules, a staff review queue.
- Crons `app/api/cron/collections-submit` and `collections-results`; staff
  routes `app/api/loans/[id]/collections-mandate/`.
- The `CollectionProvider` interface (`types.ts`) already models file rails:
  `awaitingLoadReport`, `getBatchLoadReport`, `findMandate`, `findInstruction`.
- Providers registered: `simulated` (blocked on deployed builds unless
  `SIMULATED_INTEGRATIONS` names it) and `netcash` (AVS only).

## Gaps against the scheme and Stitch

| Gap | Where | Needed change |
|---|---|---|
| Contract reference is the mandate's cuid (25 chars); Stitch allows 14 | `CreateMandateReq.mandateReference` | A separate short, unique contract reference column, generated per tenant |
| No adjustment amount / rate | `DebitMandate.adjustment` holds the category only | Add `adjustmentAmountCents` or `adjustmentRateBps` (one of), CHECK enforced |
| No date adjustment rule | — | Add `dayAdjustmentAllowed Boolean` (default true, per Netcash's advice) |
| Tracking is a day count; Stitch sends a boolean | `trackingDays` | Adapter maps `trackingDays > 0` to the indicator; keep the count for the engine |
| No creditor short name | — | Per-lender `TenantConfig` field (statement descriptor) |
| No RM or TT3 auth type | `DebitMandateAuthType` | Add `RM` only if the chosen provider exposes it; TT3 not needed for an online lender |
| No amendment flow | state machine has no amend path | `DebitMandateAmendment` row + `PENDING_AMENDMENT` state, re-auth vs notify split from the provider |
| Paused mandate can be unsuspended by amendment (Stitch) | SUSPENDED is terminal | Keep terminal: the scheme rule in `scheme-rules.ts` is the stricter reading; a resumed mandate is raised as a new one |
| Revocation reason | `cancelMandate(ref)` takes no reason | Pass `EARLY_SETTLEMENT` / `CONTRACT_EXPIRED` / `FRAUD` / `GENERAL` |
| Debtor authentication in the portal | engine is staff-initiated | For Stitch's hosted flow: store the redirect URL, show it on the portal mandate page after the document is signed, accept the webhook |
| Webhook intake | engine polls (`getMandateStatus`, `fetchResults`) | A signed webhook route that triggers the same refresh; polling stays the fallback |
| Business-entity borrowers | `mandates.ts` refuses entity borrowers | Stitch allows RM only for entities; decide whether to support |

### Target lifecycle (provider-neutral)

```
document signed (layer 1)
  -> mandate CREATED -> SUBMITTING -> PENDING_AUTH        debtor authenticates in bank app / USSD
       -> ACTIVE | REJECTED | EXPIRED (window lapsed; RM conversion if the provider does it)
  ACTIVE -> PENDING_AMENDMENT -> ACTIVE                  re-auth amendment accepted
                              -> ACTIVE (old terms)       re-auth amendment rejected/expired
  ACTIVE -> instructions per instalment -> PAID | UNPAID (reason) | DISPUTED
         -> SUSPENDED (NPF stop rule / bank) -> new mandate
  any live -> CANCELLED (settled, written off, staff; revocation reason sent)
```

Only `PENDING_AMENDMENT` and the amendment row are new; everything else maps
onto the existing states.

## Stitch adapter shape (for scoping, not built)

- `createMandate` -> `paymentConsentRequestCreate` (debicheck), returns
  `PENDING_AUTH` with the consent id as `providerMandateRef` and the redirect URL.
- `getMandateStatus` -> consent query; `PaymentConsentGranted` -> AUTHENTICATED,
  `Failed` -> REJECTED, `Expired` -> EXPIRED, `Revoked`/`Cancelled` ->
  CANCELLED, `Paused` -> SUSPENDED.
- `cancelMandate` -> `paymentConsentRequestCancel` (pending) or
  `paymentConsentRequestRevoke` (granted).
- `findMandate` -> lookup by contract reference.
- `collect` -> write the collection file to SFTP `/Outgoing`, answer
  `awaitingLoadReport`; `getBatchLoadReport` -> parse the REPLY file.
- `fetchResults` -> parse OUTPUT files; map return codes to `NormalizedReason`.
  The OUTPUT file's return-code list and per-item transaction id
  (`providerResultId`) are **not in the public docs (unverified)** and must
  come from Stitch's file specification.
- `verifyAccount` -> Stitch AVS if offered, else keep `avsProvider` separate
  **(unverified)**.

Estimate depends on the file spec; the GraphQL half is small because the
token client already exists.

## What Hein must supply to proceed

The build stops here until these exist:

1. **Provider choice** for the first lender: Stitch (recommended), EasyDebit,
   or the lender's existing provider (BYOC).
2. **A sandbox / test account** with that provider, with DebiCheck enabled,
   and its credentials (for Stitch: a test client id/secret with the
   `client_recurringpaymentconsentrequest` scope, SFTP test credentials, the
   webhook signing secret, and the return-URL domain allowlisted).
3. **The provider's DebiCheck file and rule specification** (collection
   file layout, REPLY/OUTPUT layout, return codes, presentment and NPF rules)
   — the scheme rules in `scheme-rules.ts` are verified against it.
4. **For EasyDebit specifically:** its API or file documentation; nothing
   public was found.

A live account (FICA onboarding, the lender's creditor short name, risk
limits) is the lender's contract with the provider and is needed only for go-live.
