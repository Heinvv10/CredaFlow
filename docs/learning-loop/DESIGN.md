# Learning loop: design

Status: PR A (decision log, including the automated-refusal records) implemented on `feat/learning-loop-a-decision-log`;
PR B (outcome job) implemented on `feat/learning-loop-b-outcomes`, stacked on
PR A; PR C (dashboard) implemented on `feat/learning-loop-c-dashboard`,
stacked on PR B. Part 4
(cross-lender benchmarks) is design only. Every legal point is marked
**needs lender legal sign-off**; a citation I could not confirm is marked
**to verify**.

The decisions taken in the brainstorm (2026-10-21; notes kept outside the
repository) are applied throughout: record what the existing gates said, do
not invent a score; one append-only row per decision event; demo stacks prove
the plumbing; the first real data is a pseudonymised external extract.

## Decisions (Hein, 21 Oct 2026)

These override anything below that conflicts; the sections cited apply them.

1. **90+ DPD is the default and the headline outcome.** 60 DPD is a
   collections escalation step only, never "default" (§3). The escalations
   cron still flips ACTIVE → DEFAULTED at 60 (`lib/collections/escalation.ts`),
   which conflicts with this decision. These PRs do not change collections
   behaviour: aligning that flip with 90 is a **decided follow-up that needs
   its own PR** (§7). Closes former open question 1.
2. **The dashboard (v1) is read-only, per lender, for ADMIN and compliance
   roles only.** The repo has no COMPLIANCE role; ADMIN stands in for the
   lender's compliance officer (as for `manage_fic_compliance`,
   `lib/registry/permissions/030-fic.ts`), and SUPER_ADMIN ranks above it.
   No LOAN_ADMIN, no operator console, no write actions (§6). Closes former
   open question 2.
3. **Settling after 30+ DPD is not a cure.** `CURED` = back to 0 DPD after
   30+ DPD while the loan is still open. Settlement after delinquency is its
   own outcome, `SETTLED_AFTER_DELINQUENCY` (§3).
4. **Simulated and demo results never reach a real lender's figures**
   (`CollectionResult.simulated` and the other `simulated` rows, demo or
   seeded tenants and records). On a demo tenant the figures are shown, and
   labelled on screen as simulated / demo data (§4, §5, §6).
5. **The automated portal and website refusals are logged now**: a
   `CreditDecisionRecord` per refusal, `actorType SYSTEM`, flagged
   `s71ReviewRequired` for the lender's POPIA s71 legal review (§2.5, §9.1).
   That legal review is a **go-live gate**: it happens before the first real
   lender goes live (§7). Closes former open question 4.
6. **The external-extract field list is approved, but nothing is pulled**
   until (a) the operator agreement, (b) the bureau data terms and (c) an
   export run by the source lender itself are all in place (§4.1). No code
   or document in this repository names the source lender.

## 1. Goal and thesis

For a lender, the only ground truth is whether money arrives. So every credit
decision, offer and collection action must be recorded in a form whose later
repayment or debit-order outcome can be joined back to it. The loop answers
"when we said yes, were we right, and when we chased, did it work?"

CredaFlow already proves a decision was *lawful* (affordability snapshot
fingerprints, DB-backed bureau, rate-cap, screening and credit-check gates).
Nothing looks back once the money is out. The loop closes that gap.

Credit decisions stay with a person. The system records what its gates said
(the "recommendation") and what the named staff member decided. Where the
code decides alone today (portal and website submission refusals) the log
marks it `actorType = SYSTEM` and this document flags it for legal (§9).

Four parts:

1. **Decision log** (PR A, built): `CreditDecisionRecord`.
2. **Outcome feedback job** (PR B, built): a nightly, idempotent, tenant-swept job
   deriving `DecisionOutcome` rows from the servicing tables.
3. **Per-lender dashboard** (PR C, built): approval-to-outcome by cohort, policy
   version, override; descriptive collection performance.
4. **Cross-lender benchmarks** (design only, §8).

Honest limits today: no lender has real outcomes; the simulator's outcomes
are authored; no model produces a probability; debit-order collection is a
stub outside the simulator (`lib/integrations/collections/netcash.ts`). v1's
value is compliance infrastructure (an immutable decision record, POPIA s71
visibility); learning claims wait for a real book.

## 2. Part 1: the decision log (PR A)

### 2.1 Schema

`prisma/schema/learning-loop.prisma` (a new domain file, as
`docs/ARCHITECTURE.md` "The Prisma schema" allows), migrations
`prisma/migrations/20261021090000_credit_decision_record` and
`prisma/migrations/20261021100000_decision_record_automated_refusal` (`leadId`,
`s71ReviewRequired`, the widened subject CHECK; decision 5).

| Column | Type | Meaning |
|---|---|---|
| `id` | text cuid | |
| `tenantId` | text, FK `Tenant` (RESTRICT) | the lender |
| `kind` | enum `DecisionRecordKind` {`CREDIT_DECISION`, `OFFER`, `COLLECTION_ACTION`} | |
| `decision` | text, CHECK `^[A-Z][A-Z_]{1,39}$` | `APPROVE`, `DECLINE`, `REFER`, `RETURN_TO_REVIEW`, `RETURN_TO_DRAFT`, `CLEAR_FLAG`, `APPROVED_TERMS`, `QUOTATION_ISSUED` (`DECISION_CODES`, `lib/learning-loop/decision-log.ts`) |
| `recommendation` | enum `DecisionRecommendation` {`PASS`, `BLOCK`, `REFER`, `NONE`} | what the gates said; `NONE` = no gate evaluated for this event |
| `overridden` | bool | the person went against a gate |
| `overrideReason` | text? | CHECK: present (≥10 chars trimmed) exactly when `overridden` |
| `actorType` | enum `DecisionActorType` {`STAFF`, `SYSTEM`, `CLIENT`} | CHECK: STAFF names `actorUserId`, SYSTEM names nobody |
| `actorUserId`, `actorRole` | text? | ids only, no FK |
| `applicationId`, `loanId`, `clientId`, `leadId` | text? | subject ids, no FK; CHECK `_has_subject_or_lead`: at least one set. `leadId` is for a website refusal that confirms no client (§2.5) |
| `sourceEntityType`, `sourceEntityId` | text | the row of record changed: `LoanApplication`, `ApplicationCheckFlag`, `AssetFinanceDeal` |
| `ruleVersion` | text | `decision-log-v1+<code rule version>`, e.g. `+approval-ndi-v3` (`APPROVAL_AFFORDABILITY_POLICY_VERSION`, `lib/affordability/snapshot.ts:20`), `+pasq-v3`, `+af-deal-decision-v1`, `+credit-checks-unversioned` |
| `policyHash` | char(64), CHECK hex | sha256 of canonical JSON of the tenant's effective thresholds: `TenantConfig.bureauMinScore`, `bureauBlockAdverse`, `ndiBufferPct`, `bureauMaxAgeDays` (effective value via `bureauMaxAgeDays()`, `lib/compliance/bureau.ts:17`) |
| `modelVersion` | text? | null: no model today |
| `predictedProbability` | decimal(6,5)? | CHECK in [0,1]; null today |
| `inputsSnapshot` | jsonb object | minimised, banded inputs (§2.3) |
| `evidenceRefs` | jsonb object | ids and fingerprints of the evidence of record |
| `inputsHash` | char(64), CHECK hex | sha256 of `canonicalJson({ exactInputs, evidenceRefs, policy })` (`lib/canonical-json.ts`) |
| `s71ReviewRequired` | bool, default false | an automated decision awaiting the lender's POPIA s71 legal review (decision 5); CHECK `_s71_review_automated`: only on `SYSTEM` rows |
| `decidedAt` | timestamp | the decision's own timestamp (same value the route writes on the row of record) |
| `createdAt` | timestamp | |

Indexes: `(tenantId, applicationId)`, `(tenantId, loanId)`,
`(tenantId, kind, decidedAt)`.

Why no FKs on subject ids: an `ON DELETE SET NULL` would be an UPDATE the
append-only trigger refuses, and the record must outlive edits to its
subject. Joins are by id, as `AuditLog.entityId` is.

Why a dedicated table rather than `AuditLog`: `AuditLog`
(`prisma/schema/tenancy.prisma`) is generic JSON and mutable (only
`ASSET_NCA_QUOTE_ISSUED` rows are guarded), its `LOAN_APPROVED` row carries
no bureau band, NDI, thresholds or policy version, and
`LoanApplication.affordabilityResult` is rewritten by return-to-review and
return-to-draft (`app/api/applications/[id]/decide/route.ts`, the two
`updateMany` calls that null the approval columns). The audit row stays the
legal record of the state change; the decision record is the analytical one.

### 2.2 Enforcement

- **Append-only**: `CreditDecisionRecord_append_only` (BEFORE UPDATE OR
  DELETE, per row) and `CreditDecisionRecord_guard_truncate` (BEFORE
  TRUNCATE, per statement), function `guardCreditDecisionRecord()`, the same
  pattern as `LoanArrearsSnapshot`
  (`prisma/migrations/20261017090000_loan_arrears_snapshot`) and
  `AuditLog_nca_quote_issued_immutable`
  (`prisma/migrations/20261018140100_lender_asset_templates/migration.sql`).
  Test teardown that must delete runs under
  `session_replication_role = replica` (as `cleanupDealFixture` does).
  What this does not stop: the table owner or a superuser can
  `ALTER TABLE … DISABLE TRIGGER`, or set `session_replication_role =
  replica` (which needs superuser, or a role granted `SET` on it) and then change or delete rows. The
  guarantee is only as strong as "the application's database role does not
  own the table and is not a superuser". Nothing in this migration enforces
  that (no `REVOKE`, no ownership change); it is a deployment requirement,
  and the RLS integration suites already assume an app role that is neither.
- **CHECKs**: `_hashes_sha256`, `_decision_code`, `_probability_range`,
  `_override_reason`, `_actor`, `_has_subject_or_lead` (replaced
  `_has_subject` in `20261021100000`), `_s71_review_automated`,
  `_json_objects`.
- **Tenancy**: registered in `lib/registry/tenant-scoped-models/250-learning-loop.ts`
  (the extension in `lib/tenant-scope.ts` scopes it); RLS
  ENABLE + FORCE + `tenant_isolation` policy as every tenant table
  (`20261014130000_tenant_rls`). `lib/tenant-isolation.integration.test.ts`
  picks it up through `TENANT_SCOPED_MODELS`.
- **Rollback** (in the migration header too):

```sql
BEGIN;
DROP TABLE "CreditDecisionRecord";
DROP FUNCTION public."guardCreditDecisionRecord"();
DROP TYPE "DecisionRecordKind";
DROP TYPE "DecisionRecommendation";
DROP TYPE "DecisionActorType";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021090000_credit_decision_record';
COMMIT;
```

  Rollback of `20261021100000_decision_record_automated_refusal` (first; in
  its header too). The restored `_has_subject` fails while a record names
  only a lead (append-only, so it cannot be deleted): export those first and
  run this only on a database that holds none. Proven on a throwaway
  database (down, then `migrate deploy` again).

```sql
BEGIN;
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_s71_review_automated";
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_has_subject_or_lead";
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject"
  CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL);
ALTER TABLE "CreditDecisionRecord" DROP COLUMN "s71ReviewRequired";
ALTER TABLE "CreditDecisionRecord" DROP COLUMN "leadId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021100000_decision_record_automated_refusal';
COMMIT;
```

### 2.3 Inputs: minimised snapshot, hash, references (POPIA s10)

`lib/learning-loop/records.ts` and `records-asset-finance.ts` build every
record by reading named fields. A row handed to a builder (the route passes
the `CreditBureauCheck` row) is never spread, so its other columns cannot
reach the log; `records.test.ts` passes rows salted with synthetic ID number,
names, email, phone, bank account and a bureau payload and asserts none of
it appears in any stored column, and that no `*Cents` key reaches a snapshot.

Stored, per consumer approval:
- `productType`, `amountBand` (rands: <1000, 1000-4999 … 1000000+), `termDays`,
  `incomeBand` (rands/month: <5000 … 80000+);
- `bureau`: gate `PASS | BLOCK | MISSING`, `blockCode` (`DECEASED`,
  `DEBT_REVIEW`, `JUDGEMENT`, `NOTICE`, `ADVERSE`, `OBLIGATIONS_UNKNOWN`,
  `UNCALIBRATED`, `UNSCOREABLE`, `BELOW_MIN_SCORE`, `SIMULATED`,
  `BUREAU_MISSING`, `OTHER`; `lib/learning-loop/bureau-code.ts`, tested for
  agreement with `evaluateBureauGate`), `scoreBand` (Sigma 480-710 in 50s),
  provider, overridden, `reasonGivenUnneeded` (staff sent a bureau override
  reason although the gate passed: the application row stores it as an
  override, the log records `PASS`, not overridden, and says a reason was
  given);
- `affordability`: gate, `ndiCoverBand` (NDI ÷ required NDI: <1.00 …
  3.00+);
- `creditChecks`: count and `check:code` of flags cleared;
- `screening` state; `thresholds` (the four TenantConfig values).

Offer (approved terms): amount band, term, `interestRatePm`, instalment band,
credit life yes/no, repayment method. PASQ: amount band, term, instalment
band, credit-life election. Asset finance: product, `ncaRegime`, amount band,
term, DSCR and gearing bands, credit memo present, s81 state, exception
*counts by kind* (the exception keys name related parties' loans and are not
stored). Decline: `declineCategory` only (`lib/applications/decline-category.ts`),
never the client reason or internal note.

`evidenceRefs`: `bureauCheckId`, affordability `policyVersion`,
`inputFingerprint`, `decisionFingerprint` (`AffordabilityDecisionSnapshot`,
`lib/affordability/snapshot.ts:209`), sorted `creditCheckFlagIds`,
`pasqDocumentSha256` / `pasqEvidenceSha256`, `assetFinanceDealId`,
`exceptionsFingerprint`. These point at the source of record; the full
inputs live there (`LoanApplication.affordabilityResult`,
`CreditBureauCheck`), not here.

`inputsHash` covers the exact (unbanded) values the decision used plus the
refs and policy. It lets an auditor re-derive the record from the source of
record and lets analysis group identical inputs. The exact values are not
stored in the record, but the hash is **not** a confidentiality control: it
is an unkeyed sha256, and the refs and policy it covers are stored on the
same row (`evidenceRefs`, and the policy behind `policyHash` is a handful of
known thresholds). What stands between a reader of the log and the exact
values is therefore only the entropy of the exact inputs within their stored
bands:
- decline, return and flag-clear rows hash an enum or a check code that the
  snapshot already shows; nothing beyond the snapshot is hidden;
- PASQ and asset-finance rows (a decline with no credit memo hashes the amount
  in cents, the term, a few flags and the regime) can be recovered by
  enumerating the amount within its band, about 10⁹–10¹⁰ guesses;
- consumer approvals hash several independent exact values (income, NDI,
  required NDI, bureau score, premium), a larger joint space, but not one to
  rely on.
The exact values live in the source of record, so this discloses nothing a
reader of the lender's application tables cannot already see; it matters
once the log is read by anyone else (an analytics export, §8). **Follow-up**:
make `inputsHash` an HMAC-SHA256 under a per-deployment secret held outside
the database, before any such reader exists.

Never stored: ID numbers, names, contact details, bank details, raw bureau
payloads (`obligations`, accounts), exact amounts, decline/return reason text.
Stored free text: `overrideReason` only (bureau override, flag clear reason,
AF exception reason), because POPIA s71(3) representations and an NCR query
need it. It is staff-written and may contain personal information. Neither
a retention rule (§2.7, not built) nor a DSAR export (`app/api/dsar/*` tracks
requests only) covers this table today; both are **follow-ups**, and until
they exist a DSAR for a client must include this table's
`overrideReason`s by hand (query by `clientId` / `applicationId`).

### 2.4 Recommendation vs decision

| Event | recommendation | overridden |
|---|---|---|
| Consumer approve, bureau gate passed | `PASS` | no |
| Consumer approve past a blocking bureau gate or no current check, with `bureauOverrideReason` | `BLOCK` | yes, the override reason |
| Consumer decline | `NONE` (the decline path evaluates no gate; deferred, §2.6) | no |
| Return to review / draft | `NONE` | no |
| Credit-check flag cleared | `REFER` | yes, the clear reason |
| AF approve, no exceptions | `PASS` | no |
| AF approve past exceptions | `REFER` | yes, the exception reason |
| AF decline / refer | `NONE` | no |
| Offer rows | `NONE` | no |
| Automated portal / website refusal (`SYSTEM`) | `BLOCK` | no (the rule decided; nobody overrode it) |

The other approval gates (affordability, open checks, screening, KYC,
deceased, simulated bureau, rate cap) cannot be overridden: an approval
reached them all passing, so they are not recorded as overrides. The route
now evaluates the bureau gate even when an override reason is given (pure
function; the 422 is unchanged) so the log records what it said.

### 2.5 Hook points

| Path | Function / point | Kind / decision | PR A | Failure policy |
|---|---|---|---|---|
| `app/api/applications/[id]/decide/route.ts:1433` | `POST` action `approve`, in the approval `$transaction` after `LOAN_APPROVED` | CREDIT_DECISION `APPROVE` + OFFER `APPROVED_TERMS` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:1597` | action `decline`, after `LOAN_DECLINED` | `DECLINE` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:460` | action `return_to_review` | `RETURN_TO_REVIEW` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:672` | action `return_to_draft` | `RETURN_TO_DRAFT` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/checks/[flagId]/clear/route.ts:87` | `POST`, after `CREDIT_CHECK_FLAG_CLEARED` | `CLEAR_FLAG` | **hooked** (`clientId` read with the row lock) | same tx, fail closed |
| `app/api/applications/[id]/pasq/route.ts:1090` | `POST`, after `PASQ_GENERATED`, serializable tx | OFFER `QUOTATION_ISSUED` | **hooked** | same tx, fail closed |
| `lib/asset-finance/deal-decision.ts:224` (`decideDeal`, called by `app/api/asset-finance/deals/[id]/decide/route.ts`) | after `ASSET_DEAL_DECIDED` | `APPROVE`/`DECLINE`/`REFER` (+ OFFER on approve) | **hooked**; `DealActor.role` added (optional) | same tx, fail closed |
| `app/api/applications/[id]/bureau-override/route.ts` | dead (always 400/409); overrides go through `/decide` | n/a | not needed | |
| `app/api/applications/[id]/affordability/route.ts` | CREDIT_OFFICER assessment snapshot | assessment, not a decision | deferred: input to the decision, already fingerprinted | |
| `app/api/asset-finance/nca-overrides/[overrideId]/decide/` | NCA→NON_NCA regime override decide (four-eyes) | a regulatory classification, not credit | deferred (follow-up: log as `REFER`/`APPROVE` of a regime) | |
| `app/api/portal/applications/route.ts:219`, `:238`, `:819`, `:857`; `app/api/website/apply/route.ts:545`, `:677`, `:707`, `:786`, `:1261`, `:1285`, `:1321` | automated `APPLICATION_SUBMISSION_BLOCKED` refusals (blacklist, deceased, own-lender arrears, expense evidence; and process refusals: open application, identity conflict, unauthenticated profile change, contact conflict) | CREDIT_DECISION `DECLINE`, `actorType SYSTEM`, `s71ReviewRequired` | **hooked** (`recordSubmissionRefusal`, `lib/learning-loop/submission-refusal.ts`) | audit + record in one transaction; the refusal never changes (below) |
| `lib/collections-engine/instructions.ts:97` | `planMandate`, instruction create + `COLLECTION_INSTRUCTION_PLANNED` | COLLECTION_ACTION | **deferred** | best-effort |
| `lib/collections/reminders.ts:706` (`sendMessage`), `:820` (`loanNote.create`) | pre-due and overdue reminders | COLLECTION_ACTION | **deferred** | best-effort |
| `lib/collections/escalation.ts:57` (`loanNote.create`), rules at `:72`-`:100` | soft reminder, auto s129, 60-DPD DEFAULTED status flip (decision 1: an escalation step, not default), legal flag | COLLECTION_ACTION | **deferred** | best-effort |
| `app/api/collections/[loanId]/reminder/route.ts:26` | staff-sent reminder | COLLECTION_ACTION | **deferred** | best-effort |
| `components/collections/LogContactButton.tsx:63` → `LoanNote` type `promise_to_pay` (read by `lib/collections/promiseToPay.ts:30`) | promise to pay | COLLECTION_ACTION | **deferred** | best-effort |
| `app/api/loans/[id]/payment-arrangement/route.ts:71`, `app/api/loans/[id]/payment-plan/route.ts:69` | arrangement / plan upsert (one row per loan, history overwritten) | COLLECTION_ACTION | **deferred** | best-effort |

Automated refusals (decision 5): the eleven call sites (line numbers as
before this change) wrote their `APPLICATION_SUBMISSION_BLOCKED` audit row
outside any transaction; none has a refusal transaction to join (the portal's
in-lock refusal returns from its transaction, which commits nothing, and is
logged after it). One helper, `recordSubmissionRefusal`, now writes the
unchanged audit row and a `SYSTEM` record together in one transaction and
replaces every call:
- record: CREDIT_DECISION `DECLINE`, recommendation `BLOCK`, not overridden,
  `ruleVersion = decision-log-v1+submission-refusal-v1`, `s71ReviewRequired`;
  snapshot by allow-list only: `channel` (`PORTAL`/`WEBSITE`),
  `refusalReason`, `refusalClass` (`CREDIT`: blacklisted, deceased,
  own-lender arrears, Regulation 23A justification missing, expense evidence
  invalid; `PROCESS`: open application, identity conflict, unauthenticated
  financial-profile change, contact conflict), `automated: true`. No amount,
  income, identity value or free text.
- subject: the confirmed client; else the website lead (an identity
  conflict confirms no client, and a contact conflict for a new client rolls
  the client back), never a client the request merely matched. A duplicate's
  open application is evidence (`existingApplicationId`), not the subject,
  so no outcome or decision history attaches to it.
- failure: the client is refused whatever happens. At the ten sites that
  used the best-effort `logAudit`, a failed transaction is logged
  (`console.error`, tagged `[learning-loop]`, as `logAudit` does) and the
  audit row is written alone, so the log never costs the trail a row; the
  contact-conflict site used `logAuditStrict` and still fails closed (500).
- tests: `submission-refusal.test.ts` (builder, transaction, fallback,
  strict); each site in `app/api/portal/applications/route.test.ts` and
  `app/api/website/apply/route.test.ts`; `RUN_DECISION_LOG_IT`
  `app/api/portal/applications/submission-refusal.integration.test.ts`
  (a real portal refusal under the RLS-bound role).

Why collection actions are deferred: (a) the dunning code was reworked this
week (#220, R3 merged 2026-10-20) and R4 is in flight, so hooks there now
would collide; (b) there is no strategy or variant concept to version an
action against (cadences are hard-coded arrays, `lib/collections/reminders.ts`,
`lib/collections/escalation.ts:72`); (c) the one machine-readable collection
action, `CollectionInstruction`, already joins to its outcome directly
(`CollectionResult.instructionId`), so PR B can read it as the action
without a log row. The enum value `COLLECTION_ACTION` exists now so the
follow-up needs no enum migration.

Failure policy, justified: a credit decision or offer that commits without
its record makes the log incomplete exactly where it matters (overrides), so
those hooks write in the same transaction and fail closed (a failed insert
rolls the decision back and the route returns 500, as a failed audit insert
already does). A collection action must never be blocked by analytics: those
hooks (follow-up) write after the action, outside its transaction, and log a
failure through the repo's error logging (`console.error` with a tagged
prefix, as `lib/audit.ts logAudit` does; no dedicated logger module exists),
never swallowing it.

### 2.6 Rule versions

Only the affordability policy and PASQ carry a version id today. The log
introduces `ruleVersion = decision-log-v1+<code version>` and
`policyHash` (tenant thresholds). Gaps, flagged: the bureau gate and the
credit-check rules (`lib/credit-checks/policy.ts`) have no version id
(`credit-checks-unversioned`); a follow-up should add explicit version
constants so a code change to a gate shows up as a new `ruleVersion`. The
decline path does not evaluate the gates, so a decline against `PASS` gates
is not yet visible; a follow-up can evaluate the bureau and affordability
gates at decline (two reads) and record `PASS`/`BLOCK`.

### 2.7 Retention

The repo has no retention rule for decision or audit data
(`lib/notifications/retention.ts` says `AuditLog` is kept indefinitely;
`lib/lender-api/retention.ts` covers API logs only). Proposal, **flagged**:
keep a decision record as long as the application and agreement records it
describes, which the NCA requires a credit provider to keep for a prescribed
period (National Credit Regulations, record-keeping; my recollection is 3
years from termination or rejection, **to verify**; FICA's 5 years may apply
to the same client file, **to verify**). After that, pseudonymise rather
than delete: null the subject ids and `actorUserId` and drop `overrideReason`
in a migration-owned job that runs under a bypass of the append-only trigger,
so aggregate history survives. Because the table is append-only, that job is
a deliberate, audited exception and is **not built in PR A**.
**Needs lender legal sign-off.**

## 3. Outcome definitions (implemented in PR B)

All from existing tables; one code-owned definition per outcome
(`lib/learning-loop/outcomes/`, version `OUTCOME_DEFINITION_VERSION =
outcomes-v2` in `definition.ts`; v2 applied decision 3); measured from the first instalment due
date. Days are SAST calendar days. The definitions are pure functions over
source-neutral facts (`facts.ts`), so an external extract runs through the
same code.

| Outcome | Definition | Source |
|---|---|---|
| `PAID` | instalment fully paid by its due date; window `INSTALMENT:<n>`, known the day after the due day | `RepaymentSchedule.paidAt`, which the paid-at replay keeps (`lib/loan/schedule-paid-at.ts`; `Payment` has no instalment FK). Paid in full with no `paidAt` → `UNOBSERVABLE` (`PAID_AT_MISSING`) |
| `LATE` | paid 1–29 days after the due day; known 30 days after it; on time, 30+ days late or unpaid is `false` (30+ is `EVER_30_DPD`'s) | same |
| `RETURNED_DEBIT_ORDER` | `CollectionResult.outcome = UNPAID` and not `reportedAfterPayment`; keep `reasonCode` (`INSUFFICIENT_FUNDS`, `ACCOUNT_CLOSED`, `PAYMENT_STOPPED`, `MANDATE_SUSPENDED`, `MANDATE_CANCELLED`, `ACCOUNT_FROZEN`, `NO_DEBIT_FACILITY`, `NOT_FICA`, `UNKNOWN`); never collapse INSUFFICIENT_FUNDS and PAYMENT_STOPPED; a `simulated` result counts only for a demo lender (`TenantConfig.isDemoLender`, decision 4) | `CollectionResult` → `CollectionInstruction` (`loanId`, `installmentNo`, `amountCents`) |
| `EVER_30_DPD` / `EVER_60_DPD` / `EVER_90_DPD` | max DPD in the window ≥ 30/60/90, windows `3M`, `6M`, `12M` from the first due day (calendar months, clamped to month end), and `TERM_30D` (term end + 30 days) for a short loan: one whose term end + 30 days falls inside `3M`. `EVER_90_DPD` is measured over `6M` and `12M` only: a `3M` window is 89–92 days, so whether 90 DPD fits in it depends on the start month and cohorts would not compare (`TERM_30D` is never longer). A loan **written off** inside the window before reaching the threshold has it `OBSERVED true` with `reasonCode = WRITTEN_OFF_BEFORE_THRESHOLD` (a write-off below 90 DPD is a loss, never good). A loan **cancelled** (cooling-off) inside the window is `UNOBSERVABLE` (`LOAN_CANCELLED`): it never performed | `LoanArrearsSnapshot.daysInArrears` (`prisma/schema/arrears-history.prisma`), `Loan` for the write-off/cancel day |
| headline **bad** = **default** | ever 90+ DPD within 12 months (decision 1; matches s129 eligibility at 90, `lib/collections/section129-eligibility.ts`, and the 90+ report band, `lib/reports/arrears-buckets.ts`). 60+ is reported as a collections escalation band, never as default | same |
| `DEFAULTED_STATUS` (per window) | the snapshot's `status` was `DEFAULTED` on a day in the window (tracked separately from DPD; today it can mean 60+ DPD, see below, so it is never the default figure); a write-off does not make it true, a cancellation makes it `UNOBSERVABLE` | `LoanArrearsSnapshot.status` only (the loan row has no default date) |
| `CURED` | back to 0 DPD after ≥ 30 DPD in the window **while the loan is still open** (decision 3): a 0-DPD day counts only before the loan's close day, so settling or a write-off is never a cure; a loan that never reached 30 DPD is `false` with `reasonCode = NEVER_30_DPD`, so a cure rate divides by delinquent loans only; cancelled → `UNOBSERVABLE` (`LOAN_CANCELLED`) | `LoanArrearsSnapshot` (there is no cure status transition) |
| `SETTLED_AFTER_DELINQUENCY` | the loan reached `COMPLETED` inside the window after ≥ 30 DPD in it (decision 3: not a cure; a loan that cured and later settled is both). `false` with `NEVER_30_DPD` when it never reached 30 DPD; cancelled → `UNOBSERVABLE` (`LOAN_CANCELLED`); `COMPLETED` with no `closedAt` → `UNOBSERVABLE` (`CLOSE_DATE_MISSING`) | `LoanArrearsSnapshot` + `Loan` |
| `SETTLED` / `WRITTEN_OFF` | `LoanStatus.COMPLETED` (`closedAt`) / `WRITTEN_OFF` (`writeOffAt`, else `closedAt`) before the window ends; status without a date → `UNOBSERVABLE` (`CLOSE_DATE_MISSING`) | `Loan` |
| `RETURNED_DEBIT_ORDER` amount | the instruction's `amountCents`; `reasonCode` null when the provider gave none | `CollectionInstruction` |
| `TAKEN_UP` (offers) | `true`: the application was disbursed. `false` (= NOT_TAKEN_UP): a later return, decline or a `DECLINED`/`CANCELLED` status ended it first. Otherwise `PENDING` (there is no approval-expiry concept in the code, so an abandoned approval stays `PENDING` until cancelled). One row per offer, window `OFFER`, `sourceRef` the application, so a resolved offer never leaves a stale row. A `false` set by status alone (no decision record ended it, e.g. a staff cancel) is timed by `LoanApplication.updatedAt`, the only timestamp; the writer keeps the first `observedAt` it stored so later edits do not move it | `LoanApplication`, `Loan.applicationId` |

Window states: `PENDING` (window not yet elapsed), `UNOBSERVABLE` (no
arrears history for part of the window: `LoanArrearsSnapshot` starts at the
first nightly run and is not backfilled, so a gap is never read as "good").
As built:
- A window stays `PENDING` until it has elapsed **even when the event already
  happened inside it**; otherwise an immature cohort would show only its bads.
- Once elapsed, an event seen in the history is `OBSERVED true`, whatever gaps
  exist elsewhere. "It did not happen" is `OBSERVED false` only when every day
  the loan was open in the window has a snapshot row; one missing day makes
  it `UNOBSERVABLE`: `HISTORY_OUTAGE` when the lender had no nightly run that
  day (no `ArrearsSnapshotRun` row: a tenant-wide outage, or history that had
  not started), `HISTORY_GAP` when the run happened but the loan was not in
  it. A closed loan needs no rows from its close day on (it leaves the
  collectible book). A loan with no schedule is `UNOBSERVABLE` (`NO_SCHEDULE`).
- **History is never backfilled**, so one missed night inside a window makes
  that window `UNOBSERVABLE` for every loan open that day, permanently (a run
  that is only late heals on the next night's run). Coverage below 100% on a
  real book must be read with the `HISTORY_OUTAGE` count beside it. Bounding
  the missed day from its neighbours is not sound (a reversed payment or a
  returned debit order makes DPD jump), so it is not done; reconstructing a
  missed day from the schedule and receipts is a follow-up (§11).
- Only `OBSERVED` rows carry `value` and `observedAt` (DB CHECK
  `DecisionOutcome_value_when_observed`), so a `PENDING` or `UNOBSERVABLE`
  row cannot be summed as good.
- Simulated collection results (`CollectionResult.simulated`) are included
  only for a demo lender (`TenantConfig.isDemoLender`, the repo's marker for
  a synthetic lender, set only by the demo seed and stack scripts); on a real
  lender they are ignored whatever the deployment's `DEMO_MODE` (decision 4).

**Decided (decision 1), code not changed here**: default is 90+ DPD. The
escalations cron still flips ACTIVE → DEFAULTED at **60** DPD
(`DEFAULT_AT_DPD = 60`, `lib/collections/escalation.ts:72`, used at `:84`,
`:100`), while `recomputeLoanBalances` auto-promotes at **90**
(`lib/loan/dpd-update.ts:126`), so `status = DEFAULTED` today can mean 60+.
The outcome job uses DPD history for "bad" (ever 90+) and reports the status
separately, so it does not inherit the conflict. Moving the escalation flip
to 90 (60 stays an escalation step, not a status change) is a decided
follow-up with its own PR (§7): it changes live collections behaviour, so it
does not ride in a learning-loop PR.

**Attribution**:
- Credit outcomes attach to the **final `APPROVE` record** of the application
  that produced the loan (`Loan.applicationId` is unique): the latest
  `CREDIT_DECISION/APPROVE` with `decidedAt` ≤ disbursement. Earlier approvals
  undone by `RETURN_TO_REVIEW` get no outcome. The offer's take-up attaches to
  its `APPROVED_TERMS` / `QUOTATION_ISSUED` records.
- `CLEAR_FLAG` records inherit the outcome of the approval they preceded
  (same `applicationId`, `decidedAt` before it), so "flags cleared vs bad
  rate" is a join, not a second outcome row.
- Collection outcomes (follow-up) attach to the most recent
  `COLLECTION_ACTION` on the loan within 14 days before the payment, return
  or cure (N = 14, configurable constant; observational). **Not built in PR B**:
  PR A logs no collection actions (§2.5), so there is nothing to attach to.
  Returned debit orders attach to the loan's approval meanwhile.
- Declines get no outcome: there is no observable repayment (§5 selection
  bias).
- Loans disbursed before the decision log shipped have no approval record and
  get no outcome rows; they are outside coverage, not counted as gaps.
- Disbursement time is `LoanApplication.disbursedAt`, else `Loan.createdAt`.

## 4. Part 2: outcome feedback job (PR B)

- **Model** (migration `20261021120000_decision_outcome`, shipped with its
  code): `DecisionOutcome`
  { `id`, `tenantId`, `decisionRecordId` (FK `(tenantId, decisionRecordId)` →
  `CreditDecisionRecord(tenantId, id)`, RESTRICT, so an outcome cannot hang
  off another lender's decision; the migration adds that unique index on
  `CreditDecisionRecord`), `outcomeKind` enum `DecisionOutcomeKind` (§3:
  `PAID`, `LATE`, `RETURNED_DEBIT_ORDER`, `EVER_30/60/90_DPD`,
  `DEFAULTED_STATUS`, `CURED`, `SETTLED_AFTER_DELINQUENCY`, `SETTLED`,
  `WRITTEN_OFF`, `TAKEN_UP`), `window`
  text (`3M`, `6M`, `12M`, `TERM_30D`, `OFFER`, `INSTALMENT:<n>`; CHECK
  `DecisionOutcome_window`), `state` enum {`OBSERVED`, `PENDING`,
  `UNOBSERVABLE`}, `value` bool? (set exactly when `OBSERVED`), `amountCents`
  int?, `reasonCode` text? (a return's reason, an `UNOBSERVABLE` reason, or
  `NEVER_30_DPD`),
  `sourceSystem` text CHECK in (`credaflow`, `external_extract`),
  `sourceRef` text (opaque: a `CollectionResult` id, a schedule row id, or an
  extract row key), `definitionVersion` text, `observedAt` (set exactly when
  `OBSERVED`), `computedAt`, `demoData` bool default false (decision 4) },
  unique `(decisionRecordId, outcomeKind, window, sourceSystem, sourceRef)`,
  tenant RLS (ENABLE + FORCE + `tenant_isolation`), registered in
  `lib/registry/tenant-scoped-models/250-learning-loop.ts`. Not append-only:
  it is derived and recomputable. Each run converges per decision and source
  (`lib/learning-loop/outcomes/writer.ts`): new keys are inserted with
  `ON CONFLICT DO NOTHING` (replicas may run at once; the run that loses the
  race counts fewer `created`), changed rows updated, rows whose key the
  definitions no longer produce deleted, unchanged rows left alone
  (`computedAt` = when the current content was computed). Rows of a decision
  the adapter no longer attributes anything to are deleted; a decision whose
  loan failed to derive this run keeps its rows. A
  definition change bumps `definitionVersion` and every row is rewritten on
  the next run (no data migration). The job writes no `AuditLog` rows: it is
  derived analytics, not a state change to the book, as
  `/api/cron/arrears-snapshot` writes none.
- **Rollback** (in the migration header too):

```sql
BEGIN;
DROP TABLE "DecisionOutcome";
DROP TYPE "DecisionOutcomeKind";
DROP TYPE "DecisionOutcomeState";
DROP INDEX "CreditDecisionRecord_tenantId_id_key";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021120000_decision_outcome';
COMMIT;
```

  Nothing is lost: every row is recomputed by the next run after re-apply.
  The new foreign key means a plain `TRUNCATE "CreditDecisionRecord"` now
  stops at the reference before the append-only trigger;
  `decision-log.integration.test.ts` truncates with `CASCADE` so the trigger
  is still what it proves.
- **Source-agnostic**: nothing in the model or job names a source lender.
  An adapter (`OutcomeSourceAdapter`, `lib/learning-loop/outcomes/adapter.ts`)
  maps its rows into the facts of `facts.ts` and runs the same definitions.
  CredaFlow rows come from the tables in §3 (`credaflow-adapter.ts`, the only
  adapter the job runs). An external extract is mapped by
  `external-extract-adapter.ts` (interface plus a synthetic-fixture test; no
  connection exists, refs are prefixed with the extract's pseudonymous loan
  key) into the same shape, with `sourceSystem = 'external_extract'`
  and a pseudonymous `sourceRef`; its decisions arrive as
  `CreditDecisionRecord` rows written by the import (actor `SYSTEM`,
  `ruleVersion = external:<extract version>`).
- **Job**: `app/api/cron/decision-outcomes`, `verifyCronSecret`
  (`lib/cron-auth.ts:14`), declared in `lib/registry/cron-jobs/140-decision-outcomes.ts`
  as `in-process`, schedule `30 0 * * *` SAST (after `arrears-snapshot` at
  23:45, `lib/registry/cron-jobs/130-arrears-history.ts`; `after:` needs a
  singleRun target and arrears-snapshot is not one, so it is ordered by time
  and is idempotent if it runs first), `freshnessMinutes: DAY + 2 * HOUR`.
  It sends nothing, so it runs on every replica (no `singleRun`).
  Tenant-swept with `sweepActiveTenants` (`lib/ops/tenant-sweep.ts:24`), one
  `runWithTenant` frame per tenant (`lib/learning-loop/outcomes/job.ts`);
  per-loan errors are counted in the body (`failedLoans`, logged with the
  `[cron/decision-outcomes]` prefix via `console.error`, as
  `lib/ops/tenant-sweep.ts` does: the repo has no logger module yet) and leave the run 200, a tenant's failure
  sets `x-cron-failed-tenants`; 503 only when every tenant failed
  (`sweepStatus`).
- **Scale (deferred)**: each run reads every `CREDIT_DECISION`/`OFFER` record
  of the tenant at once and recomputes matured loans every night. Snapshot
  reads are bounded by the chunk's latest 12M window end. Paging the record
  read and skipping decisions whose rows are all final on the current
  `definitionVersion` wait for a book large enough to need them.
- **Simulated and demo data** (decision 4), as built: the job reads the
  tenant's `TenantConfig.isDemoLender` once per run. For a real lender the
  adapter never reads a simulated `CollectionResult` and every row has
  `demoData = false`. For a demo lender, simulated results count and every
  row is written `demoData = true`. `tenantOutcomeMetrics` (`metrics-db.ts`)
  reads only rows whose `demoData` matches the tenant's flag and returns
  `demoData` with the figures, so the dashboard labels a demo lender's
  figures "Simulated / demo data". One figure never mixes the two, even if a
  lender's flag changed after rows were written (the next run re-marks them).
  The B migration was amended for this before merge (it was only ever
  applied to throwaway test databases); its rollback is unchanged and still
  drops everything it creates.
- **Tests**: pure outcome functions over synthetic fixtures (paid / late /
  returned with each reason / ever-30/60/90 / cure / settled after delinquency / defaulted / settled /
  written off / pending / unobservable gap never good), attribution and
  take-up, coverage, calibration, the writer's convergence, the extract
  adapter, the route's auth; a `RUN_DECISION_OUTCOMES_IT` suite
  (`lib/learning-loop/outcomes/outcomes.integration.test.ts`) proving 401
  without the secret, idempotency (two runs, identical rows), the unique key
  and CHECKs, the tenant-carrying FK, and tenant isolation as an RLS-bound
  role.

### 4.1 External extract (generic process)

For the first real data, a pseudonymised extract from another lender's LMS.
The field list is approved (decision 6), but **nothing is pulled** until all
three are in place: (a) the operator agreement, (b) the bureau data terms
and (c) an export run by the source lender itself (CredaFlow does not run
the extraction against the source system). Until then the adapter is tested
on synthetic rows only. The process, once those exist:

1. A **read-only** connection to the source, by a dedicated role, from a
   job outside the application.
2. Pseudonymise at source: borrower and loan keys replaced by keyed HMAC
   codes (HMAC-SHA256; the key is held outside the repo and outside the
   CredaFlow database, by the source lender or an escrow role); no names,
   ID numbers, contacts or bank details; date of birth coarsened to an age
   band; amounts may stay exact (they are not identifiers on their own, but
   see k-anonymity in §8).
3. Load into a **private schema or database** owned by a dedicated role that
   the application role cannot read; the outcome job's adapter is the only
   reader and writes only `DecisionOutcome`/`CreditDecisionRecord` rows for a
   dedicated analysis tenant.
4. Retention limit stated in the operator agreement; deletion (drop the
   schema, destroy the key) on contract end, recorded.
5. Nothing from any extract enters the repository, fixtures, tests or docs.

**The source lender's consent basis and operator agreement under POPIA s21
(and s20) must be confirmed — needs lender legal sign-off.**

## 5. Metrics

- **Outcome coverage %** = decisions with an `OBSERVED` outcome ÷ decisions
  whose observation window has matured (excludes `PENDING`), per tenant,
  kind and month. `UNOBSERVABLE` counts against coverage and is listed
  separately with its reason (history gap). v1 success test: 100% on the
  simulator book, every gap explained. Built as pure helpers in
  `lib/learning-loop/outcomes/metrics.ts` (a decision with several rows, one
  per instalment, is matured when any row is and observed only when every
  matured row is) and `metrics-db.ts` (one tenant, explicit `tenantId` in
  every query besides the frame and RLS; one kind and window, default the
  headline). Not yet run against the simulator book: that needs
  the next demo image. Simulated and demo outcomes are
  excluded from a real lender's metrics and reported, labelled, only on a
  demo tenant (decision 4).
- **Calibration** (computed in PR B, expected empty): only records with
  `predictedProbability` (none today) and an `OBSERVED` headline outcome
  enter. Per `modelVersion`, tenant and month: Brier score = mean((p − y)²)
  with y = headline bad; calibration buckets = ten fixed-width probability
  buckets ([0, 0.1) … [0.9, 1]; fixed rather than population deciles so a
  bucket means the same across months) vs observed bad rate, with counts and
  a 95% Wilson interval per bucket. The bureau score is an ordinal Sigma band, not a
  probability, and is **never** mapped to one silently: rule-based decisions
  are reported as approval-to-outcome rates by `scoreBand`, `ruleVersion`
  and `policyHash` instead. A first "model" could later be an empirical bad
  rate per band per tenant, recorded as `predictedProbability` with its own
  `modelVersion`; that waits for a real book.
- **Selection bias**: approved loans only have outcomes; the dashboard shows
  decline volume by `DeclineCategory` beside cohort performance and states
  that declined applicants have no observable outcome. No reject inference
  in v1.

## 6. Part 3: per-lender dashboard (PR C)

As built. No migration: it reads `CreditDecisionRecord`, `DecisionOutcome`,
`LoanApplication`, `Loan`, `LoanArrearsSnapshot` and `PaymentArrangement`.

- **Where**: `/reports/decision-performance`
  (`app/(dashboard)/reports/decision-performance/`), linked from the reports
  overview only for roles that hold the permission, and only when the
  lender's `featureReports` is on. One server loader,
  `lib/learning-loop/dashboard/loader.ts`; the aggregation is pure
  (`cells.ts`, `cohorts.ts`, `offers-declines.ts`, `collections.ts` beside it).
  No API route. The "90+ DPD in the book now" card is
  `getBookArrears(tenantId).par90` (`lib/reports/book-arrears.ts`), the board
  pack's figure for the whole book; the cohort rates read DPD history through
  PR B's outcomes, which come from `LoanArrearsSnapshot`, the history
  `lib/reports/arrears-snapshot.ts` writes. Roll bands are `ARREARS_BANDS`
  (`lib/reports/arrears-buckets.ts`).
- **Who** (decision 2): default-deny, read-only, per lender.
  `view_decision_performance` in `lib/registry/permissions/070-learning-loop.ts`,
  minimum `ADMIN`: ADMIN (the compliance role; the repo has no COMPLIANCE
  role) and SUPER_ADMIN. LOAN_ADMIN, BRANCH_MANAGER and every role below,
  and the operator roles, are refused (`page.test.tsx` checks every
  `UserRole`). The page has no form, button or input (tested). Any other role is redirected to `/no-access`
  before anything is read; a lender with `TenantConfig.featureReports` off
  (or no config row) gets 404. The page is not in the sidebar: nav items
  carry a minimum role, not a permission, so it is reached from the reports
  overview. Reads run in `runWithTenant(tenantId)` and name `tenantId`
  explicitly, so the tenant-scope extension and RLS both confine them. The
  operator console reads none of it.
- **Rates**: every rate is OBSERVED true ÷ OBSERVED rows. `PENDING`,
  `UNOBSERVABLE` and "no row yet" (the nightly job has not run since the
  decision) are shown in their own columns and never enter a rate. Coverage =
  observed ÷ (decisions − pending), so a gap or a missing row counts against
  it. The cure and settled-after-delinquency rates exclude `NEVER_30_DPD`
  rows. Bad = default = ever 90+ DPD (decision 1). One window is shown at a
  time (`?window=3M|6M|12M`, default 12M); the headline bad is ever 90+ DPD
  in 12M. At 3M, ever 90+ is "not measured" (§3: a 3-month window is too
  short to compare it), never a gap, and coverage is read on ever 60+.
- **Views**: approvals by disbursal month (SAST; `LoanApplication.disbursedAt`,
  else `Loan.createdAt`, as the job dates the loan; a record with no CredaFlow
  loan, i.e. an external extract, is dated by its decision) × `ruleVersion` ×
  `policyHash` (first 8 hex shown) × `inputsSnapshot.bureau.scoreBand`
  ("No band" for asset finance) × overridden × `inputsSnapshot.productType`,
  with ever 30/60/90+, cured, settled after 30+ DPD (its own column, never
  a cure, decision 3), settled, written off, coverage, pending and
  unobservable; overrides vs non-overrides per disbursal month; offer take-up
  per month and offer type; decline volume per month and `declineCategory`
  ("Not categorised" for an asset-finance decline), with the selection-bias
  note on screen. Staff declines only: an automated refusal is not a staff
  decline.
- **Automated refusals** (decision 5): their own panel, the count of
  `DECLINE` records with `actorType = SYSTEM` (the portal and website
  refusals, §2.5), how many carry `s71ReviewRequired`, and a breakdown by
  `refusalReason`, under the label "POPIA s71: lender legal review required
  before go-live".
- **Demo data** (decision 4): the loader reads the lender's
  `TenantConfig.isDemoLender` and only the `DecisionOutcome` rows whose
  `demoData` matches it, so a real lender's figures never include a demo
  row and a demo lender's never mix in a real one. On a demo lender the page
  shows "Simulated / demo data" above every figure.
- **Collections panel** (labelled on screen "Descriptive, not causal"):
  - cure and roll by `collectionsStage`, from `LoanArrearsSnapshot` (last 401
    days). An episode starts on a past-due day when the loan was not past due
    the day before or was at another stage; the first day read starts none
    (the day before it is unknown), and none starts at stage `WRITTEN_OFF` or
    on or after the loan's end day. Within 30 days it is CURED (back to 0
    DPD while open), SETTLED (paid off: resolved, never a cure, decision 3),
    ROLLED (a later `ARREARS_BANDS` band, or written off), whichever comes
    first; else STAYED once the 30 days have elapsed with
    every open day recorded, PENDING before, UNOBSERVABLE if a day is missing
    or the loan was cancelled inside the 30 days. Rates divide by cured +
    settled + rolled + stayed.
  - arrangement kept / broken from `PaymentArrangement.status`
    (`lib/collections/arrangement-check.ts`: `KEPT`, `BROKEN`, and
    `COMPLETED` = ran to its end under 90% paid, shown separately); kept and
    broken rates over arrangements that ended. One row per loan, so a later
    arrangement overwrites an earlier one's result.
  - not built, for lack of data: by action type, channel and timing (no
    `COLLECTION_ACTION` records yet, §2.5); promise-to-pay kept rate
    (`lib/collections/promiseToPay.ts` has no production caller and parses
    note text).
  No holdouts in v1 (withholding reminders is a conduct and treating-customers-fairly
  question that interacts with the consent and kill switches from #217).
- Small cells (< 20 loans; for a collections stage, < 20 distinct loans) are
  greyed with counts shown, not hidden.
- On screen: until a lender has 6 to 12 months of book the figures can only
  be checked on demo or simulator data (worded so a real lender's new book
  is not called a scripted one); no model scores the decisions. No "learning" or
  "AI" claim (the page test asserts the wording).
- **Tests**: pure functions on synthetic data (`*.test.ts` beside them,
  mutation-checked); the page's default-deny and tenant use
  (`page.test.tsx`, the real permission map); `RUN_DECISION_DASHBOARD_IT`
  (`dashboard.integration.test.ts`): two synthetic lenders, aggregates, the
  board-pack figure, isolation by the explicit filters and as an RLS-bound
  role.
- **Scale note** (deferred; fine for a demo book, not for a large lender):
  each request reads, for the tenant and without a limit, every final
  approval with its outcome rows for the window and its whole
  `inputsSnapshot` (only `bureau.scoreBand` and `productType` are used),
  every offer and every decline (whole snapshot for `declineCategory`), the
  matching applications and loans by unbounded `id IN (…)` lists, and 401
  days of daily arrears rows (about 400 per loan). Arrangements are counted
  in the database (`groupBy` status). Before a large lender: select the JSON
  paths in SQL, aggregate cohorts and episodes in SQL, and bound the decision
  reads by the cohorts shown.

## 7. Rollout

1. PR A: migration + hooks ship together (the CHECKs refuse only rows the
   code never writes), including the automated-refusal `SYSTEM` records
   (decision 5). Demo stacks start writing records on the next image.
2. PR B: outcome model + job (built); verify coverage on the simulator book
   (pending: needs a demo image with PR A and PR B).
3. PR C: dashboard (built); show it in the browser on the FairScore demo
   (pending: needs a demo image with PR A–C).
4. Follow-ups: collection-action records after R4 lands, gate version
   constants, decline-time gate evaluation, retention/pseudonymisation job.
   **Decided follow-up, own PR**: move the escalations cron's DEFAULTED flip
   from 60 to 90 DPD (decision 1, §3).
5. External extract only after §4.1's legal points are signed off and its
   three preconditions (operator agreement, bureau data terms, a
   source-lender-run export) are in place (decision 6).
6. **Go-live gate** (decision 5): before the first real lender goes live,
   that lender's legal team reviews the automated refusals under POPIA s71
   (§9.1): whether they fall under s71(2), the representation route, and
   what the generic message says about the logic. No real lender goes live
   until that review is recorded.

## 8. Part 4: cross-lender benchmarks (DESIGN ONLY)

Not to be built before legal sign-off on every point in §9.4.

- **Opt-in per tenant**: `TenantConfig.benchmarkContributionOptIn`
  (boolean, default false) plus `benchmarkOptInAt`, changed only by a
  SUPER_ADMIN in a TOTP-verified session, audited
  (`BENCHMARK_CONTRIBUTION_CHANGED`). Withdrawal is the same switch: the
  next aggregation excludes the tenant and previously published cells that
  would fall below the thresholds without it are re-suppressed.
- **Only aggregates leave a tenant**: a separate job, running under an
  explicit system context, computes per-tenant aggregates (counts and
  outcome counts per cell) and writes only aggregate rows to a
  `BenchmarkCell` table with no tenant id, no borrower identifier, no loan
  id. Cells are banded: product type × amount band × term band × score band ×
  vintage quarter (lagged ≥ 2 quarters).
- **Thresholds**: a cell is published only if **≥ 5 contributing lenders**
  and **≥ 100 underlying loans**, and no single lender contributes more than
  50% of its loans (dominance rule). The source research suggested
  **k ≥ 10 lenders** as safer; with the expected number of CredaFlow lenders,
  5 is the floor I propose and 10 the target.
- **Noise**: add calibrated Laplace noise to published counts (differential
  privacy, ε chosen with legal and published), and round rates; suppress
  complementary cells so a suppressed cell cannot be derived by subtraction.
- **Never** a dimension: protected attributes (race, gender, age, religion,
  disability, marital status, etc.) or proxies such as postal code; never
  pricing or approval rates by lender (competition law); never bureau data
  beyond the band.
- **Deployment model**: one instance and DB per lender (decided for real
  clients) makes pooling an export pipeline of aggregate files, not a query;
  each lender's instance computes its own aggregates and ships only those.

## 9. Legal (every point: needs lender legal sign-off)

### 9.1 POPIA s71: automated decision-making

POPIA s71(1): a data subject may not be subject to a decision with legal
consequences for them, or which affects them to a substantial degree, based
solely on the basis of automated processing of personal information intended
to provide a profile, including their creditworthiness. s71(2) exceptions
include a decision taken in connection with the conclusion or execution of a
contract where the data subject's request was met or appropriate measures
protect their legitimate interests; s71(3) requires those measures to give an
opportunity to make representations about the decision and sufficient
information about the underlying logic. (Cite **POPIA s71**. **NCA s71** is
"Removal of record of debt adjustment or judgment" and is **not** the
relevant section.)

Design response: the system records what its gates said; a named staff user
records every consumer and asset-finance decision; an override needs a
reason; the record shows which gates were overridden. **Finding**: the
portal and website refuse submissions automatically (blacklist, deceased,
own-lender arrears, income/expense evidence; §2.5) with a generic message.
That is plausibly a decision based solely on automated processing with legal
effect. Each refusal is now logged as a `SYSTEM` record flagged
`s71ReviewRequired` (decision 5, §2.5), and the lender's legal review of them
is a go-live gate (§7). `ConsentPurpose.AUTOMATED_DECISIONING`
(`prisma/schema/messaging.prisma:278`) exists and is unused. Legal must say
whether these refusals fall under s71(2), what representation route the
client is given, and what the generic message must say about the logic.
**Needs lender legal sign-off.** Also: staff must not rubber-stamp gates; an
approval rate of ~100% `PASS` with no overrides is worth watching.

### 9.2 POPIA conditions

- **s10 minimality**: the snapshot is banded and reference-based (§2.3).
- **s11 lawful processing**: recording a credit decision is necessary for the
  credit agreement and the lender's NCA duties; analysing outcomes to improve
  the lender's own policy is plausibly a legitimate interest. **Needs lender
  legal sign-off.**
- **s13-14 purpose specification and retention**: purpose = evidencing and
  improving the lender's credit decisions; retention per §2.7. **Needs lender
  legal sign-off.**
- **s15 further processing**: using decision and outcome data to tune the
  lender's own thresholds is compatible with the original purpose
  (assessing creditworthiness); pooling into benchmarks is a further purpose
  whose compatibility must be assessed (nature of the data, consequences,
  anonymisation). **Needs lender legal sign-off.**
- **s18 notification**: the privacy notice should say decisions and outcomes
  are recorded and analysed, and (if adopted) contributed as anonymised
  aggregates. **Needs lender legal sign-off.**
- **s19 security safeguards**: tenant RLS, append-only table, no raw
  identifiers, existing access controls. **Needs lender legal sign-off.**
- **s20/s21 operator**: CredaFlow (as host) and any external-extract
  processor act as operators; written operator agreements needed (§4.1).
  **Needs lender legal sign-off.**
- **s57 prior authorisation**: s57(1) requires the Information Regulator's
  prior authorisation for, among others, processing account-number
  information or special personal information and transferring them to third
  parties, and for credit reporting processing (s57(1)(d), **to verify**).
  The decision log stores no account numbers. Whether cross-lender pooling,
  even aggregated, is "credit reporting" requiring authorisation is open.
  **Needs lender legal sign-off.**

### 9.3 NCA

- **s68** (confidentiality of consumer credit information): records stay
  within the lender's tenant, RLS-isolated; nothing is shared. **Needs lender
  legal sign-off.**
- **s70 and the National Credit Regulations** (credit bureau information,
  permitted purposes): bureau data may be used only for its permitted
  purposes; the log keeps a score band and block codes for the lender's own
  assessment record, and bureau-derived data must **not** be pooled or reused
  outside those purposes (so no bureau dimension beyond a coarse band in any
  benchmark, and none until legal says so). Pooling performance data across
  lenders may itself be credit-bureau activity requiring registration
  (**to verify**). **Needs lender legal sign-off.**
- **s81-82** (prevention of reckless credit, assessment mechanisms): the
  assessment duty stays with the lender; the log records the assessment, it
  does not replace or automate it. **Needs lender legal sign-off.**
- **s62** (right to reasons for decline): unchanged; the client reason
  continues to come from the decline flow (`clientDeclineReason`), the log
  stores only the category. **Needs lender legal sign-off.**
- **s61 and PEPUDA** (non-discrimination): no protected attribute is a
  feature, band or benchmark dimension; `Client.gender` and date of birth,
  which the decide route reads for KYC, never reach the log. **Needs lender
  legal sign-off.**

### 9.4 Benchmark-specific

Credit-bureau registration (NCA, **to verify**), POPIA anonymisation
standard (re-identification not reasonably foreseeable; ≥ 5 lenders is
necessary, not sufficient), CredaFlow's role (operator vs responsible party),
Competition Act information exchange (lagged, banded outcome rates only;
never pricing). **Needs lender legal sign-off.**

## 10. Risks

- **Rubber-stamping**: a log of `PASS` → `APPROVE` can make the decision
  automated in substance (s71). Mitigation: the dashboard shows override
  rates; legal review of the automated refusals.
- **Simulator calibration**: charts drawn on scripted personas measure the
  script. The dashboard must label demo data, keep it out of a real
  lender's figures (decision 4) and make no learning claims.
- **Fail-closed hooks**: an insert failure now fails a decision. The insert
  is a single row with CHECKs the builders satisfy by construction; the unit
  and integration tests cover them.
- **Append-only and test teardown**: suites that delete a tenant's rows must
  do it under `session_replication_role = replica` (as `cleanupDealFixture`
  now does for this table).
- **Free text in `overrideReason`** may contain personal information.
- **Mirror drift**: `bureauBlockCode` mirrors `evaluateBureauGate`'s order;
  `bureau-code.test.ts` holds them together, and the route's own verdict is
  authoritative (a mismatch logs `OTHER`, never a false `PASS`).

## 11. Open questions for Hein

Answered on 21 Oct 2026 and removed: default threshold (90+, decision 1),
dashboard audience (ADMIN and compliance only, decision 2), when to take the
automated refusals to legal (logged now; review before go-live, decision 5),
whether settling after 30+ DPD is a cure (no: `SETTLED_AFTER_DELINQUENCY`,
decision 3).

1. Retention: confirm the NCA record-keeping period with legal, and whether
   pseudonymise-after is acceptable.
2. Collection-action records: build after R4 merges, or wait for a strategy
   / variant concept?
3. Benchmark floor: 5 lenders (proposed) or 10 (safer)?
4. Should the decline path evaluate the gates so "declined against PASS" is
   visible?
5. Take-up: the code has no approval expiry, so an approved application that
   is never signed stays `TAKEN_UP` `PENDING` until someone cancels it. Should
   an approval lapse after N days (and count as not taken up)?
6. Write-off before 90 DPD: the headline counts it as bad (`OBSERVED true`,
   `WRITTEN_OFF_BEFORE_THRESHOLD`), the usual "90+ or written off" bad
   definition. Confirm, or should such loans be `UNOBSERVABLE` instead?
7. Missed snapshot nights: reconstruct the missing day's DPD from the
   schedule and receipts (backfill), or accept `HISTORY_OUTAGE` windows and
   alert on a missed run?
