<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: collections
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Drives the arrears lifecycle: reminders before due, escalation through NCA
collection stages (`NONE` → `SOFT_REMINDER` → `FORMAL_REMINDER` →
`SECTION_129_SENT` → `PAYMENT_ARRANGEMENT` → `ATTORNEY_REFERRED` →
`WRITTEN_OFF`, per `CollectionsStage` in `prisma/schema.prisma`),
promise-to-pay tracking, and arrangement monitoring.

## Critical Rules
- **`EscalationRule.minDays` (a local TS interface in `escalation.ts`, not a
  Prisma model) gates that cron's own DPD-based actions** (soft-reminder
  note, auto Section 129 at 20 days, DEFAULTED status flip at 60 days, legal
  flag at 90) — separate from, and does not touch, `Loan.collectionsStage`.
  `collectionsStage` is staff-advanced via `CollectionsStagePanel`, which is
  hard-gated server-side (a direct PATCH to `SECTION_129_SENT` is rejected;
  the stage must follow the real S129 issuance).
- **Section 129 issuance triggers a real legal letter.** When an escalation
  marks `SECTION_129_SENT`, a Section 129 PDF MUST be generated via `lib/pdf/section129.ts`
  and the audit log MUST record dispatch. Don't flip the status without
  the document actually going out.
- **`Loan.ncaRegime` decides the NCA remedies; the borrower type only decides
  who is messaged.** Section 129 (the single and bulk sends, escalation's
  legal step, the S129-due count) keys on `ncaRegime` through
  `evaluateCollectionsEligibility`: a NON_NCA agreement is never eligible. An
  entity borrower (`clientId` null) is reminded and notified through its
  directors, trustees and authorised signatories (never sureties), by email
  and WhatsApp only: `lib/asset-finance/entity-reminders.ts` from both
  reminder crons, `triggerNotification` for `loan_overdue` /
  `payment_received`. It is skipped only where a step needs a `Client` (the
  manual reminder route, the queue rows, the s129 notice); the skip's
  comment says which.
- **Promise-to-pay records are `LoanNote` rows, not a separate table.** They're
  created inline (type `"promise_to_pay"`) in
  `components/collections/LogContactButton.tsx`. `promiseToPay.ts` only reads
  them back — don't add a write path there.
- **Notifications go through `lib/notifications`** — never call SMS/email
  providers directly from this module; you'd bypass channel preferences,
  quiet-hours, and the audit trail.

## Key Files
| File | Purpose |
|------|---------|
| `lib/collections/escalation.ts` | Cron-driven `processEscalations()` (plural) — DPD-5/20 `LoanNote` + notification |
| `lib/collections/reminders.ts` | `processPaymentReminders()` — pre/post-due reminder dispatch |
| `lib/collections/promiseToPay.ts` | `getPromiseToPayStatus()` — read-only P2P status from `LoanNote` |
| `lib/collections/arrangement-tracker.ts` | Arrangement monitoring + breach detection |

## Database Tables (via Prisma)
- `Loan.collectionsStage` — enum `CollectionsStage` on the loan record
- `PaymentArrangement` — active arrangements + status
- `AttorneyReferral` — handover record once `ATTORNEY_REFERRED`

## Dependencies
- **External:** none directly
- **Internal:** `@/lib/prisma`, `@/lib/notifications`, `@/lib/pdf`, `@/lib/audit`

## Common Tasks
| Task | Pattern |
|------|---------|
| Run nightly escalation | `processEscalations()` (called from `app/api/cron/*`) |
| Run reminder dispatch | `processPaymentReminders()` (called from `app/api/cron/*`) |
| Read P2P status | `getPromiseToPayStatus(loanId, tenantId)` |
| Record a P2P | inline `LoanNote` write in `LogContactButton.tsx`, not a helper |

---
<!-- Refresh via /kb when files change. -->
