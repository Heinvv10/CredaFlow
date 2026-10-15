<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: operator
<!-- summary: operator console; borrower rows only through a grant -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
The platform operator above the lenders: operator staff, lender-granted
support access (W0) and the operator console (W1: `app/(operator)`,
`app/api/operator`). Architecture: `docs/ARCHITECTURE.md` → Operators,
Operator console.

## Critical Rules
- **Operator code never reads a borrower row except through a grant.** Lender
  pages and usage are `count`/`groupBy`/`aggregate` only
  (`lib/operator/console/lenders.ts`, `lib/operator/console/usage.ts`). The one
  place borrower rows are read is `lib/operator/console/support-view.ts`, and
  only after `resolveOperatorTenantAccess` allowed and audited the use.
- **Every console page, layout and route is in the census**
  (`lib/operator/console-census.test.ts`), which runs it against sentinel
  borrower rows. A new file fails the census until it is listed with its kind.
  "Borrower data" there is default-deny: every model not in `PLATFORM_MODELS`.
- **The console lives on `OPERATOR_APP_HOST` only** (`lib/proxy/operator-host.ts`):
  nothing else is served there and no other host serves it or accepts an
  operator session. Writes there are the console's own management APIs; the
  grant-gated support paths stay GET/HEAD, and there are no server actions.
  Every write there must be same-origin (Origin / Sec-Fetch-Site) and every
  `/api/operator` write `application/json`: send JSON from console UI.
- **Tenant.domain goes through `lib/config/tenant-domain.ts`** (normalised; never
  a deployment host or another lender's subdomain host): it outranks the slug
  in host resolution, so a bad one takes over a host. **Known limit:** the
  checks are check-then-write, not locked; two lenders created or re-domained
  at once can each pass against the other (the unique index still stops two
  identical domains). Serialise tenant/domain writes before automating them.
- **Sign-in and every request apply one rule set** (`lib/auth-principal.ts`:
  active, binding, suspended lender, TOTP state, enrolment hold). Add a rule
  there, never to one path only; `lib/__tests__/auth-principal-parity.test.ts`
  runs each rule on both.
- **Operator 2FA is mandatory.** `lib/operator/console-auth.ts` accepts only a
  session whose sign-in verified a code; no lender's `requireStaffTotp` applies.
- **Scope every lender by the caller's operator** (`operatorTenant`, or
  `operatorId` in the `where`): another operator's lender is "not found".
- **Never show or return a password, token or reset link.** Invites and resets
  are one-time links emailed to the account (`lib/operator/console/account-links.ts`);
  audit rows record the target and expiry only.
- **TenantConfig holds sealed provider credentials:** select the columns you
  need, never `config: true`.
- Audit lender actions under the lender's `tenantId` (its own audit log shows
  them); operator-user actions carry no tenant.
