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
confirmed terms (amount, date, frequency). A DebiCheck collection can still be
disputed "under certain conditions", but one that matches the mandate is
harder to dispute; Hyphen states disputes are not allowed after 12 months from
the action date ([Hyphen FAQ](https://www.hyphen.co.za/debicheck/faqs/); see
also [Stitch](https://stitch.money/blog/debicheck-the-ultimate-guide)). The
exact dispute rules are in the PASA rulebook, which was not read **(unverified)**.

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

Every value in `lib/collections-engine/scheme-rules.ts` comes from published
summaries, not from the PASA rulebook or a provider contract; the file's own
header (:6-8) says each must be verified before a lender goes live. All are
**unverified**:

| Value | Line | Note |
|---|---|---|
| 2 presentments per instalment | :22 | Also a DB CHECK + unique index |
| Suspend after 2 consecutive NPF unpaids | :25 | |
| Tracking 1–10 days | :28-29 | Netcash and Stitch docs agree on max 10; also a DB CHECK |
| Max collection amount 1.5 x instalment | :32 | Stitch and Netcash docs agree |
| Batch lead time 2 business days | :35 | Netcash's two-day service; Stitch's cut-offs are not public |
| Load-report / registration timeout 48 h | :57-64 | Marked as an assumption in the file |
| Several debits per mandate per action date | :70-77 | `MULTIPLE_DEBITS_PER_DATE_VERIFIED = false` |
| Hard-stop unpaid reasons | :91-98 | Depends on the provider's return-code mapping |

The header at :8 still says "Netcash first"; it should name the chosen
provider once one is picked (a code-comment change, not made here).

## Providers

A credit provider cannot send DebiCheck messages itself. It needs either a
sponsoring bank (host-to-host, usually for large collectors) or a third-party
payment provider (TPPP) that holds the bank relationship. Every provider below
also requires its own merchant onboarding (FICA, collection risk limits).

| Provider | DebiCheck interface | Status for CredaFlow |
|---|---|---|
| **Stitch** | GraphQL API for mandates (`paymentConsentRequestCreate`, hosted debtor flow or `…Confirm`), signed webhooks for mandate status; **collections and results by SFTP files** (REPLY + OUTPUT files, announced by webhook). TT1, TT1-delayed, TT2, RM. Sandbox: test clients, outcome by instalment amount. [Docs](https://docs.stitch.money/payment-products/payins/debicheck/introduction) | **Already a CredaFlow integration** (`lib/stitch.ts`: OAuth client credentials + GraphQL pay-by-bank, per-tenant credentials). The token request hardcodes scope `client_paymentrequest` (`lib/stitch.ts:90`); DebiCheck needs `client_recurringpaymentconsentrequest` ([integration process](https://docs.stitch.money/payment-products/payins/debicheck/integration-process)), so `getStitchAccessToken` must take a scope. Best documented option found. |
| **Netcash** | NIWS SOAP web services: TT1 synchronous, trace, amend, cancel, batch file upload, mandate template, participating banks. [Docs](https://api.netcash.co.za/inbound-payments/dc/) | Adapter exists for AVS only; mandate/collect methods throw NOT_IMPLEMENTED. **Dropped for this product (Hein, 2026-10-16): Netcash no longer serves micro lenders.** Netcash's own [DebiCheck help page](https://help.netcash.co.za/?p=11875) does not state this. |
| **EasyDebit** | Lists DebiCheck and collections among its services ([Bizcommunity listing](https://www.bizcommunity.com/Company/EasyDebitPaymentSolutions)). No public developer documentation found. | Named as a collections partner in CredaFlow sales material. **No adapter in this repo** (2026-10-16). Interface **unverified**; `types.ts` assumes a file-based rail. |
| **BankTech** | Advertises a DebiCheck API: authentication, amendments, cancellations, status, collection results. [Solutions](https://bank.tech/solutions/), [docs](https://docs.bank.tech/) | Endpoint docs not confirmed **(unverified)**. |
| **Hyphen** | File-based, standard FACS format; no API mentioned. [Page](https://www.hyphen.co.za/debicheck/) | File rail only **(unverified beyond the marketing page)**. |
| **Altron FinTech (Realpay / NuPay)** | Portal and terminal product; markets microfinance and TT3. No developer docs found. [Page](https://fintech.altron.com/debicheck) | Integration method **unverified**. |
| **PayM8** | Named in `types.ts` as a file-based rail. No public DebiCheck API docs found. | **Unverified.** |
| **Peach Payments** | [Developer site](https://www.peachpayments.com/developers/developers) lists payouts and account verification for SA; DebiCheck not listed. | **No DebiCheck API found (unverified negative).** |
| **Paystack** | No SA DebiCheck product found. | **Not a candidate (unverified negative).** |
| **Bank host-to-host** (Absa, Nedbank, Standard Bank, FNB, RMB) | Bank-specific file/H2H integrations under a sponsoring-bank agreement. Only [RMB](https://www.rmb.co.za/debicheck) was found publicly describing a creditor-side DebiCheck service; the others are **unverified**. | Needs a direct bank collection agreement; not public. |

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
| No amendment flow | Terms are immutable: trigger `guardDebitMandateStatus` raises "terms are fixed once created: create a fresh mandate" (`prisma/migrations/20261015120000_collections_mandate_provider_end/migration.sql:23`, first in `20261014150000_collections_engine`), and its status allow-list has no amendment state | See "Amendments in the database" below |
| Paused mandate can be unsuspended by amendment (Stitch) | SUSPENDED is terminal | Keep terminal: the scheme rule in `scheme-rules.ts` is the stricter reading; a resumed mandate is raised as a new one |
| Revocation reason | `cancelMandate(ref)` takes no reason | Pass `EARLY_SETTLEMENT` / `CONTRACT_EXPIRED` / `FRAUD` / `GENERAL` |
| Debtor authentication in the portal | engine is staff-initiated | For Stitch's hosted flow: store the redirect URL, show it on the portal mandate page after the document is signed, accept the webhook |
| Webhook intake | engine polls (`getMandateStatus`, `fetchResults`) | A signed webhook route that triggers the same refresh; polling stays the fallback. Reusable: the per-tenant webhook-secret loader `loadStitchWebhookSecret` (`lib/stitch.ts:73-78`) and the `x-stitch-signature` handling in `app/api/portal/payment/webhook/route.ts:28` |
| Business-entity borrowers | `mandates.ts` refuses entity borrowers | Stitch allows RM only for entities; decide whether to support |

### Target lifecycle (provider-neutral)

```
document signed (layer 1)
  -> mandate CREATED -> SUBMITTING -> PENDING_AUTH        debtor authenticates in bank app / USSD
       -> ACTIVE | REJECTED | EXPIRED (window lapsed; RM conversion if the provider does it)
  ACTIVE + amendment row PENDING_AUTH -> amendment ACCEPTED   mandate stays ACTIVE throughout
                                      -> amendment REJECTED/EXPIRED
  ACTIVE -> instructions per instalment -> PAID | UNPAID (reason) | DISPUTED
         -> SUSPENDED (NPF stop rule / bank) -> new mandate
  any live -> CANCELLED (settled, written off, staff; revocation reason sent)
```

Only the amendment row is new; the mandate states are unchanged.

### Amendments in the database

The mandate row's terms cannot change (trigger above), so amended terms live
in a new `DebitMandateAmendment` row: the changed fields, whether the
provider requires re-authentication, its own status (`PENDING_AUTH`,
`ACCEPTED`, `REJECTED`, `EXPIRED`), and the provider's reference. The mandate
stays `ACTIVE` while an amendment is pending, so a rejected or expired
amendment needs no rollback: the mandate's original terms were never touched.
The engine reads a mandate's effective terms as the original row overlaid with
its accepted amendments, newest last.

This still changes enforcement: the presentment and max-amount checks that
read `DebitMandate` columns must read the effective terms, and a new trigger
must keep amendment rows append-only and their status moves legal. That is a
hand-written migration (Prisma does not diff triggers) and, like every
enforcement migration here, it ships in the same PR as its code. The
alternative, a `PENDING_AMENDMENT` mandate status with mutable terms, would
need `guardDebitMandateStatus` rewritten and loses the original terms on
rejection; not recommended.

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

Reusable as is: per-tenant credential loading (`lib/integrations/tenant-credentials.ts`,
`loadStitchWebhookSecret` at `lib/stitch.ts:73-78`) and the `x-stitch-signature`
webhook handling (`app/api/portal/payment/webhook/route.ts:28`). Needs a
change: `getStitchAccessToken` hardcodes scope `client_paymentrequest`
(`lib/stitch.ts:90`) and must request `client_recurringpaymentconsentrequest`
for consent calls. The estimate depends mostly on the SFTP file spec.

## What Hein must supply to proceed

The build stops here until these exist:

1. **Provider choice** for the first lender: Stitch (recommended), EasyDebit,
   or the lender's existing provider (BYOC).
2. **A sandbox / test account** with that provider, with DebiCheck enabled,
   and its credentials (for Stitch: a test client id/secret with the
   `client_recurringpaymentconsentrequest` scope ([Stitch docs](https://docs.stitch.money/payment-products/payins/debicheck/integration-process)),
   SFTP test credentials, the
   webhook signing secret, and the return-URL domain allowlisted).
3. **The provider's DebiCheck file and rule specification** (collection
   file layout, REPLY/OUTPUT layout, return codes, presentment and NPF rules)
   — every value in the unverified table above is checked against it.
4. **For EasyDebit specifically:** its API or file documentation; nothing
   public was found.

A live account (FICA onboarding, the lender's creditor short name, risk
limits) is the lender's contract with the provider and is needed only for go-live.
