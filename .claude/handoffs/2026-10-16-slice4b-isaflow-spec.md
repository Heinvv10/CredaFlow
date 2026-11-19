# Asset-finance slice 4b spec: AF journal sources and IsaFlow draft push

The headline is in §1.2: IsaFlow today has no endpoint that supports decision 9 as written. Only Hein can choose the way around it (G1 in §4). Package A (journal sources) does not depend on that choice and can start as soon as 4a is on main.

## 1. Facts

### 1.1 #89 extension points (merged 2026-10-15; paths relative to `/home/hein/Workspace/CredaFlow-af-s4-merge`)

| Point | file:line | What 4b changes |
|---|---|---|
| `ACCOUNT_ROLES`, `NOT_CARRIED_AT_OPENING`, `VAT_INCLUSIVE_ROLES`, `DEFAULT_ACCOUNTS` | `lib/accounting/accounts.ts:11,37,43,52` | Add the AF roles (§2.1) |
| `parseMappingInput` (refuses VAT-inclusive together with a tax code) | `accounts.ts:110` | Also refuse a tax code on roles whose VAT is posted explicitly |
| `SourceLoan`, `SourcePayment`, `DesiredSource`, `EventType` | `lib/accounting/source-types.ts:11,29,45,77` | Add `receivableRole`, an `assetFinance?` block, `SourcePayment.recoveryProceeds`, new EventTypes |
| `CHARGE_INCOME` map, `ordinarySources`, `loanSources` | `lib/accounting/sources.ts:51,91,182` | Branch on contract type. Charges, receipts and write-off use `loan.receivableRole` |
| `receiptVector` hard-codes `LOAN_BOOK` / `BANK` | `lib/accounting/sources-receipts.ts:10-25` | Parameterise the role. A recovery-proceeds receipt debits `RECOVERY_CLEARING`, not `BANK` |
| `desiredSources`, `deriveEntries`, `linesOf`, `delta` | `lib/accounting/derive.ts:322,333,272,251` | `desiredSources` also takes the AF loans and recoveries. Pure parts unchanged |
| `loadSourceLoans` filters `contractType: "LOAN"` | `lib/accounting/store.ts:55-80` | New loader for AF loans. Widen the `AccountingDb` type (`:19`) |
| `independentBook`, `journalBook` (only reads `LOAN_BOOK`), `compareBooks` | `lib/accounting/reconcile.ts:36,80,97` | AF CTEs. `journalBook` sums `RECEIVABLE_ROLES` |
| `planPeriod`, refusal codes | `lib/accounting/plan.ts:63,18,85` | Run the AF controls. Add refusals `AF_CONTROL_FAILED` and `MAPPING_NOT_CONFIRMED` for unconfirmed new roles |
| `closePeriod` (advisory lock, REPEATABLE READ, `SET CONSTRAINTS ALL IMMEDIATE`) | `lib/accounting/generate.ts:41` | Unchanged |
| Opening entry | `lib/accounting/opening.ts:26,40` | Works through `desiredSources`. AF P&L roles go into `NOT_CARRIED` |
| CSV: `renderCsv` and `linesDigest` read only stored lines | `lib/accounting/csv.ts:52,63` | **Nothing to build.** AF lines appear once they are in the ledger |
| Xero push: claim-before-send, `markStalePush`, `resolveXeroPush`, BANK-mapped check | `lib/accounting/xero/push.ts:86,69,175,97` | Template for the IsaFlow push |
| `XeroConnection` sealed under `WABA_ENC_KEY`, strict `open()` | `lib/accounting/xero/connection.ts:19-34` | Template for `IsaFlowConnection` |
| Push guard trigger `guardAccountingXeroPush` | `prisma/migrations/20261015090000_accounting_payouts/migration.sql:391-430` | Copy it for the IsaFlow push table |
| Models | `prisma/schema/accounting-payouts.prisma:11,36,120,143,152,374` | Add `IsaFlowConnection`, `AccountingIsaFlowPush`, `AccountingSettings.mappingConfirmedRoles` |
| A mapping change withdraws the confirmation | `app/api/accounting/mappings/route.ts:45` | Keep. Confirming also stores the list of roles confirmed |
| Push route: ADMIN plus TOTP only when the tenant's policy requires it | `app/api/accounting/batches/[id]/xero/route.ts:13`, `lib/accounting/route-helpers.ts:9` | IsaFlow push requires TOTP always (§2.4) |
| **TOTP-verified SUPER_ADMIN check** | `lib/security/policy-write-guard.ts:22-50` (`superAdminPolicyWrite`: `requireApiRole("SUPER_ADMIN")`, `totpVerified !== true` refused, role re-checked on the locked User row in the transaction). Unconditional-TOTP ADMIN variant: `lib/lender-api/settings-guard.ts:10` | Reuse for the IsaFlow connect |
| Sealed credentials | W0's helper **is on main**: `lib/integrations/tenant-credentials.ts:55` `sealCredential` (fails closed, refuses input that is already sealed). Its `openCredential` (`:63`) accepts legacy plaintext, so don't use it for reads | Seal with `sealCredential`. Open strictly with `isSealed` + `openSecret`, as Xero's `open()` does |

**4a sources (merge worktree; the schema is still in `prisma/schema.prisma` and has to move into `prisma/schema/asset-finance-recovery.prisma` during the merge):**
- `Recovery`: `proceedsPaymentId`, `surplusCents`, `shortfallCents`, `unrecoverableCostsCents`, `closedAt`, status.
- `RecoveryCost`: `netCents`/`vatCents`/`grossCents`, `treatment` DEDUCT_FROM_PROCEEDS | CHARGE_TO_ACCOUNT, `status` APPROVED, `incurredOn`.
- `RecoveryVatEvent`: `kind`, `eventDate`, `inputTaxClaimCents`, `outputTaxCents`.
- `RemarketingSale`: COMPLETED, `taxInvoiceId`, `priceInclVatCents`.
- `RecoveryRefund`: RELEASED, `releasedAt`.

Two behaviours matter for the journals:
- A charged cost is posted as `LoanCharge` type `RECOVERY_COST` (`prisma/schema/loans-payments.prisma:227`).
- The proceeds are ONE real `Payment` of min(net, settlement) through `applyManualReceipt` (`lib/asset-finance/recovery-proceeds.ts:20-30`).

**Slices 1–3:**
- Instalment sale (IS) and finance lease (FL) book one inception `TaxInvoice` on the VAT-inclusive cash price, dated the booking day (`lib/vat/tax-invoice.ts:239`, `lib/asset-finance/booking.ts:235`).
- `Loan.principal` = F + capitalised interest C (`lib/asset-finance/booking-plan.ts:9`, `schedule-records.ts:15-25`). It is **not** the amount paid out.
- Leases (OPERATING_LEASE, FULL_MAINTENANCE_LEASE only; `lease-input.ts:20`) book `Loan.principal` = the sum of ALL rentals including VAT (`lease-ledger.ts:5-20`). There is no inception invoice. Each rental gets its own `TaxInvoice`, dated the earlier of its due date and receipt (`lease-invoices.ts:1-15`).
- `MaintenanceFundMovement` kinds: CONTRIBUTION, CLAIM, SETTLEMENT_REFUND, SETTLEMENT_BILLED.
- AF `Payout.amountCents` = cash price incl. VAT − deposit − trade-in (`payout-checklist.ts:148`), with `releasedAt`.

**Consequence:** #89's consumer source logic must never see AF loans. "Debit `LOAN_BOOK` with principal" would be wrong for both IS (C) and leases (all future rentals).

### 1.2 IsaFlow contract (read-only, `/home/hein/Workspace/IsaFlow`)

- **The REST draft endpoint can't be used machine-to-machine.** `pages/api/accounting/journal-entries.ts:172` is `withAuth(withCsrf(withWriteAccess(...)))`:
  - `withAuth` (`src/lib/auth/withAuth.ts:44-52`) accepts only the GoTrue session cookie plus the active-company cookie. There is no Bearer token or API key.
  - The POST body (`:67`) is `{entryDate, description, source:'manual', fiscalPeriodId?, lines:[{glAccountId(UUID), debit, credit, description?, vatType?}]}` with amounts in rands.
  - It has **no `external_ref`**, and GET (`:46`) cannot filter by one.
- **Bearer auth exists only on `/api/mcp`.** That is JSON-RPC 2.0 `tools/call` (`pages/api/mcp/index.ts`, `withBearerAuth`).
  - Tokens are `pat_…` (personal access token) or `oat_…` (OAuth access token). The company is bound to the token (`src/lib/auth/bearerPipeline.ts`).
  - The company must have the `mcp_connector` feature flag (off by default). The limit is 120 requests a minute per company, and writes are Flow-metered.
- **`create_draft_journal`** (`src/lib/mcp/tools/writeJournals.ts:67-176`):
  - Scope `write:journals`. Args: `{date, memo, lines:[{account_id (UUID), debit, credit, description?, vat_type?}], idempotency_key (required)}`.
  - It creates a DRAFT and never posts. It refuses accounts that don't belong to the company and dates in a closed or locked period.
  - **No `external_ref` argument.**
- **Idempotency** (`src/lib/mcp/registry.ts:132-170`):
  - Concurrent calls with the same key are serialised.
  - Same key and same args (`argsHash`) → the stored result is replayed. Same key with different args → refused.
  - Refusals and dry runs free the key.
- **Read-back:** `list_journals` (`src/lib/mcp/tools/journals.ts:17`): date window, `status=draft`, `source`, `include_lines`. It has no `external_ref` filter, so a match has to use memo plus totals.
- **Chart of accounts:** `list_gl_accounts` (`src/lib/mcp/tools/reports.ts:123`, scope `read:reports`) returns code, name, type, `is_active` and id, paged by `next_cursor`.
- **Company:** `company_profile` (`company.ts:11`, any scope) returns name and VAT number.
- **Results** come back as `content[0].text` = a JSON string; refusals set `isError: true` (`toolHelpers.ts:9-17`).
- **`external_ref` columns** exist on `gl_journal_entries` with an index (`scripts/migrations/sql/530_external_ref_and_actor_identity.sql:91-124`). CONTRACTS.md §7 (`docs/mcp/CONTRACTS.md:625`) requires every document-creating tool to take one. **Nothing on the journal paths writes it yet.**

## 2. Design

### 2.1 New roles (`accounts.ts`; default codes in brackets)

- **Receivables:**
  - `AF_INSTALMENT_DEBTORS` (1110), for IS and FL.
  - `LEASE_DEBTORS` (1120).
  - `RECEIVABLE_ROLES = [LOAN_BOOK, AF_INSTALMENT_DEBTORS, LEASE_DEBTORS]` is used by write-off, receipts, charges and `journalBook`.
- **VAT:** `INPUT_VAT` (1300). `OUTPUT_VAT` already exists.
- **Lease assets:**
  - `LEASED_ASSETS` (1500): cost excl. VAT. Depreciation stays in IsaFlow's fixed-asset register.
  - `ASSET_DISPOSAL_PROCEEDS` (4600).
- **Lease income and maintenance:**
  - `RENTAL_INCOME` (4100).
  - `MAINTENANCE_INCOME` (4110).
  - `MAINTENANCE_FUND_LIABILITY` (2400).
  - `MAINTENANCE_EXPENSE` (6100).
- **Recovery:**
  - `RECOVERY_CLEARING` (2500): per recovery. It must net to zero once proceeds are applied or the recovery is withdrawn.
  - `RECOVERY_COSTS_PAYABLE` (2510): settled through IsaFlow AP.
  - `RECOVERY_COST_EXPENSE` (6200).
  - `RECOVERY_COSTS_RECHARGED` (6210, contra-expense).
  - `RECOVERY_REFUND_PAYABLE` (2520).
  - `RECOVERY_RESULT` (6300, the gain or loss from recovery VAT and costs).
- **Not carried at opening** (P&L): `RENTAL_INCOME`, `MAINTENANCE_INCOME`, `MAINTENANCE_EXPENSE`, `RECOVERY_COST_EXPENSE`, `RECOVERY_COSTS_RECHARGED`, `RECOVERY_RESULT`, `ASSET_DISPOSAL_PROCEEDS`.
- `EXPLICIT_VAT_ROLES` (the AF income roles): `parseMappingInput` refuses a tax code on them, because the VAT is already a separate line and Xero's inclusive mode would count it twice.
- **Mapping gate:** a new additive column `AccountingSettings.mappingConfirmedRoles String[]`, written on confirm. `planPeriod` refuses `MAPPING_NOT_CONFIRMED` when any entry uses a role that isn't in the list. This stops a tenant's earlier confirmation from silently covering the new roles.

### 2.2 Sources (new `lib/accounting/sources-asset-finance.ts` and `sources-recovery.ts`; dispatched from `loanSources` when `loan.assetFinance` is set)

Signs are Dr+ / Cr−. Every base key is new, so consumer keys are untouched.

| # | Source / baseKey | Table and date | Vector |
|---|---|---|---|
| 1 | IS/FL inception `af:<loanId>:inception` | Inception `TaxInvoice` (loanId, the earliest one), `supplyDate`. AF `Payout.releasedAt` | Dr AF_INSTALMENT_DEBTORS F; Dr INPUT_VAT inv.vat; Cr OUTPUT_VAT inv.vat; Cr BANK payout; Cr FEE_INCOME financedFees (the existing VAT-inclusive split applies). F = cash incl. − deposit − trade-in + fees; **assert F = the first row's `assetFinanceOpeningBalanceCents`** |
| 2 | IS/FL instalment `af:<loanId>:row:<scheduleId>` | `RepaymentSchedule`, due date (completed/written-off handled like `raisedOn`) | Dr receivable accrued_r; Cr INTEREST_INCOME accrued_r, where accrued_r = interestDue + capitalised interest (B_{r+1} − B_r + totalDue_r). The balloon is principal already inside F, so it posts nothing of its own; a test pins this |
| 3 | Lease inception `lease:<loanId>:asset` | AF `Payout.releasedAt` | Dr LEASED_ASSETS cash excl.; Dr INPUT_VAT vat; Cr BANK payout. Deposit or trade-in ≠ 0 → plan refusal `AF_SOURCE_UNSUPPORTED` |
| 4 | Lease rental `lease-rental:<leaseRentalId>` | `LeaseRental` with `taxInvoiceId`, `TaxInvoice.supplyDate` | Dr LEASE_DEBTORS total; Cr RENTAL_INCOME rentalExcl; Cr MAINTENANCE_INCOME maintExcl; Cr OUTPUT_VAT vat. `cancelledAt` before an invoice → 0 |
| 5 | Lease sundry invoice `lease-invoice:<taxInvoiceId>` | Other `TaxInvoice` on a lease loan (end of term, termination), `supplyDate` | Dr LEASE_DEBTORS incl.; Cr OUTPUT_VAT; Cr ASSET_DISPOSAL_PROCEEDS for a purchase at residual, else Cr RENTAL_INCOME. **Package A must first prove whether these invoices sit on the loan's receivable** (open question Q3) |
| 6 | Maintenance fund `mf:<movementId>` | `MaintenanceFundMovement.occurredOn`, fund `riskModel` | LESSEE_SETTLED: CONTRIBUTION Dr MAINTENANCE_INCOME / Cr MAINTENANCE_FUND_LIABILITY; CLAIM Dr liability / Cr BANK; SETTLEMENT_REFUND Dr liability / Cr BANK; SETTLEMENT_BILLED Dr MAINTENANCE_INCOME / Cr liability (its invoice is #5). LENDER_RISK: CLAIM Dr MAINTENANCE_EXPENSE / Cr BANK; nothing else |
| 7 | Recovery cost `recovery-cost:<id>` | `RecoveryCost` APPROVED, `incurredOn` | DEDUCT: Dr RECOVERY_CLEARING net. CHARGE: Dr RECOVERY_COST_EXPENSE net. Both: Dr INPUT_VAT vat; Cr RECOVERY_COSTS_PAYABLE gross |
| 7b | Charged cost on the account | Existing charge source, `LoanCharge` RECOVERY_COST | Add `RECOVERY_COST → RECOVERY_COSTS_RECHARGED` to `CHARGE_INCOME`; the receivable is debited |
| 8 | Repossession VAT `recovery-vat:<eventId>` | `RecoveryVatEvent` REPOSSESSION_DEEMED_SUPPLY, `eventDate` | Dr INPUT_VAT inputTaxClaim; Cr RECOVERY_CLEARING. LESSOR_RESALE posts nothing here (its VAT is on #9) |
| 9 | Remarketing sale `recovery-sale:<saleId>` | `RemarketingSale` COMPLETED, buyer `TaxInvoice.issueDate` | Dr BANK priceIncl; Cr OUTPUT_VAT inv.vat; Cr RECOVERY_CLEARING inv.exclVat |
| 10 | Proceeds applied | Existing receipt source for `Recovery.proceedsPaymentId` (`recoveryProceeds=true`) | Dr RECOVERY_CLEARING (not BANK, because the cash came in at #9); Cr receivable |
| 11 | Surplus `recovery:<id>:surplus` | `Recovery.surplusCents`, proceeds receivedAt | Dr RECOVERY_CLEARING; Cr RECOVERY_REFUND_PAYABLE |
| 12 | Refund payout `recovery-refund:<id>` | `RecoveryRefund` RELEASED, `releasedAt` | Dr RECOVERY_REFUND_PAYABLE; Cr BANK |
| 13 | Recovery result `recovery:<id>:result` | Proceeds applied or WITHDRAWN (`closedAt`) | Clears the remaining RECOVERY_CLEARING (= output VAT − deemed input VAT − input VAT on deducted costs) to RECOVERY_RESULT |
| — | Shortfall | — | No entry. It stays on the receivable, and write-off remains the manual #89 write-off source |

- **Payments:** every other AF `Payment` uses the generic receipt source with `receivableRole`.
- **Writing everything off:** the write-off sums the receivable role.
- **Disposal:** on a lease asset, derecognising the net book value is the accountant's entry in IsaFlow. It is documented, not posted.
- **Markers:** every AF source carries `// UNTESTED: tax|accounting` markers (inception input VAT, the recharged-cost VAT, the sale-cash timing).

### 2.3 Reconcile extensions (`reconcile.ts`; new `reconcile-asset-finance.ts`)

All of this is independent SQL that never imports `sources-*`.

1. **`independentBook`:** keep the `LOAN` CTE byte-for-byte. Add:
   - **`af_is`** (IS/FL, included once the inception invoice `supplyDate` < asOf): opening balance (`assetFinanceOpeningBalanceCents`) of the earliest row with an effective due date ≥ asOf (0 if there is none) + Σ `totalDue` of due rows + charges − applied receipts. It uses the same write-off, cancelled and completed rules, and a written-off loan gives `LEAST(0, …)`. This telescoped identity does not use F, so it cross-checks source #1's F against the schedule.
   - **`af_lease`:** Σ `LeaseRental.totalCents` whose invoice `supplyDate` < asOf + Σ lease sundry invoices on the receivable (Q3) + charges − applied receipts.
2. **`journalBook`:** sum lines whose role is in `RECEIVABLE_ROLES`, still per loan.
3. **New controls**, each returned as a `{control, key, journalCents, bookCents}` mismatch. `planPeriod` refuses `AF_CONTROL_FAILED` when any of them differs:
   - (a) AF output VAT to date = Σ `TaxInvoice.vatCents` on AF loans and buyer invoices − Σ `CreditNote.vatCents`.
   - (b) AF input VAT = inception and lease invoice VAT + Σ `RecoveryVatEvent.inputTaxClaimCents` + Σ approved `RecoveryCost.vatCents`.
   - (c) `RECOVERY_CLEARING` per recovery = 0 once proceeds are applied or it is withdrawn.
   - (d) `RECOVERY_REFUND_PAYABLE` per recovery = `surplusCents` − released refund.
   - (e) `MAINTENANCE_FUND_LIABILITY` per LESSEE_SETTLED fund = the signed SQL sum of its movements.

### 2.4 IsaFlow connection and push (`lib/accounting/isaflow/`)

- **`client.ts`:** a thin JSON-RPC client over `fetch` with the `IsaFlowHttp` injection, like `XeroHttp`.
  - Calls: `companyProfile`, `listGlAccounts` (follows the cursor), `createDraftJournal`, `listDraftJournals(date)`.
  - Errors are `IsaFlowError` with kind `definite | unknown | auth | config`. A 4xx or `isError` is definite; a network error or 5xx is unknown.
  - The transport sits behind an interface so a REST adapter can be dropped in once IsaFlow ships one (G1).
- **`connection.ts`, model `IsaFlowConnection`:**
  - Fields: `tenantId @unique`, `status` (CONNECTED | NEEDS_RECONNECT | DISCONNECTED), `baseUrl`, `tokenSealed` (`sealCredential`), `tokenKind` (PAT | OAUTH), `isaflowCompanyId`, `isaflowCompanyName`, `connectedById`, `connectedAt`, `connectedWithTotp Boolean`, `lastVerifiedAt`, `disconnectedAt`, timestamps.
  - Trigger `guardIsaFlowConnection`: CONNECTED requires `connectedWithTotp = true` and that `connectedById` is a SUPER_ADMIN User of the same tenant.
  - `baseUrl` must be https and in `ISAFLOW_ALLOWED_ORIGINS` (env). Loopback http is allowed only when `NODE_ENV=test`. Run it through the SSRF helpers in `lib/lender-api/webhooks/`.
  - On connect: call `company_profile` and `list_gl_accounts` to prove the scopes, then store the company name and id.
- **Route `app/api/integrations/isaflow/route.ts`:**
  - GET: ADMIN; returns the status and never the token.
  - POST `connect`, `verify`, `disconnect`: through `superAdminPolicyWrite` (TOTP-verified SUPER_ADMIN, role re-checked on the locked row). Every action is audited.
- **Model `AccountingIsaFlowPush`:**
  - Fields: `batchId @unique` (FK to the CLOSED batch), `tenantId`, `status` (reuses `AccountingPushStatus`), `externalRef` (= batchId), `idempotencyKey` (= `credaflow:batch:<batchId>`, stable across retries), `requestJson Json`, `requestSha256`, `isaflowCompanyId`, `isaflowJournalId`, `foundOnReadBack Boolean`, `error`, `pushedById`, `resolvedById`, `resolutionNote`, timestamps.
  - Trigger `guardAccountingIsaFlowPush`: a copy of the Xero guard, plus `requestSha256`, `idempotencyKey` and `isaflowCompanyId` immutable once set, and `isaflowJournalId` write-once.
- **`push.ts` `pushBatchToIsaFlow(db, {tenantId, batchId, actor}, http)`** runs in this order:
  1. Load the CLOSED batch with `loadBatchLines` (digest-checked).
  2. **Refuse an unmapped role:** every line role needs a stored `AccountingAccountMapping` whose `accountCode` equals the line's code. A remap since the close is refused with "post from CSV".
  3. **Chart check:** every code must exist and be active in `list_gl_accounts`. Codes map to UUIDs here. A missing or inactive code is a 422 that lists them, and nothing is claimed.
  4. Build the args once: one line per account, net, debit/credit in rands to 2 decimals. Memo: `CredaFlow journals <label> [credaflow:<batchId>]`. Date: `period.lastDay`.
  5. Claim SENDING, storing `requestJson` and its sha.
  6. Send `create_draft_journal` with the stable key.
  7. Record PUSHED, FAILED or NEEDS_REVIEW, and audit.
- **Read-back before any retry:** FAILED → SENDING and every NEEDS_REVIEW `check` first call `findPushedDraft` (`list_journals` on `period.lastDay`, `status=draft`, `include_lines`, matching the memo tag and the line totals).
  - Found → PUSHED with `foundOnReadBack`.
  - Not found → resend the stored `requestJson` byte-for-byte with the same key. IsaFlow then replays rather than duplicating.
- **Stale SENDING:** after 10 minutes it becomes NEEDS_REVIEW, as for Xero. `resolveIsaFlowPush` handles the manual answer.
- **Push route** `app/api/accounting/batches/[id]/isaflow/route.ts` (`push | check | resolve`): ADMIN with TOTP required unconditionally (the `requireApiSettingsAdmin` style).
- **Audit actions** (`lib/registry/audit-actions/accounting-payouts.ts`): `ISAFLOW_CONNECTED`, `ISAFLOW_DISCONNECTED`, `ISAFLOW_CONNECT_REFUSED`, `ACCOUNTING_ISAFLOW_PUSH_CLAIMED|RESULT|RESOLVED|READBACK`.
- **UI:**
  - `components/settings/IsaFlowConnectionCard.tsx` on `app/(dashboard)/settings/integrations/page.tsx`.
  - An IsaFlow push button and status in `components/accounting/AccountingExportPanel.tsx`.
  - An "Asset finance" group in `AccountMappingEditor.tsx`.
- **Docs:** update `lib/accounting/.claude.md` (remove "Consumer loans only").

### 2.5 Fake IsaFlow (`lib/accounting/isaflow/fake-isaflow.integration-fixture.ts`)

- A `node:http` server on port 0 serving `POST /api/mcp` JSON-RPC:
  - Checks the Bearer `pat_` token and its scopes.
  - Implements `company_profile`, `list_gl_accounts` (with paging and inactive accounts), `create_draft_journal` (balance check, account ownership, key plus argsHash replay or conflict, refusals free the key) and `list_journals`.
- Knobs:
  - `failNext('500' | '401' | 'refuse' | 'flows')`.
  - `commitThenDrop()`: writes the draft, then destroys the socket, simulating an unknown outcome.
  - `deleteDraft(id)`.
  - `calls[]` for assertions.
- `contract.ts` holds the reply types with the IsaFlow file:line references from §1.2. A unit test pins the fake to them.

## 3. Work packages (TDD; ITs via `scripts/it-db.sh` with a unique name; `RUN_ACCOUNTING_IT=1`)

Order: **A** after 4a is merged. **B** can run in parallel with A (it shares only `accounts.ts`, which belongs to A). **C** after A and B.

**WP-A: AF sources and reconcile.**
- Owns: `accounts.ts`, `source-types.ts`, `sources.ts`, `sources-receipts.ts`, `sources-asset-finance.ts`, `sources-recovery.ts`, `store.ts` (new `loadAssetFinanceLoans`), `reconcile.ts`, `reconcile-asset-finance.ts`, `plan.ts`, `opening.ts`, the settings/mappings routes (`mappingConfirmedRoles`), the migration `…_accounting_af_roles` (additive column), and `AccountMappingEditor.tsx`.
- Tests, red first:
  - A pure test per source row #1–#13. Each uses an independent worked example to the cent next to `acceptance-deals.ts`: SYN IS with balloon and skip period, SYN FL, LSE FML LESSEE_SETTLED and LENDER_RISK, a recovery with shortfall and one with surplus. `CLIENT_DEALS` stays empty.
  - Every vector sums to zero.
  - The consumer suites `derive*.test.ts`, `accounting.integration.test.ts` and `cutover` stay unmodified and green.
  - IT: close 3 months for a tenant holding all deal types and a recovery. Each must tie, and every AF control must be 0.
  - Mutations, each turning the IT red: drop capitalised interest; post the IS receivable at `principal`; debit BANK on the proceeds receipt; skip the result clear.
  - IT: CSV of an AF batch contains the AF lines (generic and sage). Sage tax codes on explicit-VAT roles are refused.
  - IT: a new role not yet confirmed refuses the close.

**WP-B: IsaFlow connection, push and fake.**
- Owns: `lib/accounting/isaflow/*`, `app/api/integrations/isaflow/route.ts`, `app/api/accounting/batches/[id]/isaflow/route.ts`, the migration `…_isaflow_connection_push` (tables plus the two guard triggers), the audit registry, `IsaFlowConnectionCard.tsx`, and the `.env.example` keys.
- Tests:
  - Client unit tests (error kinds, rands formatting, cursor paging).
  - Route tests: ADMIN without TOTP gets 403; SUPER_ADMIN without TOTP gets 403; a role demoted between check and write is refused.
  - IT (`isaflow.integration.test.ts`): two pushes produce one draft (claim plus key replay). `commitThenDrop` → NEEDS_REVIEW → `check` finds it on read-back → PUSHED with no second create. A deleted draft gets resent with the same key. An unmapped role is refused before any HTTP call. An unknown or inactive code is refused before the claim.
  - IT for the guard triggers: DELETE refused, PUSHED→SENDING refused, a changed `requestSha256` refused, CONNECTED without a SUPER_ADMIN refused.
  - A cross-tenant push or batch id gives 404.
  - A sealed token never appears in a GET or in audit rows.

**WP-C: integration and evidence.**
- Owns: `AccountingExportPanel.tsx`, `reports/accounting/page.tsx`, the seed (AF months closable), `docs/asset-finance/evidence/slice4b/`, the DESIGN.md section, and `.claude.md`.
- Work: a browser run (ADMIN with TOTP, light and dark, 390 px): map roles → confirm → close month → CSV → connect the fake IsaFlow → push → re-push refused.
- Then the breaker run on "pushing twice to IsaFlow", plus remapping after close and a stale SENDING.

**Gates for every package:** `npm run ci:quality` and `ci:integration` green, then a blind `/review` and a breaker to SHIP, then merge with `mq add`. The NCA PDF pins and the 4a suites stay untouched.

## 4. Risks and open questions (for Hein)

- **G1 (blocking WP-B's transport):** decision 9 assumes "REST, `external_ref`, not MCP". IsaFlow has neither a Bearer-authenticated REST journal endpoint nor `external_ref` on journals (§1.2), and we may not edit IsaFlow. Options:
  - (a) Use `/api/mcp` `create_draft_journal` with a PAT. This works today; idempotency comes from the server-side key, and the reference is a memo tag.
  - (b) Commission IsaFlow, as a separate session, to add Bearer auth and `external_ref` to the REST endpoint and an `external_ref` filter to `list_journals`.
  
  Recommendation: build (a) behind the transport interface now and switch to (b) once IsaFlow ships it.
- **G2:** live push to the dev company only. Hein provides:
  - the dev company;
  - a PAT with `write:journals` and `read:reports` (or an OAuth app if he prefers OAuth);
  - `mcp_connector` turned on for that company;
  - Flow credits;
  - its base URL for `ISAFLOW_ALLOWED_ORIGINS`.
  
  Until then criterion §7.7 is "blocked on Hein".
- **Q1 (accountant sign-off, UNTESTED):**
  - inception input VAT claimed on the dealer's invoice;
  - interest recognised as it falls due (no deferred finance income);
  - VAT on recharged recovery costs;
  - the recovery-result account;
  - lease net book value derecognised in IsaFlow, not here.
- **Q2:** the sale cash date. Source #9 assumes the buyer pays on completion. If cash can arrive later, add a `REMARKETING_DEBTORS` role.
- **Q3:** whether end-of-term and termination invoices sit on the lease loan's receivable. WP-A proves this first; source #5 depends on it.
- **Q4: catch-up.** Tenants that already closed months under consumer-only #89 will post their whole AF history in the next open month, labelled by origin. The alternative is AF opening positions. Hein to choose.
- **Q5: account UUID drift.** UUIDs are resolved at push time. A renamed code in IsaFlow between the chart check and the push leads to a definite refusal, never a misposting.
- **Merge dependency:** 4a's models must move from `prisma/schema.prisma` into `prisma/schema/` before 4b starts (the merge worktree is mid-resolution: conflicts in `lib/tenant-scope.ts`, `lib/audit.ts` and the schema).

### Critical Files for Implementation
- /home/hein/Workspace/CredaFlow-af-s4-merge/lib/accounting/sources.ts
- /home/hein/Workspace/CredaFlow-af-s4-merge/lib/accounting/reconcile.ts
- /home/hein/Workspace/CredaFlow-af-s4-merge/lib/accounting/accounts.ts
- /home/hein/Workspace/CredaFlow-af-s4-merge/lib/accounting/xero/push.ts
- /home/hein/Workspace/IsaFlow/src/lib/mcp/tools/writeJournals.ts