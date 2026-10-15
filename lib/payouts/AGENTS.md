<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: payouts
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Provider payouts of consumer disbursements behind
`TenantConfig.payoutsEngineEnabled` (default off). Off = the disburse route is
unchanged: it records the disbursement and calls no provider.

## Critical Rules
- **Never pay twice.** The `DisbursementPayout` row is created inside the
  disburse transaction, unique per application (`disburse:<applicationId>`,
  CHECK-bound). It is claimed `PENDING -> SUBMITTING` (committed, audited)
  BEFORE the provider is called (`lib/payouts/dispatch.ts`).
- **Unknown outcome = NEEDS_REVIEW.** Never auto-retried. Only a payout that
  was never claimed (`PENDING`) can be sent again; staff confirm paid/failed
  with a note (`lib/payouts/resolve.ts`, `POST /api/payouts/[id]`).
- **AVS is required when the flag is on**, whatever `collectionsEngineEnabled`
  says: a passing, application-bound check of the payout account, not
  simulated on a deployed build, before the payout row exists
  (`lib/payouts/avs.ts`). Refusal: 422 `payout_avs`, audited.
- **Remedies are maker-checker (DB-enforced).** A FAILED/RETURNED payout is
  retried as a new attempt (`disburse:<app>:<n>`, one open attempt per
  application) needing a fresh AVS and a second LOAN_ADMIN's approval
  (`lib/payouts/retry.ts`); or the disbursement is reversed and the loan
  CANCELLED (`lib/payouts/reversal.ts`). Staff confirmations and every
  decision exclude the disburser and the requester.
- **Nothing is sent while the flag is off** or on a loan not ACTIVE/DEFAULTED,
  and a simulate-only provider is refused where the simulation guard forbids it.
- **Lock order**: Loan row FOR UPDATE first (`lib/payouts/loan-lock.ts`) in
  every retry/reversal write; the DB refuses an attempt beside an open reversal.
- **Provider conflicts** (money reported moving on a FAILED/CANCELLED attempt)
  are recorded, never applied; they block retry and reversal until a second
  person resolves them (`lib/payouts/conflicts.ts`). A reversal asks the rail
  first where it can (`lib/payouts/reversal-rail.ts`).
- **The loan is booked at disburse, as before.** The payout is tracked beside
  it; it does not gate the DISBURSED status (reasons in
  `lib/payouts/disbursement.ts`).
- **The state machine is DB-enforced** (`guardDisbursementPayout`, latest in
  the 20261015190000 migration); `lib/payouts/state.ts` mirrors it.
- **Adapters translate, nothing more.** Netcash wraps `disburseFunds`; only its
  not-configured answer is "definitely not sent". Capitec Pay, PayShap and
  cash voucher are typed NOT_IMPLEMENTED slots: do not invent wire formats.
- **Webhooks must verify** in `parseWebhook` (signed, timestamped).

## Key Files
| File | Purpose |
|------|---------|
| `lib/payouts/dispatch.ts` | Claim, call, record |
| `lib/payouts/resolve.ts` | Webhook/status ingestion, staff actions |
| `lib/payouts/providers/` | netcash, simulated, not-implemented slots |
