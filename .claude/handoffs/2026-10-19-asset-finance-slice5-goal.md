# /goal — Asset finance slice 5: dealer portal with commission, telematics, valuation guides

## Start a new session

Start on **Opus** in `/home/hein/Workspace/CredaFlow` and paste:

> /goal Execute .claude/handoffs/2026-10-19-asset-finance-slice5-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → independent Review → Fix loops, one PR per part (§3 A, B, C, in that order). Do not stop to ask except at a Confirmation Gate (§8) or a genuine external blocker. Prove every Success Criterion (§7), merge each PR through mq, write the handoff and memory update, clean up your worktrees, branches and containers, then stop.

This file prepares a future session; it does not start implementation.

## §1 Mission

Slice 5 of `docs/asset-finance/DESIGN.md` ("Dealer/broker portal, tracker/telematics
integration, valuation feeds"). Three parts, three PRs:

- **A. Dealer/broker portal with commission.** Dealer staff log in to their own
  portal, submit asset-finance deals, track only their own deals, and earn
  commission that the lender pays through approved payable runs.
- **B. Tracker/telematics adapter + simulator.** A provider-neutral interface with a
  synthetic simulator; device status, meter readings, position and alerts feed the
  payout checklist, lease usage and recovery.
- **C. Valuation-feed adapter + CSV valuation guide.** A provider-neutral interface;
  a lender uploads a dated valuation guide (CSV) and deals and assets pull values
  from it; a synthetic provider for tests.

"Built" means real DB rows and enforcement, real routes with RBAC and audit, real
UI, real-PG integration tests that fail when a rule is removed, and browser
acceptance with screenshots on an evidence page. No real provider, no real money,
no real message.

## §2 Verified starting point — re-check live before building

- Asset finance slices 1–4 (incl. 4b journals and IsaFlow push) and lender-owned
  templates (#183) are merged. Read `docs/asset-finance/DESIGN.md`,
  `docs/asset-finance/SLICE4.md`, `lib/asset-finance/.claude.md`, and the previous
  goal files in `.claude/handoffs/*asset-finance*goal*.md` for structure and rules.
- The shared checkout `/home/hein/Workspace/CredaFlow` is dirty and shared: never
  reset, stash, clean, pull into or commit from it, and never touch
  `.claude/handoffs/LATEST.md`. Fetch origin/main, work in your own worktrees with
  their own `npm ci --legacy-peer-deps`. Other sessions are active (many
  `CredaFlow-*` worktrees, demo deployment agents): run the collision check first.
- Facts mapped on 2026-10-19 (verify; names may have drifted):
  - **No Dealer/Broker concept exists.** Only `ValuationSource.DEALER`,
    `SaleChannel.DEALER`. DESIGN.md lists `Dealer` under later slices.
  - **Identities:** staff are `User` (`UserRole` in `prisma/schema/auth.prisma`);
    portal users are the `Client` row itself (`lib/auth.ts` `authorize()`),
    with no TOTP. `roleRefusedOnThisHost` (`lib/auth-config.ts`) and `proxy.ts`
    give one audience per host. Dealer users fit neither, so they need a new principal.
  - **Commission precedents:** `ReferralAgent`/`ReferralEvent` (`prisma/schema/crm.prisma`,
    `lib/referral-agents/commission.ts`, statements `lib/agent-hub/statement.ts`) and
    insurance `AdvisorCommission` (`prisma/schema/insurance.prisma`). Reuse ideas,
    not tables.
  - **Origination:** `lib/asset-finance/deal-create.ts` (DRAFT `LoanApplication` +
    `AssetFinanceDeal`, active `Supplier` required), `deal-submit.ts` (classifier),
    statuses `AssetDealStatus`. Permissions in
    `lib/registry/permissions/020-asset-finance.ts`.
  - **Money out:** `Payout` (`lib/asset-finance/payout.ts`) and `RecoveryRefund`
    are approval-and-release *records* with four-eyes; there is no bank rail.
    Supplier bank accounts: four-eyes CHECK + AVS (`supplier-bank-decision.ts`,
    `supplier-avs.ts`).
  - **Journals:** `lib/accounting/accounts.ts` `ACCOUNT_ROLES` (append only; order is
    load-bearing), `lib/accounting/sources-asset-finance.ts`, IsaFlow push
    `lib/accounting/isaflow/`. No commission roles exist.
  - **Tracker/meters:** `FinancedAsset.trackerProvider/trackerId` (free text, frozen
    once `TRACKER_CONFIRMED`, `asset-freeze.ts`); payout item `TRACKER_CONFIRMED`
    needs a `TRACKER_CERTIFICATE` document (`payout-checklist.ts`).
    `AssetMeterReading` (monotonic, immutable trigger) with
    `MeterReadingSource` = STAFF | PORTAL; single writer `recordMeterReading`
    (`meter-readings.ts`, leases only). Excess usage `lease-usage.ts`,
    `lease-end-billing.ts`. Recovery location is free text; no locate step.
  - **Valuations:** `AssetValuation` with `ValuationSource` DEALER | AUCTIONEER |
    ASSESSOR | INTERNAL; writers `app/api/asset-finance/assets/[id]/valuations/route.ts`,
    `recovery-store.ts`, `surrender-store.ts`; SQL `purchaseValuationOk` and the
    recovery-sale trigger require a recent non-INTERNAL valuation.
  - **Adapter patterns:** `lib/bureau/{types,registry}.ts` + `providers/simulated.ts`;
    `lib/integrations/simulation-guard.ts` and `lib/registry/simulated-integrations/`
    (simulated output labelled, fails closed on deployed builds);
    `lib/asset-finance/sarb-rate-feed.ts` + `rate-feed-sync.ts` (injectable fetch,
    PENDING values approved by a person); cron `app/api/cron/reference-rate-feed/route.ts`;
    registries `lib/registry/{audit-actions,permissions,cron-jobs,tenant-scoped-models}/`.
  - **Flag:** `TenantConfig.featureAssetFinance` (`lib/asset-finance/require-enabled.ts`).

## §2a Product decisions (made by Hein 2026-10-19, or defaults set for this goal)

Hein chose: **dealer portal = submit + track + commission; telematics = adapter +
simulator; valuations = adapter + CSV guide; one goal, three PRs.** The rest are
defaults; build them as written. If evidence shows one is wrong, record why in the
spec, choose the safer option, and flag it in the handoff, without stopping.

**A. Dealer portal**
1. `Dealer` is a tenant-scoped organisation (dealer or broker, flag `kind`), with
   optional link to the `Supplier` it also is. Separate per-tenant feature flag
   `featureDealerPortal` (default off).
2. `DealerUser` is a **new principal**, not a `User` or `Client`: its own audience
   (`DEALER`) in `authorize()`/`jwt()`/`proxy.ts`/`roleRefusedOnThisHost`, own route
   group `app/(dealer)/` and API `app/api/dealer/*`, and no access to staff or client
   routes, and vice versa. **Dealer 2FA is deferred (Hein 2026-10-19):** password
   login only in this slice, with login rate-limiting and lockout like staff. Until
   dealer 2FA ships, `featureDealerPortal` may be on only for a demo lender
   (`isDemoLender`); a DB CHECK or trigger refuses it on any other lender, with a
   real-PG test. Leave the principal ready for a TOTP step later. Dealer roles: DEALER_ADMIN
   (manages its own users) and DEALER_SALES. Lender staff (LOAN_ADMIN+) create
   dealers and the first dealer admin; deactivation revokes sessions (token version).
3. A dealer can: create a deal draft (entity, directors/trustees as captured
   people, asset, supplier, structure quote via the existing solver), upload the
   deal's documents, record the borrower's POPIA consent (an uploaded signed consent,
   attested by the dealer user), and submit. The deal then enters the existing staff
   flow (`deal-submit.ts`, classifier, credit memo, decision). Every dealer write
   goes through the existing deal code and audit, with the dealer as actor.
4. A dealer sees **only its own deals**: status, missing items, document requests,
   signing progress and booking. Never the credit memo, bureau data, decision
   reasons, other dealers' deals, or any data the borrower didn't give through that
   dealer. Cross-dealer and cross-tenant access returns 404.
5. **Commission:** per-dealer rate in basis points of the financed amount, plus an
   optional flat amount, both with tenant defaults and date-effective history;
   snapshotted on the deal at approval. **Earned at BOOKED.** Cancelled before
   booking means no commission. Clawback: a tenant setting (months; default 0 = off)
   fully reverses commission when the loan settles early or terminates inside the
   window; a reversal is a new negative line, never an edit. Commission is a cost to
   the lender. It is never added to the borrower's charges or cost of credit
   (consumer NCA deals especially). The legal reviewer confirms this.
6. **Payable runs:** monthly per dealer: a statement of earned and reversed lines,
   created by one staff user and approved by another (four-eyes, DB-enforced),
   then RELEASED as a record (no bank rail, like `Payout`). It is paid to the dealer's
   APPROVED bank account (four-eyes + AVS, same pattern as supplier bank accounts).
   Each line belongs to at most one run (DB unique). A commission invoice VAT
   treatment follows the dealer's VAT vendor status. **Tax reviewer confirms.**
7. **Journals:** append roles for dealer commission expense, payable and input VAT
   to `ACCOUNT_ROLES` (append only), with derivation sources for earned, reversed and
   released lines, reconciled like the existing asset-finance sources and included
   in the IsaFlow push.

**B. Telematics**
8. `TelematicsProvider` interface (device status/heartbeat, position, meter
   hours/km, ignition, alerts: tamper, power cut, geofence exit) with a registry and a
   **simulated provider** registered in `simulated-integrations` (labelled, refused on
   deployed builds). No real provider.
9. `TrackerDevice` linked to `FinancedAsset` (provider, device id, installed date,
   status); the existing `trackerProvider/trackerId` stay the source for the payout
   item; a live heartbeat is shown beside the certificate but **does not replace the
   TRACKER_CERTIFICATE evidence**.
10. Ingestion by cron poll (registry entry, `CRON_SECRET`), idempotent per provider
    event id. Meter values become `AssetMeterReading` rows with a new source
    `TELEMATICS` (additive enum) through `recordMeterReading` for leases only, still
    monotonic; a lower or implausible reading is held for staff review, not written.
    Instalment-sale telemetry is stored as device readings only.
11. Alerts create collections/recovery work items for the deal (no outbound message).
    Recovery and legal-matter pages show the last known position with time.
12. **POPIA:** position data is personal data for sole proprietors: retained for a
    tenant-set period (default 90 days, purge cron), visible only to
    COLLECTIONS_OFFICER+ on that deal, and every position view is logged
    (`DocumentAccessLog`-style). Dealers never see telematics.

**C. Valuation guides**
13. `ValuationProvider` interface with a registry; a **synthetic provider** for tests;
    and a **CSV valuation guide** provider: a LOAN_ADMIN uploads a guide (name,
    effective date, file sha256; rows make/model/year/variant → trade and retail
    cents). The upload is validated (strict CSV, money as cents, duplicates refused) and stays
    DRAFT until a second admin publishes it. Published guides are immutable; one
    current guide per tenant per name.
14. Lookups write `AssetValuation` rows with a new source `GUIDE` (additive enum),
    with guide id and row snapshot. Used for: deal origination advance/LTV display, a
    book revaluation report, and recovery reference. **A GUIDE valuation does not
    satisfy the independent-valuation rules** (`purchaseValuationOk`, recovery sale
    trigger); prove that with a real-PG test.

## §3 Scope per PR

Each PR: concise spec + rule-to-test matrix first (`docs/asset-finance/SLICE5.md`,
one section per part), migrations additive (new tables, nullable columns, enum values)
shipped together with the code that satisfies their triggers, TDD with failing
regressions first, DB rules proven by `RUN_ASSET_FINANCE_*_IT` real-PG suites, and
mutation evidence for the gates (`evidence/slice5/MUTATIONS.md`).

- **PR A, dealer portal + commission:** §2a items 1–7. Negative cases:
  - cross-dealer and cross-tenant access
  - a dealer reaching staff or client routes, and the reverse
  - the dealer portal flag set on a non-demo lender
  - a deactivated dealer or user
  - commission on a cancelled deal
  - a line in two runs
  - self-approved runs
  - a release to an unapproved bank account
  - clawback inside and outside the window
  - an NCA deal's cost of credit unchanged by commission
- **PR B, telematics:** items 8–12. Negative cases:
  - simulated provider on a deployed build
  - duplicate events
  - a lower or implausible meter value
  - an instalment-sale meter write
  - position visible to a READONLY user or a dealer
  - the purge
  - a heartbeat without a certificate not completing the payout item
- **PR C, valuation guides:** items 13–14. Negative cases:
  - malformed or duplicate CSV
  - self-publish
  - editing a published guide
  - a GUIDE valuation used for a lease purchase or recovery sale
  - cross-tenant guide use

## §4 Execution process

1. Collision check (worktrees, open PRs, `mq status`), then fetch origin/main.
2. Spec and matrix for the part; then build TDD in an isolated worktree.
3. Scoped checks while iterating, then the complete `npm run ci:full` in a fresh
   clone on the exact head being merged. IT DBs via `scripts/it-db.sh up cf-it-<unique>`,
   torn down with `docker rm -fv`.
4. Fresh independent reviewers that receive only the diff and CLAUDE.md files: code
   quality, security (plus an adversarial **policy-breaker** for the dealer principal,
   commission runs and position access), tests (mutation), architecture (Opus), SA
   legal (dealer/broker intermediation, NCA cost of credit, POPIA consent and
   location data), tax/accounting (commission VAT and journals), and an independent
   edge tester in its own clone. Loop until all SHIP; commit their repros.
5. Browser acceptance against an isolated seeded local stack (synthetic lender,
   two synthetic dealers, synthetic devices and guide), password + TOTP logins
   for staff (password only for dealer users). Screenshots plus `browser/README.md` per part.
6. Merge via `mq add <pr>` only; verify the reviewed head is an ancestor of main
   and the tested tree is identical. Then start the next part from fresh main.

## §5 Acceptance (browser, per part)

- **A.** Dealer admin creates a sales user. Sales submits a deal with consent and
  documents. Staff decide and book it. The dealer sees status only. A second dealer
  cannot see it. Commission accrues at booking. Staff create a run; another approves
  and releases it. Early settlement inside the clawback window shows the reversal on
  the next statement. The journals appear in the accounting export.
- **B.** The simulator drives a leased asset: heartbeat, meter readings arrive as
  TELEMATICS readings and feed the projected excess, a tamper alert raises a work
  item, and a recovery page shows the last position. A READONLY user and a dealer are
  refused.
- **C.** Admin uploads a guide, which is refused with reasons when malformed. A
  second admin publishes it. A deal shows guide value and LTV. A lease purchase
  election still demands an independent valuation.

## §6 Documentation and handoff

Update DESIGN.md (slice 5 status), `docs/asset-finance/SLICE5.md`,
`lib/asset-finance/.claude.md` (+ `npm run agents:mirror`), ARCHITECTURE.md for the
new principal, and DEPLOY-ENV.md for any new env or cron. Final handoff
`.claude/handoffs/<date>-asset-finance-slice5-done.md` (PRs, merge SHAs, CI runs,
review verdicts, evidence paths, open legal/tax items). Memory: extend the asset
finance memory entry (slice 5 status).

## §7 Success criteria — all must be proven

1. SLICE5.md spec and rule-to-test matrix cover §2a items 1–14.
2. Dealer principal isolated from staff and client audiences in both directions;
   portal refused on non-demo lenders until dealer 2FA ships; cross-dealer/tenant
   404s; tests prove each.
3. Dealer-submitted deals run the unchanged staff credit flow; dealers never see
   memo, bureau, reasons or others' data.
4. Commission accrual, clawback, runs, four-eyes, bank-account approval and
   one-run-per-line are DB-enforced and proven on real PG; borrower cost of credit
   unchanged; journals reconcile.
5. Telematics adapter + simulator with idempotent ingest, guarded meter writes,
   alerts, last-position view, POPIA retention/purge and access logging, proven.
6. Valuation guide upload/validate/publish/lookup with four-eyes and immutability;
   GUIDE never satisfies independent-valuation rules (real-PG test).
7. Browser acceptance for A, B, C with screenshots and README; 0 page errors.
8. Every PR: complete `ci:full` green on the merged head, all reviewers and edge
   tester SHIP, mutations killed, `scripts/integration-baseline.txt` not grown.
9. Three PRs merged via mq in order A → B → C; ancestry/tree identity verified.
10. Docs, handoff and memory written; worktrees, branches and containers you created
    removed; shared checkout, LATEST.md and other sessions untouched.

## §8 Confirmation gates — stop and ask Hein

- Any real telematics or valuation provider, credentials, contract or paid API.
- Sending a real message, making a real payment, or any spend.
- Destructive or non-additive migrations, or DDL on any shared database.
- Deploying, restoring or re-baking any demo/Fairscore stack, or changing another
  agent's runtime.
- Changing NCA-mandated wording, consumer PDF pins or signed-off calculations, or
  setting any lender's legal-approval flag.
- Adding commission to a borrower's charges, or any change to cost of credit.

Before asking, finish the authorised work and present the exact proposal and evidence.
