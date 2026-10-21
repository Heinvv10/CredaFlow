# Learning loop: design

Status: PR A (decision log) implemented on `feat/learning-loop-a-decision-log`;
PR B (outcome job) and PR C (dashboard) are designed here, not built. Part 4
(cross-lender benchmarks) is design only. Every legal point is marked
**needs lender legal sign-off**; a citation I could not confirm is marked
**to verify**.

The decisions taken in the brainstorm (2026-10-21; notes kept outside the
repository) are applied throughout: record what the existing gates said, do
not invent a score; one append-only row per decision event; demo stacks prove
the plumbing; the first real data is a pseudonymised external extract.

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
2. **Outcome feedback job** (PR B): a nightly, idempotent, tenant-swept job
   deriving `DecisionOutcome` rows from the servicing tables.
3. **Per-lender dashboard** (PR C): approval-to-outcome by cohort, policy
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
`docs/ARCHITECTURE.md` "The Prisma schema" allows), migration
`prisma/migrations/20261021090000_credit_decision_record`.

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
| `applicationId`, `loanId`, `clientId` | text? | subject ids, no FK; CHECK at least one set |
| `sourceEntityType`, `sourceEntityId` | text | the row of record changed: `LoanApplication`, `ApplicationCheckFlag`, `AssetFinanceDeal` |
| `ruleVersion` | text | `decision-log-v1+<code rule version>`, e.g. `+approval-ndi-v3` (`APPROVAL_AFFORDABILITY_POLICY_VERSION`, `lib/affordability/snapshot.ts:20`), `+pasq-v3`, `+af-deal-decision-v1`, `+credit-checks-unversioned` |
| `policyHash` | char(64), CHECK hex | sha256 of canonical JSON of the tenant's effective thresholds: `TenantConfig.bureauMinScore`, `bureauBlockAdverse`, `ndiBufferPct`, `bureauMaxAgeDays` (effective value via `bureauMaxAgeDays()`, `lib/compliance/bureau.ts:17`) |
| `modelVersion` | text? | null: no model today |
| `predictedProbability` | decimal(6,5)? | CHECK in [0,1]; null today |
| `inputsSnapshot` | jsonb object | minimised, banded inputs (§2.3) |
| `evidenceRefs` | jsonb object | ids and fingerprints of the evidence of record |
| `inputsHash` | char(64), CHECK hex | sha256 of `canonicalJson({ exactInputs, evidenceRefs, policy })` (`lib/canonical-json.ts`) |
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
- **CHECKs**: `_hashes_sha256`, `_decision_code`, `_probability_range`,
  `_override_reason`, `_actor`, `_has_subject`, `_json_objects`.
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
  provider, overridden;
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
record and lets analysis group identical inputs. The exact values are never
stored. The hash includes 64-hex fingerprints and ids, so it cannot be
brute-forced back to an income.

Never stored: ID numbers, names, contact details, bank details, raw bureau
payloads (`obligations`, accounts), exact amounts, decline/return reason text.
Stored free text: `overrideReason` only (bureau override, flag clear reason,
AF exception reason), because POPIA s71(3) representations and an NCR query
need it. It is staff-written and may contain personal information: it falls
under the retention rule and DSAR export.

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

The other approval gates (affordability, open checks, screening, KYC,
deceased, simulated bureau, rate cap) cannot be overridden: an approval
reached them all passing, so they are not recorded as overrides. The route
now evaluates the bureau gate even when an override reason is given (pure
function; the 422 is unchanged) so the log records what it said.

### 2.5 Hook points

| Path | Function / point | Kind / decision | PR A | Failure policy |
|---|---|---|---|---|
| `app/api/applications/[id]/decide/route.ts:1429` | `POST` action `approve`, in the approval `$transaction` after `LOAN_APPROVED` | CREDIT_DECISION `APPROVE` + OFFER `APPROVED_TERMS` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:1593` | action `decline`, after `LOAN_DECLINED` | `DECLINE` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:457` | action `return_to_review` | `RETURN_TO_REVIEW` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/decide/route.ts:669` | action `return_to_draft` | `RETURN_TO_DRAFT` | **hooked** | same tx, fail closed |
| `app/api/applications/[id]/checks/[flagId]/clear/route.ts:87` | `POST`, after `CREDIT_CHECK_FLAG_CLEARED` | `CLEAR_FLAG` | **hooked** (clientId not held there: null; the application id is the subject) | same tx, fail closed |
| `app/api/applications/[id]/pasq/route.ts:1090` | `POST`, after `PASQ_GENERATED`, serializable tx | OFFER `QUOTATION_ISSUED` | **hooked** | same tx, fail closed |
| `lib/asset-finance/deal-decision.ts:224` (`decideDeal`, called by `app/api/asset-finance/deals/[id]/decide/route.ts`) | after `ASSET_DEAL_DECIDED` | `APPROVE`/`DECLINE`/`REFER` (+ OFFER on approve) | **hooked**; `DealActor.role` added (optional) | same tx, fail closed |
| `app/api/applications/[id]/bureau-override/route.ts` | dead (always 400/409); overrides go through `/decide` | n/a | not needed | |
| `app/api/applications/[id]/affordability/route.ts` | CREDIT_OFFICER assessment snapshot | assessment, not a decision | deferred: input to the decision, already fingerprinted | |
| `app/api/asset-finance/nca-overrides/[overrideId]/decide/` | NCA→NON_NCA regime override decide (four-eyes) | a regulatory classification, not credit | deferred (follow-up: log as `REFER`/`APPROVE` of a regime) | |
| `app/api/portal/applications/route.ts:219`, `:238`, `:819`, `:857`; `app/api/website/apply/route.ts:545`, `:677`, `:707`, `:786`, `:1261`, `:1285`, `:1321` | automated `APPLICATION_SUBMISSION_BLOCKED` refusals (blacklist, deceased, own-lender arrears, income/expense evidence) | CREDIT_DECISION `DECLINE`, `actorType SYSTEM` | **deferred** | best-effort: log error, never change the refusal |
| `lib/collections-engine/instructions.ts:97` | `planMandate`, instruction create + `COLLECTION_INSTRUCTION_PLANNED` | COLLECTION_ACTION | **deferred** | best-effort |
| `lib/collections/reminders.ts:706` (`sendMessage`), `:820` (`loanNote.create`) | pre-due and overdue reminders | COLLECTION_ACTION | **deferred** | best-effort |
| `lib/collections/escalation.ts:57` (`loanNote.create`), rules at `:72`-`:100` | soft reminder, auto s129, 60-DPD default flip, legal flag | COLLECTION_ACTION | **deferred** | best-effort |
| `app/api/collections/[loanId]/reminder/route.ts:26` | staff-sent reminder | COLLECTION_ACTION | **deferred** | best-effort |
| `components/collections/LogContactButton.tsx:63` → `LoanNote` type `promise_to_pay` (read by `lib/collections/promiseToPay.ts:30`) | promise to pay | COLLECTION_ACTION | **deferred** | best-effort |
| `app/api/loans/[id]/payment-arrangement/route.ts:71`, `app/api/loans/[id]/payment-plan/route.ts:69` | arrangement / plan upsert (one row per loan, history overwritten) | COLLECTION_ACTION | **deferred** | best-effort |

Why the automated refusals are deferred: eleven call sites in two routes,
outside any transaction, written with the non-strict `logAudit`, some before
a client is confirmed. The right change is one helper that writes the
`APPLICATION_SUBMISSION_BLOCKED` audit and its `SYSTEM` record together and
replaces all eleven; that is a refactor beyond PR A. Until then, the s71
finding in §9 stands on the audit rows alone.

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

All from existing tables; one code-owned definition per outcome; measured
from the first instalment due date.

| Outcome | Definition | Source |
|---|---|---|
| `PAID` | instalment fully paid by its due date | `RepaymentSchedule` + paid-at replay (`lib/loan/schedule-paid-at.ts`; `Payment` has no instalment FK) |
| `LATE` | paid after due date, before 30 DPD | same |
| `RETURNED_DEBIT_ORDER` | `CollectionResult.outcome = UNPAID` and not `reportedAfterPayment`; keep `reasonCode` (`INSUFFICIENT_FUNDS`, `ACCOUNT_CLOSED`, `PAYMENT_STOPPED`, `MANDATE_SUSPENDED`, `MANDATE_CANCELLED`, `ACCOUNT_FROZEN`, `NO_DEBIT_FACILITY`, `NOT_FICA`, `UNKNOWN`); never collapse INSUFFICIENT_FUNDS and PAYMENT_STOPPED | `CollectionResult` → `CollectionInstruction.repaymentScheduleId` |
| `EVER_30_DPD` / `EVER_60_DPD` / `EVER_90_DPD` | max DPD in the window ≥ 30/60/90, windows 3, 6, 12 months on book (and term end + 30 days for short loans) | `LoanArrearsSnapshot.daysInArrears` (`prisma/schema/arrears-history.prisma`) |
| headline **bad** | ever 90+ DPD within 12 months (matches s129 eligibility at 90, `lib/collections/section129-eligibility.ts`, and the 90+ report band, `lib/reports/arrears-buckets.ts`) | same |
| `DEFAULTED_STATUS` | `Loan.status` reached `DEFAULTED` (tracked separately) | `Loan` |
| `CURED` | back to 0 DPD after ≥ 30 DPD | `LoanArrearsSnapshot` (there is no cure status transition) |
| `SETTLED` / `WRITTEN_OFF` | `LoanStatus.COMPLETED` / `WRITTEN_OFF` | `Loan` |
| `TAKEN_UP` / `NOT_TAKEN_UP` (offers) | agreement signed and disbursed / approval returned, declined or expired without a loan | `LoanApplication`, `Loan.applicationId` |

Window states: `PENDING` (window not yet elapsed), `UNOBSERVABLE` (no
arrears history for part of the window: `LoanArrearsSnapshot` starts at the
first nightly run and is not backfilled, so a gap is never read as "good").

**Documented conflict, not changed here**: the escalations cron flips
ACTIVE → DEFAULTED at **60** DPD (`DEFAULT_AT_DPD = 60`,
`lib/collections/escalation.ts:72`, used at `:84`, `:100`), while
`recomputeLoanBalances` auto-promotes at **90** (`lib/loan/dpd-update.ts:126`).
`status = DEFAULTED` therefore effectively means 60+. The outcome job uses
DPD history for "bad" and reports the status separately, so it does not
inherit the conflict. Which threshold the lender's policy intends is an open
question (§11).

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
  or cure (N = 14, configurable constant; observational).
- Declines get no outcome: there is no observable repayment (§5 selection
  bias).

## 4. Part 2: outcome feedback job (PR B)

- **Model** (PR B's migration, shipped with its code): `DecisionOutcome`
  { `id`, `tenantId`, `decisionRecordId` (FK `CreditDecisionRecord`,
  RESTRICT), `outcomeKind` enum (as §3), `window` text (`3M`, `6M`, `12M`,
  `TERM_30D`, `INSTALMENT:<n>`), `state` enum {`OBSERVED`, `PENDING`,
  `UNOBSERVABLE`}, `value` bool, `amountCents` int?, `reasonCode` text?,
  `sourceSystem` text CHECK in (`credaflow`, `external_extract`),
  `sourceRef` text (opaque: a `CollectionResult` id, a schedule row id, or an
  extract row key), `definitionVersion` text, `observedAt`, `computedAt` },
  unique `(decisionRecordId, outcomeKind, window, sourceSystem, sourceRef)`,
  tenant RLS, registered tenant-scoped. Not append-only: it is derived and
  recomputable; each run upserts on the unique key, and a definition change
  bumps `definitionVersion` and recomputes (no data migration).
- **Source-agnostic**: nothing in the model or job names a source lender.
  CredaFlow rows come from the tables in §3. An external extract is mapped by
  an adapter into the same shape, with `sourceSystem = 'external_extract'`
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
  `runWithTenant` frame per tenant; per-loan errors are counted in the body,
  a tenant's failure sets `x-cron-failed-tenants`; 503 only when every tenant
  failed (`sweepStatus`).
- **Tests**: pure outcome functions over fixtures (paid / late / returned /
  ever-90 / cure / pending / unobservable); a `RUN_DECISION_OUTCOMES_IT`
  suite proving idempotency (two runs, same rows) and the unique key.

### 4.1 External extract (generic process)

For the first real data, a pseudonymised extract from another lender's LMS:

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
  simulator book, every gap explained.
- **Calibration** (computed in PR B, expected empty): only records with
  `predictedProbability` (none today) enter. Per `modelVersion`, tenant and
  month: Brier score = mean((p − y)²) with y = headline bad; calibration
  buckets = deciles of p vs observed bad rate, with counts and a Wilson
  interval per bucket. The bureau score is an ordinal Sigma band, not a
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

- **Where**: a tab under `app/(dashboard)/reports/` (beside `arrears-aging`,
  `board-pack`), reading DPD through `lib/reports/arrears-snapshot.ts` and
  `lib/reports/book-arrears.ts` so its numbers match the board pack.
- **Who**: default-deny. A new permission `view_decision_performance` in
  `lib/registry/permissions/070-learning-loop.ts` (minimum `ADMIN`; ask
  whether LOAN_ADMIN should see it), plus `TenantConfig.featureReports`.
  Operator staff see nothing beyond the console's aggregate counts.
- **Views**: approvals by disbursal-month cohort × `ruleVersion` ×
  `policyHash` × `scoreBand` × overridden yes/no × product, with outcome rates
  (ever 30/60/90, bad, cured, settled, written off) and coverage; overrides
  vs non-overrides on the same cohort; take-up of offers; decline volume by
  category.
- **Collections panel**: cure rate and roll rate by stage and action type,
  channel and timing; promise-to-pay kept rate; arrangement kept/broken.
  Labelled on screen **"descriptive, not causal"**: there is no holdout or
  variant, so a difference between actions reflects who received them as
  much as what they did. No holdouts in v1 (withholding reminders is a
  conduct and treating-customers-fairly question that interacts with the
  consent and kill switches from #217).
- Small cells (< 20 loans) are greyed with counts shown, not hidden, inside a
  lender's own view.

## 7. Rollout

1. PR A: migration + hooks ship together (the CHECKs refuse only rows the
   code never writes). Demo stacks start writing records on the next image.
2. PR B: outcome model + job; verify coverage on the simulator book.
3. PR C: dashboard; show it in the browser on the FairScore demo.
4. Follow-ups: automated-refusal helper (SYSTEM records), collection-action
   records after R4 lands, gate version constants, decline-time gate
   evaluation, retention/pseudonymisation job.
5. External extract only after §4.1's legal points are signed off.

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
effect. `ConsentPurpose.AUTOMATED_DECISIONING`
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
  script. The dashboard must label demo data and make no learning claims.
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

1. Default: is the lender's "default" 60 DPD (escalation flip) or 90 DPD
   (dpd-update)? The log uses ever-90 as "bad" and tracks status separately.
2. Who sees the dashboard: ADMIN only, or LOAN_ADMIN too?
3. Retention: confirm the NCA record-keeping period with legal, and whether
   pseudonymise-after is acceptable.
4. Automated refusals: take the s71 finding to the lender's legal team now,
   or after the SYSTEM-record helper ships?
5. Collection-action records: build after R4 merges, or wait for a strategy
   / variant concept?
6. Benchmark floor: 5 lenders (proposed) or 10 (safer)?
7. Should the decline path evaluate the gates so "declined against PASS" is
   visible?
