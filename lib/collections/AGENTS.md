<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: collections
<!-- summary: escalation, arrangements, Section 129 -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Drives the arrears lifecycle: reminders before due, escalation through NCA
collection stages (`NONE` → `SOFT_REMINDER` → `FORMAL_REMINDER` →
`SECTION_129_SENT` → `PAYMENT_ARRANGEMENT` → `ATTORNEY_REFERRED` →
`WRITTEN_OFF`, per `CollectionsStage` in `prisma/schema/collections.prisma`),
promise-to-pay tracking, and arrangement monitoring.

## Critical Rules
- **`EscalationRule.minDays` (a local TS interface in `escalation.ts`, not a
  Prisma model) gates that cron's own DPD-based actions** (soft-reminder
  note, auto Section 129 at 20 days, DEFAULTED status flip at 60 days, legal
  flag at 90) — separate from, and does not touch, `Loan.collectionsStage`.
  `collectionsStage` is staff-advanced via `CollectionsStagePanel`, which is
  hard-gated server-side (a direct PATCH to `SECTION_129_SENT` is rejected;
  the stage must follow the real S129 issuance).
- **The nightly chain is `dpd-update` (02:00) → `escalations` (07:00) →
  `reminders` (07:30): in-process, each over EVERY ACTIVE tenant in its own frame**
  (`lib/ops/tenant-sweep.ts`; never `tenant.findFirst`). `escalations` and
  `reminders` send borrower comms, so they run on one replica a day, never before
  07:00 SAST, and are fired again 30 and 60 minutes later; `dpd-update` sends
  nothing, is idempotent and runs on every replica. Times, order and the
  `after: "escalations"` gate: `lib/registry/cron-jobs/091-dunning.ts`, pinned by
  `dunning-schedule.test.ts`. The old 3-day `payment-reminders` courtesy cron is
  retired. Escalations and reminders first make sure DPD is current for the tenant
  (`ensureDpdCurrent`) and run it if not. The 60-DPD "defaulted" notice goes only to
  a loan at 60-66 DPD; an older one is flipped and noted without it.
  A single-run claim has an owner token and a one-minute heartbeat; a later firing
  takes over only a FAILED claim or one whose heartbeat is 5 minutes stale. The
  scheduler calls this server on loopback with no timeout but a 55 minute ceiling
  (`lib/ops/cron-call.ts`, `CRON_BASE_URL`), never the public origin and its proxy.
  A run is FAILED, and retried, when a tenant threw: the route says how many in the
  `x-cron-failed-tenants` header, and a 2xx without it fails closed. A per-item error
  (a send that failed, a reconciliation case) is in the body, leaves the claim DONE
  and the status 200, and waits for tomorrow. Because a takeover can still overlap a
  runner that only lost its heartbeat, each reminder leg is reserved by
  `sendMessage`'s idempotency key (`collections:<loan>:<trigger>:<channel>:<SAST day>`,
  a Message row committed before the provider call; an ambiguous outcome keeps it and
  is held for reconciliation), and `loan_overdue` and every escalation rule first take
  `reserveOnce(tenantId, key, at)` (`lib/ops/send-reservation.ts`), unique per loan,
  message and SAST day, released, against the day it was taken, only when the send
  threw. One loan's throw is that loan's error, not the
  tenant's day, unless it is a database fault (`lib/ops/db-fault.ts`) or every loan
  failed: then the tenant fails and is retried. /api/health reads the status, which is 503 only when
  EVERY tenant failed, so a failing tenant among several shows in the log, the body
  and the claim (FAILED), not on health. The retry sweep sends ALL dunning only
  07:00-20:00 SAST; only an automated date-worded reminder (`collections:`,
  `entity-notice:<reminder>`) expires at the end of its creation day: a staff
  reminder and a 60-DPD notice (consumer or entity `loan_overdue`) wait, and
  expire once the next day's window is over. A queued reminder is also dropped when
  the borrower has since paid (`nothingOwed`, one definition shared with the
  reminders cron: `amount-owed.ts`); a PRE-DUE one (7d, 1d, 0d) is also dropped
  once `nextPaymentDate` is no longer the day it was queued for plus its offset,
  which is the cron's own trigger match (`reminder-offsets.ts`; it matters when
  that instalment is paid and the next is unpaid, so something is still owed). The
  60-DPD flip is conditional (still ACTIVE/DEFAULTED, 60+ DPD, in arrears): a loan
  it finds settled gets no later escalation rule (no 90-DPD flag) either, and the
  notice is re-checked against the statuses a notice reaches just before it sends.
- **The pre-due reminders (7d, 1d, 0d) email as well as SMS/WhatsApp, always
  through `sendMessage`** (template `payment_reminder_email`; entities via
  `entity_reminder_email`), so consent, holds, kill switches and `Message.dunning`
  apply. Each reminders run first seeds the tenant's missing default templates
  (`seedDefaultMessageTemplates`, idempotent), so a tenant that predates a row
  gets it. If the template or the tenant's email provider is still unusable the
  email leg is skipped for the run: one log line and `warnings++`, not an error.
  Report bodies are generic ("failed; see the server log"); the cause is logged.
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
  and WhatsApp only: `lib/asset-finance/entity-reminders.ts` from the
  reminders cron, `triggerNotification` for `loan_overdue` /
  `payment_received`. Section 129 addresses the registered entity and sends
  to an active authorised contact. Client-only manual reminder and queue rows
  remain explicitly skipped.
- **Promise-to-pay records are `LoanNote` rows, not a separate table.** They're
  created inline (type `"promise_to_pay"`) in
  `components/collections/LogContactButton.tsx`. `promiseToPay.ts` only reads
  them back — don't add a write path there.
- **Dunning holds: one rule per path, all in `dunning-holds.ts` / `client-holds.ts`.**
  - *Automated reminders* (the `reminders` cron) select
    through `remindableLoanWhere()`: ACTIVE, stage not ATTORNEY_REFERRED /
    WRITTEN_OFF, no ACTIVE `PaymentArrangement`, no active `PaymentPlan`, client
    not deceased, and no debt-review notice on this loan or ANY loan of the
    client (consumer-wide). PAYMENT_ARRANGEMENT is not a hold by itself: the
    stage never moves back, the ACTIVE arrangement decides. A new reminder path
    uses it; never re-write the filter.
  - The reminders cron rechecks `isLoanRemindable` (ACTIVE and not held) immediately before EACH send (the loans are
    selected once at the start of a run, which can be long), and so do the staff
    routes before each leg. The messaging retry sweep suppresses (not retries) a
    queued DUNNING message (`Message.dunning`, set by `sendMessage` from its
    `category`, `lib/messaging/dunning-category.ts`: add any new reminder
    category there) whose Contact's client has since died or gone under debt
    review (`contactDunningHold`; status SUPPRESSED_BY_CONSENT, the text says
    "client hold: deceased|debt review"). Statements, receipts and transactional
    messages are not held.
  - *Escalation* still flips DEFAULTED at 60 DPD, but skips the borrower's
    `loan_overdue` notice for a held or no longer dunnable loan (`loanDunningHold`) and reports it; it writes
    no 90-DPD `escalation_legal` flag, and the "S129 Due" count leaves the client out,
    while debt review stands.
  - *Staff messages* (manual reminder, collections-stage WhatsApp) refuse with
    409 and the reason for a deceased client or a debt-review notice
    (`staffMessageRefusal`). Arrangement and attorney-referred loans stay open.
  - *Section 129* is blocked while a debt-review notice is on any loan of the
    client: single and bulk routes, the automation `ISSUE_SECTION_129` task and
    the dispatch-time recheck (`section129DebtReviewReason`).
  - Complaints do not hold dunning (decided 2026-10-19). The notice is set and
    cleared only by `app/api/loans/[id]/debt-review` (audited). Recording a
    death also BLOCKs the client's Contact (`lib/clients/deceased-contacts.ts`).
- **Every reminder goes through `sendMessage`; there is no direct-provider
  leg.** The reminders cron has no flag-off path (`MESSAGING_NEW_SEND_COLLECTIONS`
  is retired): template rows, the consent/block gate, the WhatsApp kill switches,
  the holds and `Message.dunning` all apply. A direct BulkSMS leg once sent with
  no opt-out check. A channel that is off (SMS by policy; WhatsApp by `WA_ENABLED`
  or the tenant switch) is skipped per leg BEFORE `sendMessage`: no template
  lookup, no Message row, no error (the transport kill switch stays the
  backstop). A missing template of an ENABLED channel skips that leg for the
  tenant with one counted warning (`warnings`), never an abort; an unreadable
  WhatsApp settings row fails the tenant (retried), it is not "off". Proof on a real database:
  `reminders.consent.integration.test.ts`, `reminders.identity.integration.test.ts`.
- **A leg goes only to the recipient's OWN Contact** (`lookupRecipientContact`,
  `lib/contact/recipient.ts`; rule in `lib/messaging/AGENTS.md`). The reminders cron,
  entity dispatch and notification dispatch count a refused leg and never name the
  value in a report.
- **`loan_overdue` always goes through `sendMessage`** (`MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE`
  is retired). `lib/collections/overdue-notice.ts` fires it once per loan per trigger
  per SAST day under a `SendReservation`, also when the trigger was already reminded
  today, and rechecks the holds immediately before it. `triggerNotification` returns
  the legs that failed; a throw or a failed leg is counted in `errors` and gives the
  reservation back, so ANOTHER run the same SAST day (manual, or the scheduler's retry
  of a failed tenant) tries again; a run that closes DONE is not retried, so otherwise
  the failure is only counted (each leg's idempotency key stops a resend). Escalation's
  60-DPD notice counts them the same way.
- **No dunning outside 07:00-20:00 SAST** (`lib/collections/send-window.ts`): the
  reminders run refuses to start (200, `skipped`, the claim closes DONE) and, checked per
  loan, stops when the window closes mid-run (the rest `deferred`, not errors). An
  escalation rule that messages the borrower (`sendsNotice`: the 60-DPD DEFAULTED flip and
  its notice) is not applied at all outside it, no flip, no note, no reservation, so the
  07:00 run applies it whole; `DEFAULT_NOTICE_MAX_DPD` (66) leaves room for that.
- **Notifications go through `lib/notifications`** — never call SMS/email
  providers directly from this module; you'd bypass channel preferences,
  quiet-hours, and the audit trail.

## Key Files
| File | Purpose |
|------|---------|
| `lib/collections/escalation.ts` | Cron-driven `processEscalations()` (plural) — DPD-5/20 `LoanNote` + notification |
| `lib/collections/reminders.ts` | `processPaymentReminders()` — pre/post-due reminder dispatch |
| `lib/collections/overdue-notice.ts` | `fireOverdueNotice()` — the reminders cron's `loan_overdue`, reserved, failures counted |
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
