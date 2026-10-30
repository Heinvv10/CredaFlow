# CredaFlow architecture

CredaFlow is a loan management system for NCA-registered credit providers.
This document covers what a contributor needs before changing it: the
modules, how a lender (tenant) is identified and themed, why the database
enforces so much, how migrations work from the baseline on, the seeds, and
the test layers. Day-to-day rules are in `CLAUDE.md`.

## The system

One Next.js (App Router) application on PostgreSQL via Prisma, built as one
Docker image that serves three audiences:

| Surface | Routes | Who |
|---|---|---|
| Staff app | `app/(dashboard)`, `/login` | the lender's staff (TOTP 2FA, required by default per lender) |
| Client portal | `app/(portal)`, `/portal/*` | borrowers |
| Public website | `app/(website)`, `/`, `/site/*`, `app/(quote)` | the public |

`APP_MODE` (`staff`, `client` or `all`, read by `proxy.ts`) lets the same image
run as separate staff and portal services that 404 the other audience's
routes, each with its own session secret (`docker-compose.yml`).

### Modules (`lib/`)

- **Origination** — `applications/`, `affordability/`, `credit/`, `decision/`,
  `kyc/`, `ocr/` (document extraction), `qualify.ts`, `loan-calculator.ts`,
  `pdf/` (the NCA documents), `disbursement/`.
- **Servicing** — `loan/` (schedules, balances, default charges), `payments/`,
  `bank-sync/` (statement import and reconciliation), `collections/`
  (escalation, arrangements, Section 129).
- **Customer contact** — `messaging/` (the one send pipeline), `email/`,
  `whatsapp/`, `inbox/`, `notifications/`, `automation/`, `unsubscribe/`.
- **CRM and growth** — `crm/`, `agent-hub/`, `referral-agents/`, `website/`,
  `website-chat/`, `seo/`, `analytics/`.
- **Insurance** — `insurance/` (products, quotes, policies, claims).
- **Compliance** — `compliance/` (DSAR, complaints, conflicts of interest,
  breaches, NCR/FSCA returns), `bureau-submission/` (bureau files),
  `audit.ts`, `document-auth.ts` (logged document access).
- **Platform** — `tenant.ts`, `tenant-scope.ts`, `config/` (lender identity,
  deployment URLs), `auth*.ts`, `permissions.ts`, `totp.ts`, `crypto/`,
  `date/` (SAST calendar and business days), `integrations/` (third-party
  clients).

Modules with rules of their own carry a `.claude.md` (listed in `CLAUDE.md`).

## Tenancy and identity

Every row that belongs to a lender carries `tenantId`. Each deployment serves
one or more `Tenant` rows; each tenant has one `TenantConfig`.

- **Resolving the tenant.** A request resolves its tenant by domain, then by
  the `x-tenant-slug` header (set by `proxy.ts` from the host, never trusted
  from the caller), then by `NEXT_PUBLIC_TENANT_SLUG` (`lib/tenant.ts`,
  `getTenantFromRequest` / `getResolvedTenantId`). Staff and portal sessions
  carry their user's `tenantId`. Cron routes (`app/api/cron/*`) have no
  request tenant of their own; these are the patterns in use (examples, not
  a full list):
  - a per-tenant frame: loop over the tenant rows and run each tenant inside
    `runWithTenant` (website-chat-close, website-chat-handoffs,
    sweep-stuck-selfies; cross-sell and dormant-clients, which sweep ACTIVE
    tenants only because they create sales opportunities; dpd-update,
    escalations, reminders, arrangement-check and default-charges, the nightly
    dunning chain, through `sweepActiveTenants` in
    `lib/ops/tenant-sweep.ts`, which also decides the HTTP status: 503
    only when every tenant failed);
  - an explicit `tenantId` on every tenant-scope query, with no frame:
    insurance-renewal;
  - a loop over the tenants whose `TenantConfig` enables the job, still one
    frame per tenant: default-charges (a feature flag plus a recorded
    go-live) and screening-refresh (a configured provider);
  - `getTenantFromRequest()`, which, when the scheduler's `NEXTAUTH_URL` host
    matches no tenant domain (or is unset, so the call goes to localhost),
    falls back to `NEXT_PUBLIC_TENANT_SLUG` or the sole ACTIVE tenant, and
    answers 400 when that is ambiguous: for example poll-wa-templates and
    stale-leads-alert;
  - unscoped, under `withoutTenantScope`: email-poll;
  - the default tenant, `getDefaultTenantId()`, which throws rather than
    guess: licence-expiry still uses it.
- **Scoping queries.** `lib/tenant-scope.ts` is a Prisma extension that adds
  the current tenant (from `AsyncLocalStorage`, set by `runWithTenant`) to
  queries on the models in `TENANT_SCOPED_MODELS`. Models outside that list
  must pass `where: { tenantId }` by hand.
- **Row-level security.** Underneath the extension, Postgres RLS
  (`prisma/migrations/20261014130000_tenant_rls`, extended to later scoped
  models by `20261015130000_tenant_rls_new_scoped_models`) filters the scoped tables and
  the borrower core's children by `app.tenant_id`, which `lib/tenant-rls.ts`
  sets transaction-locally for every query and transaction run inside a frame
  when `TENANT_RLS=on` (`withoutTenantScope` sets `app.rls_bypass` instead).
  It is off by default and is **not a backstop yet** (see the activation
  checklist below). Once active it catches what the
  extension cannot see: raw SQL, nested relation reads, trigger bodies. With no
  frame the policies let rows through unless the database sets
  `app.rls_strict = 'on'`. RLS binds only a role that is neither superuser nor
  `BYPASSRLS`; the application must connect as such a role for it to hold.
- **Operators.** An `Operator` (CredaFlow is the root one) runs tenants.
  Operator staff (`OPERATOR_ADMIN`, `OPERATOR_SUPPORT`) hold no tenant and
  clear no tenant role gate; a lender's ADMIN may grant one of them read-only
  access for up to 7 days (`TenantSupportGrant`, `lib/operator/`), and every
  grant and use is audited. Read-only means GET/HEAD: `proxy.ts` refuses any
  other method from an operator session, server actions included. New
  tenants default to the root operator.
- **Operator console.** Operator staff sign in and work only on their own
  host, `OPERATOR_APP_HOST` (`/operator`, `/api/operator`;
  `lib/proxy/operator-host.ts`), as clients do on the portal host: the
  session cookie is host-only, the console host serves nothing else, and no
  other host serves the console or accepts an operator session. TOTP is
  mandatory (no lender policy applies): a user without it reaches only the
  enrolment page, and the console accepts only a sign-in that verified a code
  (`lib/operator/console-auth.ts`). `OPERATOR_ADMIN` provisions lenders
  (`scripts/lender`'s validation and create path, plus an invite to the first
  SUPER_ADMIN), suspends and reactivates them (suspension stops the lender's
  staff signing in and ends their sessions), sends a lender admin a reset
  link, and manages operator users; `OPERATOR_SUPPORT` views lenders and uses
  grants. Invite and reset links go to the account's own email through the
  deployment's SMTP account; the console never sees a password or token.
  Lender pages show aggregate counts only; "open lender" reads a short,
  masked borrower summary through `resolveOperatorTenantAccess` (an active
  grant, audited per use). The lender grants and revokes under Settings →
  Support access, which also shows the support-access audit trail.
  `lib/operator/console-census.test.ts` lists every console page and route and
  runs each against sentinel borrower rows. Writes on the console host must be
  same-origin, and `/api/operator` writes JSON (CSRF). A support grant does not
  open a suspended lender. A lender's custom domain (`Tenant.domain`, which
  outranks the slug in host resolution) is normalised and may not be a host the
  deployment serves or another lender's subdomain host
  (`lib/config/tenant-domain.ts`).
- **Dealer portal.** A lender's dealers and brokers (`Dealer`, `DealerUser`;
  asset finance slice 5, `docs/asset-finance/SLICE5.md`) are a third
  principal, role `DEALER`, which is not a `UserRole`: every staff role gate
  refuses it. Like operator staff they sign in and work only on their own
  host, `DEALER_APP_HOST` (`/dealer`, `/api/dealer`;
  `lib/proxy/dealer-host.ts`), which runs on the staff container and resolves
  the lender through `TENANT_HOST_MAP`; off it the dealer paths 404 and a
  dealer session is refused, and on it any other session 404s. Unlike them a
  dealer user belongs to one lender and one dealer, and every refusal of a
  signed-in dealer is 404 (`lib/dealer/guards.ts`). Revocation is
  `DealerUser.tokenVersion`, re-checked on every request
  (`lib/dealer/principal.ts`). Dealer actions are audited with no `userId`
  and `newValue.actor` naming the dealer user. A dealer captures borrowers,
  assets and draft deals and hands them over; the lender's staff accept the
  handover and run the unchanged credit flow. Commission accrues, claws back
  and nets into payable runs in the database. Passwords only, so the portal
  is allowed only on a demo lender (CHECK
  `TenantConfig_dealer_portal_demo_only`) until dealer 2FA ships. Module
  rules: `lib/dealer/.claude.md`.
- **Borrowers are per lender.** `Client` is unique on `(tenantId, idNumber)`
  and `(tenantId, email)`; one person may be a client of two lenders.
- **Provider credentials** are per tenant, sealed in `TenantConfig`
  (`lib/integrations/tenant-credentials.ts`). The Experian, SmileIdentity and
  Stitch environment variables serve only the tenant
  `ENV_CREDENTIALS_TENANT_SLUG` names (set by `provision-lender.sh` on a
  dedicated stack); unset, they serve no one.
- **Lender identity.** Legal name, trading name, NCR, FSP and company
  registration numbers, office address, contacts and logo are columns of
  `TenantConfig`. `lib/config/identity.ts` reads them:
  `getLenderIdentity(tenantId)` returns a validated `LenderIdentity` or throws
  `LenderIdentityError`; `findLenderIdentity` returns null instead. There are
  no defaults: an NCA document, a customer message or a website page for a
  tenant without a valid identity refuses to render (the website shows a
  not-configured page). `lib/config/identity-write.ts` is the only write path:
  it validates, requires statutory numbers to be typed twice, and writes a
  `LENDER_IDENTITY_UPDATED` audit row.
- **Brand colours.** `TenantConfig.primaryColor`, `secondaryColor` and
  `darkColor` are published by `components/TenantThemeProvider.tsx` as
  `--cf-tenant-primary/secondary/dark`. `app/globals.css` builds the brand
  tokens from them: on light surfaces the primary as given, on dark surfaces a
  lighter mix that stays readable whatever primary a tenant picks. Components
  use the `--cf-*` tokens. `scripts/palette-contrast.ts` checks WCAG AA for
  every text/surface pair in both modes, for the default colours and the demo
  tenant's. Saving a tenant's colours (`app/api/admin/tenants`) runs the
  same check with those colours applied (`lib/theme/tenant-colours.ts`) and
  refuses a set that fails it, with a reason per field. The website's and the
  sign-in pages' `--cf-*` tokens follow the tenant too; the website's
  hardcoded accent classes, the NCA PDFs and the emails use the default
  palette.
- **Feature flags.** `TenantConfig.feature*` switch modules (CRM, insurance,
  bureau submission, portal, …) per tenant (`resolveFeatureFlags`).

## Lender-owned asset-finance templates

Each lender owns the wording of its asset-finance agreements, suretyships and
resolutions (spec: `docs/asset-finance/evidence/lender-owned-templates/SPEC.md`;
code: `lib/asset-finance/documents/templates/`).

- **Ownership.** One `DocumentTemplate` of kind `ASSET_FINANCE` per lender per
  document variant (`af.isa.cpa`, `af.lease.fml.commercial`, …), adopted from
  the starter wording through Settings → Document templates. Adoption copies
  the starter into the lender's own version 1; later starter changes never
  overwrite it.
- **Protected content.** Identity comes from `TenantConfig`; figures,
  schedules, statutory and CPA notices and every numbered clause come from the
  trusted renderers. Only the commercial agreement variants take lender text:
  a few editable clauses and additional terms, validated on every save,
  preview, approval, publication and issue.
- **Versions and approval.** Versions are immutable and hashed by the
  database. A second admin approves the exact content hash; a third action
  publishes it; one ACTIVE version per template. A demo lender's approval is
  `SYNTHETIC_DEMO` and its documents carry a demo watermark; a real lender's is
  `LENDER_LEGAL`, recorded by a SUPER_ADMIN on written legal sign-off, and
  prints no mark. The legacy `assetFinanceLegalWordingApproved` flag approves
  none of these documents.
- **Issuance.** Preparing or issuing a document selects the lender's published,
  approved version or refuses; there is no fallback. Each issued document has
  an `AssetDocumentIssuance` row (version, approval, lender identity, render
  input and PDF hashes; input and PDF in `lib/storage`). Signing and
  contracting re-render with that pinned version and identity, so later
  publications never change a document already issued. Rows prepared before
  this existed must be prepared again before signing.
- **Upgrading a stack.** After migrating an existing database, every lender
  must adopt, approve and publish its templates before documents can be
  prepared; for a demo lender, `scripts/asset-finance/ensure-demo-templates.ts`
  does it with synthetic approvals (the demo seed does it on a fresh bake).
  It needs two different active staff users of LOAN_ADMIN or above. A stack
  restored nightly from a snapshot must be re-snapshotted after the backfill
  (or re-baked), or the restore removes the templates again. A deal partly
  signed before the upgrade cannot be prepared again or finish signing: cancel
  it and originate it again.

## The database enforces the rules

The application checks compliance rules, and the database enforces the ones
that must never be broken by any code path: triggers that refuse a
disbursement without its signed documents (agreement, debit mandate), CHECK
constraints on money and statuses, partial unique indexes (a bureau status is
submitted live only once, one open conversation per contact), signed and bound
documents that cannot be changed, and functions for the statutory calendar
(public holidays). A bug, a script or a hand-written query
then fails loudly instead of corrupting a ledger or a legal record.

The consequence for tests: a mocked Prisma cannot execute any of this. A rule
enforced in the database is only tested by an integration suite against a
migrated database (below). Before changing a rule, enumerate the live
enforcement (`pg_trigger`, `pg_constraint`; the queries are in `CLAUDE.md`),
and `npm run db:drift` compares a live database's objects with what the
migrations declare.

## Tamper-evident audit and SIEM forwarding

`AuditLog` is the record of every state change (`lib/audit.ts`). Postgres makes
it append-only and a keyed hash chain makes it tamper-evident; module rules in
`lib/audit/.claude.md`.

- **Append-only.** Triggers refuse UPDATE, DELETE and TRUNCATE on `AuditLog` and on the
  evidence tables (`AuditChainLink`, `AuditChainCheckpoint`, `AuditRedaction`,
  `AuditChainRepair`, `AuditPolicyRevision`, `AuditSiemDelivery`), and DELETE and TRUNCATE
  on `AuditPolicy`. An audit row's `createdAt` is the database clock at insertion
  (trigger), whatever the caller sent. The only change a row ever sees is
  `audit_log_redact()` nulling personal data (POPIA).
- **Chain, after commit.** An audit insert touches no chain. The chainer (cron
  `audit-chainer`, every few seconds, advisory lock per chain) appends a link per
  committed row; `rowHash` is an HMAC under `AUDIT_CHAIN_KEY`, which is not in the
  database, over **keyed digests** of the personal-data columns (also under the key,
  computed by the worker, so the database never holds an unkeyed hash of an email or
  an address). A rolled-back transaction leaves no link; a Serializable one never
  waits on a chain. There is no wall-clock window: each chain has a high-water mark
  (newest `createdAt` among its last 1000 links), a pass looks past the mark less an
  hour (never further back than the 5000th newest link); a deep pass (seven days back; at
  boot and hourly) and a daily full sweep (no floor) find a row that committed long after it
  was made. A backfill or an outage of any length resumes from the mark, in batches of 500,
  until done. Each chain is locked by a row only `audit_chain_lock` touches (FOR UPDATE SKIP
  LOCKED), not an advisory lock any login could take; the database hands the worker a SHA-256
  of each value (the worker keys it), so a huge row costs it nothing, and an insert trigger replaces
  any `oldValue`/`newValue` over 1 MB with a stub (`{truncated, bytes}`), whoever writes it, so no
  writer fails and none needs changing. A batch that fails (a timeout on rows slow to hash) is retried
  at half the size down to one row, within a 20 s retry budget per chain per pass and never past the pass
  deadline; a chain that still fails is logged and left alone with a doubling backoff (30 s to 15 min), and
  the size that last worked is remembered, so it never stops another lender being chained or burns a pass. `idle_in_transaction_session_timeout` is set on the application logins
  but is a user setting a login can change; it is advisory, and the deep pass and daily sweep are the
  backstop for a late commit.
- **Verification.** `npm run audit:verify` and the daily `audit-chain-verify` cron
  (the worker, which holds the key) walk every chain, report **every** break (not
  the first), skip a checkpoint whose signature fails, and list the breaks an operator
  signed off (`npm run audit:accept-break`: an HMAC-signed, audited
  `AuditChainRepair`; a repair without the key is itself reported). A daily signed
  checkpoint per chain signs exactly the (seq, hash) the walk verified, bounds
  the next walk and is sent to the lender's SIEM. The web process only reports
  status (`GET /api/admin/audit/verify`): it has neither the key nor the access.
- **Three database logins (deploy requirement).** The **owner** (`POSTGRES_USER`, Helm
  `migrate.databaseUrlSecret`) owns the schema, runs migrations and owns the SECURITY
  DEFINER audit functions. The **web** login (`audit_grant_web`) holds INSERT and SELECT on
  `AuditLog`, SELECT on `AuditPolicy`, and EXECUTE on `audit_policy_save` and
  `audit_chain_status`; the **worker** login (`audit_grant_worker`) the chainer, verifier,
  checkpoint and SIEM-delivery functions. Neither owns anything, is a superuser,
  `BYPASSRLS`, `CREATEROLE`/`CREATEDB`, holds `CREATE` on `public`, or is a MEMBER
  (`pg_has_role`) of a table owner or `audit_redactor`; the grants refuse such a role. Neither
  has any privilege on the links, checkpoints, redactions, repairs, revisions, receipts,
  outbox, lease, or the sequences behind them: everything goes through `audit_*` functions
  that check what they are given (`lib/audit/store.ts`). `AUDIT_CHAIN_KEY` and the worker
  login live in the worker's Secret only (Helm `worker.existingSecrets`); a single process that
  runs the app and the crons shares one login (`audit_grant_runtime`) and one key: weaker, and
  `/api/health` says so on a web process that holds the worker functions or the key. The
  role/ACL tests are `runtime-role`, `grant-refusals` and `outbox-functions` integration
  suites. `deploy/helm/credaflow/files/app-role.sql` creates the logins and grants them (re-run
  after every migration: compose `db-roles`, `scripts/lender` `ensure_app_role`, the chart's
  `app-role` Job). In production a process whose role owns a table, is a superuser or can
  create roles refuses to start (as does one whose setup check cannot run), unless
  `AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1` (demo/legacy stacks; `DEMO_MODE` does not stand in; logged loudly at every boot and
  shown in `/api/health`). The Helm chart renders only with two logins unless `audit.singleLogin=true`. The owner login never
  reaches the app containers (compose blanks it; the chart keeps it in a Secret no pod
  mounts). A restore with `--no-owner --no-acl` loses ownership and ACLs: the restore scripts
  run `audit_reassert_protections()` and the grants again.
- **Redaction is a role, not a setting.** `audit_log_redact` is owned by the NOLOGIN role
  `audit_redactor`; the append-only trigger lets an UPDATE through only when
  `current_user = 'audit_redactor'` and an `AuditRedaction` row records the keyed digest of
  each column being nulled (computed by `npm run audit:redact`, which holds the key). No login
  is a member and none can write `AuditRedaction`. The `AUDIT_ROW_REDACTED` row (an operator's
  free-text reason) is never forwarded to a SIEM.
- **Policy changes go through one function.** `audit_policy_save` is the only way an
  `AuditPolicy` changes (no login has DML on it; a trigger refuses DELETE). In one transaction
  it writes the policy, the `AuditPolicyRevision` (trigger), stamps the queued backlog with the
  destination being left, writes the `AUDIT_POLICY_UPDATED` row itself (URL as origin only) and
  queues it, and an anchor, for the right destinations. The web functions refuse a session bound to no
  lender (the application binds `app.tenant_id` in the transaction that calls them; the platform chain is
  not the web login's). A late-chained row made before a change
  is stamped too. The tenant binding in `audit_policy_save` and `audit_chain_status` (the session's
  `app.tenant_id` must match the lender; the actor must be one of its users) stops cross-tenant mistakes and
  buggy routes. It does NOT stop a compromised web process, which sets that setting itself: the backstop
  there is the `AUDIT_POLICY_UPDATED` row the function writes, which is queued for the OLD destination, so the
  bank's SOC sees every redirect of its own trail.
- **Outbox functions trust nothing.** `audit_outbox_mark` takes the tenant, accepts only
  delivery-attempt transitions on entries whose backoff has elapsed (a retry in the future, a
  give-up only after three attempts or when the audit row is gone), stamps `sentAt` with the
  database clock and writes an append-only receipt (`AuditSiemDelivery`) whose destination the
  database takes from the entry's own snapshot or the lender's policy, never from the caller. The ack id
  in it is the worker's own statement of what the SIEM said (required for HTTPS, none for syslog):
  reconcile receipts with the SIEM; it is not proof against a compromised worker. `audit_outbox_prune_unsent` refuses while the lender forwards, or when
  history says it did and the policy row is gone, and audits itself; `audit_outbox_purge_sent` has
  a fixed 7-day retention. Delivery runs under a lease (`audit_outbox_lease`), in short calls, with
  nothing held open while the SIEM is talked to. The SIEM sees seq + hash on every event and the
  daily signed checkpoint, so a suppressed event shows as a gap there.
- **SIEM.** A lender's `AuditPolicy` turns forwarding on; the chainer queues each chained row in
  `AuditSiemOutbox` and the `audit-siem-deliver` cron ships it as RFC 5424 syslog over TLS (CEF
  body) or an HTTPS JSON batch, in order, at least once, with backoff. What leaves is minimised
  (`lib/audit/siem/minimise.ts`). Only a SUPER_ADMIN (TOTP where required) changes the policy.
- **Retention is recorded policy, not enforced.** At least 12 months (a CHECK on `AuditPolicy`),
  the latest 3 "hot". Nothing deletes or archives audit rows (they are append-only); archiving
  up to a checkpoint is a follow-up.

| AuditLog | JSON | CEF | RFC 5424 |
|---|---|---|---|
| id | eventId | externalId | SD eventId |
| createdAt | timestamp | rt (ms) | TIMESTAMP |
| action | action | signature, name | MSGID |
| userId | actor.userId | suid | SD userId |
| ipAddress (value actions only) | sourceIp | src | SD ip |
| entity / entityId | entity / entityId | cs1 / cs2 | SD entity / entityId |
| link seq / rowHash | chain.seq / rowHash | cn1 / cs3 | SD seq / rowHash |
| oldValue / newValue (value actions only, masked) | oldValue / newValue | cs4 / cs5 (1000 chars) | in the CEF body |

Syslog PRI is facility 13 (log audit) * 8 + severity (CEF 9 = 2, 5 = 4, else 6).
The structured-data id is `cf@<AUDIT_SYSLOG_PEN>`; the default 32473 is the number
RFC 5612 reserves for documentation, so set the deployment's own.

## Row-level security: activation checklist

The policies (`prisma/migrations/20261014130000_tenant_rls`) are in every
database, but nothing enforces them yet. Every stack connects as a superuser,
which Postgres exempts from all policies, and the query hook that sets the
tenant (`lib/tenant-rls.ts`) is off unless `TENANT_RLS=on`. `/api/health`
warns an operator session while the role bypasses RLS.

**RLS is not a backstop yet.** It isolates nothing until the application
connects as a role RLS binds, `TENANT_RLS=on`, every entry point runs in a
tenant frame and the database sets `app.rls_strict = 'on'`. Before all four,
tenant isolation rests on `lib/tenant-scope.ts` alone. Turning RLS on is a
separate workstream (W0b); in this order:

1. **Two database roles.** A migrate role that owns the schema and runs
   `prisma migrate deploy`, and an application role that is neither
   superuser nor `BYPASSRLS`, with `SELECT, INSERT, UPDATE, DELETE` on the
   tables and `USAGE` on the sequences. FORCE binds an owner too, so the app
   role may own the tables, but must not be a superuser. It should NOT own
   them: the decision-log retention exception (`guardCreditDecisionRecord`,
   docs/learning-loop/DESIGN.md §2.7) lets only the table owner, inside
   `pseudonymiseCreditDecisionRecords()`, change a record, so an application
   role that owns the table could do so directly.
2. **Handle `P2002` without `meta.target`.** Under RLS, Postgres withholds the
   key of a unique violation on a covered table and Prisma reports
   "Unique constraint failed on the (not available)". Each site that reads
   the target must find the collided key another way (as
   `app/api/clients/route.ts` now does) or stop depending on it:
   `app/api/webhooks/whatsapp/route.ts`,
   `app/api/webhooks/whatsapp-cloud/route.ts`,
   `app/api/insurance/policies/route.ts`, `lib/insurance/quote/create.ts`,
   `lib/insurance/policy/bind.ts`, `lib/asset-finance/asset-input.ts`,
   `lib/inbox/resolve-thread.ts`. Error-message parsing of 23505 `DETAIL`
   (asset serial/VIN, supplier bank account) has the same problem.
3. **Scripts on a plain `PrismaClient`** run with no frame, so strict mode
   shows them nothing: `prisma/seed.ts`, `prisma/seed-staging.ts`,
   `scripts/lender/bootstrap-tenant-cli.ts`,
   `scripts/lender/bootstrap-admin-cli.ts`,
   `scripts/bureau-submission-seed-local.ts` and `scripts/demo/*` (the
   simulator's operator and read-only clients). Give each a bypass
   (`SET app.rls_bypass = 'on'` on its session) or a tenant frame.
4. **Frames on every entry point.** Most Server Component pages, some API
   routes and crons pass `where.tenantId` by hand with no
   `runWithTenant` frame; webhook handlers read before they know the tenant
   (the Stitch and WhatsApp webhooks look the payment or phone number up
   first). Each needs a frame, or an explicit `withoutTenantScope` for a
   cross-tenant lookup by an unguessable key.
5. **Frames inside an open transaction.** With the hook on, an interactive
   transaction is bound to one tenant, once: the tenant whose frame opened
   it, or, for one opened with no frame, the first tenant frame entered
   inside it. A query from another tenant's frame on it is refused
   (`RlsTransactionTenantError`, the transaction rolls back), never
   re-pointed: concurrent queries of two frames on one connection would read
   under each other's setting. The binding is not reverted when the inner
   frame exits; it only narrows. A transaction opened in `withoutTenantScope`
   stays in the system context. Batch transactions take the frame they were
   opened in. Before activation, find code that enters another tenant's frame
   inside a transaction and restructure it.
6. **Data migrations** run as the migrate role with no frame. With strict
   mode on (`ALTER DATABASE … SET app.rls_strict = 'on'`) a migration that
   reads or updates rows must `SET LOCAL app.rls_bypass = 'on'` first.
7. **Policies required before activation:** `TenantConfig` (credentials and
   lender identity), `User` (with a bypass for sign-in, which looks the user
   up before any tenant is known; `tenantId` is nullable for operator staff),
   `IntegrationConfig`, `EmailConfig` (mail credentials) and `AuditLog`
   (nullable tenant: decide who sees platform rows). The other tables the RLS
   migration's header lists follow.
8. **Batch transactions built across frames.** `$transaction([...])` takes
   the frame it is *called* in, not the frames its promises were created in.
   A batch called outside any frame from promises built inside tenant frames
   runs with no tenant setting, so its raw operations see every tenant
   (permissive) or nothing (strict). Before activation, either refuse a
   frame-less batch that contains a raw operation, or find and fix every
   such call site.
9. Run every integration suite as the application role (not a superuser),
   then set `TENANT_RLS=on` in the app, then strict mode.

## Migrations

`prisma/migrations/20261009000000_baseline` is the starting point: one
migration that creates the whole schema. Its first part is what Prisma
generates from the schema (`prisma/schema/`); its second, hand-written part holds every
trigger, function, CHECK constraint, partial or expression index, special
default and the statutory reference data (public holidays). The baseline was
produced by squashing an older migration history and proven equivalent by
comparing the catalogs of databases built both ways; it names no lender and
writes no tenant data.

Adding a migration:

- **Schema-only change** — edit the domain's file in `prisma/schema/`, run
  `npx prisma migrate dev --name <change>`, commit the generated SQL.
  `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema --shadow-database-url <url>`
  must then be empty.
- **Changing a hand-written object** — Prisma never diffs these, so write the
  SQL yourself (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER … ; CREATE
  TRIGGER …`, `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT …`). Update the
  static tests that read the SQL through `lib/db-baseline.test-helpers.ts` so
  they see the latest definition, and add or update an integration test that
  exercises the rule.
- **Adding enforcement** (trigger, CHECK, UNIQUE) is not backward compatible:
  it rejects writes the running code may still make. Ship it in the same
  release as the code that satisfies it. Additive nullable columns can go
  first.
- Never edit a migration once a shared database has applied it.

`prisma/migrations/20261009120000_neutral_tenant_palette` is an example of the
smallest kind: it only changes column defaults.

## Registries

A handful of lists change in nearly every feature PR. Each is assembled from
small entry files so two PRs that add entries touch different files and never
conflict, in git or in GitHub's mergeability check (which ignores local merge
drivers).

`scripts/gen-registries.ts` reads every `lib/registry/<kind>/*.ts` in path
order, refuses a duplicate (naming both files) or a malformed entry, and writes
`lib/registry/generated/<kind>.ts`. The generated files are **not committed**:
they are rebuilt by `npm ci` (postinstall), before `npm run dev`, `build`,
`test` and `typecheck`, by vitest's global setup (so `npx vitest run` sees a
new entry), by `scripts/ci-local.sh` and by the CI workflow; the Docker build
gets them through `npm run build`. After adding an entry while `next dev`
runs, restart it or run `npm run gen:registries`.

The modules the app imports re-export the merged values under their old names,
so no call site changed. `lib/registry/registries.test.ts` compares every value,
in order, with `lib/registry/__snapshots__/`, taken from the lists before they
were split; a merged PR that adds an entry adds it to the snapshot too.

Add an entry by creating a file named after your feature in the kind's folder
(existing files carry a numeric prefix so the merged order matched the old
lists; a new name sorts after them). Edit an existing domain file only to
change that domain's entries.

| Kind | Folder | Entry | Read through |
|---|---|---|---|
| Audit actions | `lib/registry/audit-actions/` | `defineAuditActions({ X_DONE: "X_DONE" })` — value equals name | `AuditAction` (`lib/audit.ts`) |
| Tenant-scoped models | `lib/registry/tenant-scoped-models/` | `defineTenantScopedModels(["Model"] as const)` — model needs a non-null `tenantId`, and RLS coverage (`lib/tenant-isolation.integration.test.ts`) | `TENANT_SCOPED_MODELS` (`lib/tenant-scope.ts`) |
| Cron jobs | `lib/registry/cron-jobs/` | `defineCronJobs([{ route, owner: "in-process", schedule, method?, freshnessMinutes }])`, or `owner: "external"`, or `owner: "unwired", reason` | `instrumentation.ts` schedules in-process jobs (SAST; `singleRun: true` claims the SAST day in `CronRunClaim` first, so one replica runs it, and fires it again +30 and +60 minutes later to run it over a FAILED or dead run only; `after: "<route>"` holds it until that single-run job is DONE or its final scheduled firing has passed with nothing running; the call is on loopback, `CRON_BASE_URL` overrides it); `CRON_FRESHNESS_MINUTES` (`lib/ops/cron-heartbeat.ts`); `instrumentation.cron-census.test.ts` requires every `app/api/cron/*` route to be declared once |
| Simulated integrations | `lib/registry/simulated-integrations/` | `defineSimulatedIntegrations({ key: { sandboxEnvVar, sandboxSafeValues } })` | `GuardedIntegration` (`lib/integrations/simulation-guard.ts`) |
| Permissions | `lib/registry/permissions/` | `definePermissions({ key: "ROLE" })` — a minimum role on the ladder (`ROLE_HIERARCHY`), a Prisma `UserRole`; or `key: ["ROLE", …]`, the exact roles that hold it, when a minimum would also grant a role that must not have it (a specialist role ranked above the roles it is kept from, e.g. `capture_payment` without INSURANCE_OFFICER). Prefer the minimum: a role added to the ladder inherits it, while a list names everyone by hand | `PERMISSIONS` (`lib/auth-guards.ts`), `canDo` (`lib/permissions.ts`) |
| Module rules | a `.claude.md` beside the module | a `<!-- summary: … -->` line under its title | `docs/module-rules.md` (generated); CLAUDE.md only points to it |

### The Prisma schema

`prisma/schema/` holds one `.prisma` file per domain (`prismaSchemaFolder`;
`package.json` `prisma.schema`); migrations stay in `prisma/migrations`. Put a
new model in its domain's file, or a new file for a new domain. Tests that
read the schema text use `readPrismaSchema()` (`prisma/schema-source.ts`).

The unavoidable shared lines are back-relations on Tenant, Client, Loan, User
and the like. In every model they form one alphabetical block, one field per
line (`prisma/schema-order.test.ts` fails with the expected order otherwise),
so two PRs adding different back-relations insert at different lines. Two that
sort next to each other still conflict, and `prisma format` re-aligns a whole
block when a new field name is longer than any in it; both are rare and
resolve trivially.

## Seeds

`npx prisma migrate reset` runs the migrations and then `prisma.seed`
(`npm run seed:staging`):

- `prisma/seed.ts` — one neutral demo tenant, **Acme**, with its lender
  identity, an ADMIN and a CREDIT_OFFICER (TOTP secrets generated per user),
  products, message and document templates, demo clients and one active loan
  booked through the real amortiser. Idempotent.
- `prisma/seed-staging.ts` — more demo records for exercising workflows
  (branches, insurers, CRM leads, a complaint, a DSAR).

The seeds create nothing the database guards with evidence (approved or
disbursed applications, sent notices, sold policies): those exist only by
driving the product flows. Credentials print with `SEED_PRINT_CREDENTIALS=1`;
the seed refuses `NODE_ENV=production`.

## Test layers

| Layer | Where | Runs | Sees the database? |
|---|---|---|---|
| Unit and mocked | `*.test.ts(x)` beside the code | `npm test` | No — Prisma is mocked |
| Static SQL | `lib/db-baseline*.test.ts` and suites using its helpers | `npm test` | Reads the migration SQL, does not execute it |
| Integration | `*.integration.test.ts`, gated by `RUN_*_IT` | `scripts/run-integration-tests.sh` against a throwaway Postgres | Yes |
| Contract / pinned | NCA render hashes, the forked-identity guard, palette contrast | `npm test` | — |

The integration script refuses a database that is not local or a
docker-compose service named `db` or `postgres`, and any URL whose query sets
`host=` (`ALLOW_REMOTE_TEST_DB=1` overrides), and
`scripts/integration-baseline.txt` records known-failing suites; CI fails if
it grows. Two guards keep the repository clean: the forked-identity guard
(`lib/website/__fixtures__/other-lender.ts`, used by
`lib/config/legacy-identity-boundary.test.ts` and the website, document and
message tests) matches a previous lender's identity by SHA-256 digest. The
digests are kept outside the repository (`$CREDAFLOW_OTHER_LENDER_DIGESTS`, else
`~/.config/credaflow/other-lender-digests.json`); without that file the guard
is off and its tests skip with a notice. And
`scripts/__tests__/palette-contrast.test.ts` rejects the old brand colours.
