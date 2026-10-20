<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: messaging
<!-- summary: the send pipeline; SMS is OFF by policy -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
The outbound send pipeline: `sendMessage()` is the single entry point for
every customer-facing channel (Message row + Conversation thread + consent
gate + audit trail), with provider routing underneath it.

## Critical Rules
- **SMS IS OFF BY POLICY. Do not add an SMS leg.** The channel is on ONLY when
  `BULKSMS_DRY_RUN` is exactly `"false"`; unset, `"true"` or anything else is
  off (fails closed). Otherwise an SMS send can only land as `SIMULATED` —
  a record that reads like the borrower was contacted when nothing was sent.
  Reversing the policy is an env change, not a code change. Tests get the
  opt-in from `vitest.setup.ts`; a test of the default deletes the variable.
- **`isSmsChannelEnabled()` in `lib/messaging/sms-channel.ts` is the ONE wire.**
  Every surface asks it: `channel-availability.ts` (inbox composer),
  `lib/collections/reminders.ts`, `lib/notifications.ts`, the manual
  collections reminder, and the PASQ/agreement/selfie send-link routes.
  Never re-test `process.env.BULKSMS_DRY_RUN` yourself — two copies of a
  condition are two things that drift.
- **It is deliberately NOT `isDryRun()` from `lib/integrations/bulksms.ts`**,
  which also treats `NODE_ENV=test` as dry-run. Folding that arm in would
  switch the channel off for the entire test suite and make the guards
  untestable in the "channel on" direction.
- **`sendSms()` refuses at the transport when the channel is off.** That is
  the control; the per-callsite skips exist on top of it so each run reports
  honest per-leg accounting. Keep both — a documented invariant is not a
  control, and a callsite added later would bypass the skips.
- **WhatsApp switches, one parser, fail-closed** (`lib/whatsapp/env-switch.ts`,
  `kill-switch.ts`): `WA_ENABLED` unset or `true` (trimmed, any case) defers to
  `CommsSettings.whatsappEnabled` (Cloud-only deployments never set it); EVERY
  other value, empty and typos included, is OFF; false there is OFF.
  Non-production stacks pin `WA_ENABLED: "false"` in their compose files. Checked in
  `providers.ts` dispatch, `sendWhatsAppForTenant`, and as transport backstops
  in `sendWhatsAppCloudMessage` and BulkSMS `sendWhatsApp`, always before the
  dry-run branch and credentials. Refusals are DEFINITELY_REJECTED and say
  "WhatsApp disabled" (retry.ts: PERMANENT); an unreadable settings row also
  refuses but with different wording (TRANSIENT; only sendMessage retries) and
  no exception text. The
  bridge also needs `WA_SENDER_URL`. OTP pickers use the same switch.
- **The Contact a send resolves must be the recipient's own.** `lookupContactByChannelValue`
  finds whoever holds the number or address; a caller that sends to a client refuses
  a Contact whose `clientId` is someone else's (`CONTACT_NOT_CLIENTS` in
  `lib/notifications.ts`), because `sendMessage` checks the consent of the Contact
  it is given. Dunning email carries no List-Unsubscribe (it only revokes marketing).
- **A skipped leg must be VISIBLE and must not be an error.** Blocked/skipped
  accounting, never a silent drop, never an aborted cron.
- **Never write a note or log line claiming a channel carried a message it
  did not.** If a trigger's only channel was SMS, write no note at all.
- **A staff UI must not offer a channel the route will refuse.** Client
  components cannot read the env var — resolve `isSmsChannelEnabled()` on the
  server page and pass it down (see `components/applications/SelfieLinkSection.tsx`).

## Key Files
| File | Purpose |
|------|---------|
| `lib/messaging/sms-channel.ts` | `isSmsChannelEnabled()` + `SMS_CHANNEL_OFF_REASON` — the single wire |
| `lib/messaging/send.ts` | `sendMessage()` — the one outbound entry point |
| `lib/messaging/providers.ts` | Channel → provider dispatch |
| `lib/messaging/channel-availability.ts` | Per-contact per-channel "can we message here, and why not" |
| `lib/asset-finance/reprice-notice-dispatch.ts` | Committed rate notices: email, idempotent, outcomes audited; only NCA uses statutory override |
| `lib/messaging/retry.ts` | Retry sweep; classifies a channel-off error as PERMANENT. ALL dunning (`Message.dunning`: automated reminders, staff reminders, 60-DPD notices) retries only 07:00-20:00 SAST, judged at the moment of each send; outside it the row is rescheduled to the next 07:00 (`dunning-window.ts`), so it does not head every batch. Only an automated date-worded REMINDER (`collections:`, `entity-notice:<reminder>`) EXPIRES at the end of its creation day; staff reminders and `loan_overdue` notices (consumer and entity) wait and expire once the NEXT day's window is over (20:00 SAST), so they get one in-window chance. The sweep's blanket 24 hour expiry is for non-dunning only. Automated dunning also stops for a loan that is no longer dunnable or is on a hold, and an automated REMINDER (not a notice) for a loan nothing is owed on any more, or (pre-due 7d/1d/0d) whose instalment was paid so `nextPaymentDate` moved on (`automatedDunningLoan`, `loanDunningHold`, `lib/collections/amount-owed.ts`, `lib/collections/reminder-offsets.ts`). Email is never auto-retried |

## Dependencies
- **External:** BulkSMS, Resend/MS Graph/SMTP, WhatsApp Cloud
- **Internal:** `@/lib/prisma`, `@/lib/audit`, `@/lib/contact/identity`

---
<!-- Hand-written 2026-09-23 when the SMS channel was switched off. Refresh via /kb. -->
