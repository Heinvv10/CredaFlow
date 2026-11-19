# Quinn Pay parity + beyond — 2-week plan (2026-10-14)

Source: prospect handed us Quinn Pay's "Technical System Specification & White-Label
Deployment Options" (5 pages, ASP.NET MVC + shared SQL Server, ~500–1,000 merchants).
Gap audit was run against `origin/main` b8cb62b (local `main` was 233 commits behind).

## Decisions (Hein, 2026-10-14)

1. Prospect is a **reseller** (Fairscore-shaped). Lead with a **shared multi-lender platform**;
   a dedicated stack per big lender stays available (same image, one operator + one tenant).
2. New **`Operator` level above `Tenant`**. Operator staff manage lenders, see **no borrower
   data by default**; support access is lender-granted, time-boxed, audited. CredaFlow is the
   root operator.
3. **Borrowers are per lender.** `Client.idNumber` / `email` unique per `tenantId`, not global.
   Cross-lender network search is **out of the 2-week scope**; later only as fraud-signal-only
   opt-in, after a legal opinion (else SAFPS).
4. Collections stay **provider-agnostic** (`CollectionProvider`); Netcash is the first adapter.
   EasyDebit = Bitventure (competitor EDLM) — adapter only if a lender insists.
5. Deadline: **2 weeks, everything built, tested, proven, live.**

## What 2 weeks can and cannot deliver (stated to Hein)

Code-complete + tested on fixtures/sandboxes for every item: achievable with parallel streams.
"Proven live" is gated by third parties no amount of code shortens:

| Gate | Owner | Blocks |
|---|---|---|
| Netcash merchant account + DebiCheck service + test keys | Hein | W2 live proof |
| Bureau contracts + UAT creds: XDS, VCCB, CPB, MyData (+ TU, Experian UAT sample) | Hein / lender | W5 live proof |
| SACRRA ALG (needs ≥10 lenders) or direct lender membership | Hein | bureau submission LIVE |
| PEP/sanctions provider contract (provider TBD) | Hein | W4 live proof |
| Xero developer app (self-serve) | Hein | W6 sandbox proof |
| Stitch / SmileIdentity / WhatsApp Cloud sandbox accounts (already outstanding) | Hein | sandbox proofs |
| Legal sign-off: electronic DebiCheck mandate wording, OTP-signing clause, any translated borrower copy | Lender legal (internal: Lebohang for Ndzinga-derived wording) | merge of W2/W3/W7 NCA text |
| Production host (VPS) — spending money | Hein | go-live |
| Schema migrations | Hein approves each | every stream with DDL |

## Workstreams (each = own worktree off origin/main, own PR, blind /review)

DAG: **W0 → W1**; W0's schema PR must land before any stream that adds tenant-scoped models
(W2, W4, W6 rebase onto it). W3, W5, W7, W8 can start day 1.

- **W0 Platform foundation** (days 1–4, critical path)
  - `Operator` model + `Tenant.operatorId`; OPERATOR_ADMIN/OPERATOR_SUPPORT roles.
  - `Client` uniqueness → `@@unique([tenantId, idNumber])`, `@@unique([tenantId, email])`.
  - Postgres **RLS** on every tenant-scoped table, `SET LOCAL app.tenant_id` per request/txn,
    as backstop to `lib/tenant-scope.ts`. Raw-SQL audit.
  - Move ALL provider creds (Netcash, TU, Experian, Smile, BulkSMS, Stitch) into per-tenant
    `secret-box` encrypted fields; Stitch off global env.
  - verify: cross-tenant integration suite (`RUN_TENANT_ISOLATION_IT`) — tenant A session can
    read/write zero tenant-B rows via Prisma AND raw SQL; mutate RLS policy → suite goes red.
- **W1 Operator console** (days 4–9): create lender (identity, branding, domain, flags), reset
  lender admin, usage/billing counts, support-access grant flow (lender grants, expiry, audit).
  verify: E2E provision a lender from console on staging; operator without grant gets 403 on
  every borrower route (route-sweep test).
- **W2 Collections + strike date** (days 1–12): Netcash `createMandate` (TT1/TT1-delayed/TT2),
  `getMandateStatus`, `cancelMandate`, `collect`, `fetchResults`; `Mandate`, `CollectionBatch`,
  `CollectionResult` models; response/unpaid processing → payment allocation; retry engine
  (max 2 presentments/cycle, withdraw after 2 consecutive NPF, tracking 1–10 days); strike-date
  analysis from statement salary credits → recommended debit day. Flag-gated per lender.
  verify: fixture-driven state-machine tests; Netcash test env once keys exist.
- **W3 Signing + access control** (days 1–8): OTP step on agreement / mandate / document
  signing (email + WhatsApp; SMS stays off by policy), OTP evidence in signature record;
  WhatsApp OTP for portal login/registration; per-lender staff **working hours** + **IP
  allowlist** (SUPER_ADMIN bypass audited); enforce `featurePortal` + new-registrations toggle.
  verify: route tests per gate + browser check of each flow.
- **W4 Risk + FIC** (days 3–12): `ScreeningProvider` interface + first adapter (provider TBD)
  writing the existing `amlScreeningStatus`; PEP hit → REFER, blocks approval without senior
  override; FIC: CTR (cash threshold) + STR register, goAML-format export, RMCP template per
  lender, screening refresh cron. verify: fixtures; threshold boundary tests.
- **W5 Bureaus** (days 1–12): `BureauProvider` interface over Experian/TU; adapters XDS, VCCB,
  CPB, MyData built to published/obtained specs on fixtures; bureau-derived expenses into
  affordability; SACRRA push transport (SFTP) behind TEST mode. verify: fixture parse tests;
  UAT only where creds arrive.
- **W6 Payments + accounting** (days 3–12): Xero export (OAuth2, journals for disbursements,
  receipts, fees, interest, write-offs) + generic GL CSV; `PayoutProvider` with Capitec Pay /
  PayShap / cash-out adapters as providers are chosen. verify: Xero demo company round-trip.
- **W7 Multilingual** (days 1–10): next-intl for portal + public site + comms templates
  (en, af, zu, xh first). NCA documents stay English unless lender legal signs translations.
  verify: snapshot per locale; NCA render hashes unchanged.
- **W8 Ops + API + go-live** (days 1–14): uploads encrypted at rest + included in backups;
  restore drill on staging; monitoring/alerting; public **lender API** (API keys per tenant,
  scoped, rate-limited, OpenAPI, outbound webhooks for application/loan/payment events);
  go-live runbook on the VPS. verify: restore drill timed; API contract tests.

## Gates (every PR)

`npx tsc --noEmit`, `npm run lint`, `npm test`, relevant `RUN_*_IT` suites, blind `/review`,
security review for W0/W1/W3/W8. Migrations: Hein approves each. No prod deploy in business
hours; each prod deploy approved in-session.

## Strongest argument against

Fifteen workstreams of compliance-touching code in 2 weeks, reviewed by agents, means the
review/approval queue (migrations, legal wording, Hein's sign-offs) — not coding — is the
bottleneck. If Hein can't clear ~2 approvals/day, the date slips regardless of build speed.
