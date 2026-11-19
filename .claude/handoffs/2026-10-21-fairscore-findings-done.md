# Fair Score acceptance findings: code DONE, deploy pending (2026-10-21 10:10 SAST)

Closes `2026-10-19-fairscore-acceptance-findings-goal.md` for code. The deploy is still open.

## Merged
- #213, #217, #218 and #219: dunning holds, consent, kill switches, debt review (2026-10-20).
- **#220** (621fd323): the nightly dunning chain is scheduled in-process for every ACTIVE tenant: dpd-update at 02:00, escalations at 07:00, reminders at 07:30, with retries 30 and 60 minutes later.
  - A CronRunClaim with a heartbeat and owner token stops two instances running the same job.
  - SendReservation sends each reminder once per day.
  - Database faults fail the tenant so it is retried; the courtesy cron is retired; pre-due emails get an email leg.
- **#227** (37f78dee): CI dates:check heap raised to 4 GiB. Main had been red since #220. Hein approved it because it changes a workflow file.
- **#224** (e5f99231): the legacy collections send path is retired; every reminder and the consumer `loan_overdue` notice go through `sendMessage`.
  - `lookupRecipientContact` (lib/contact/recipient.ts) refuses a Contact owned by another client. It is used by all 15 outbound callers, including S129, reprice, signing OTP and forgot-password.
  - The send window (07:00–20:00 SAST) is enforced per loan. Escalation defers the whole DEFAULTED rule outside the window.
  - Holds are rechecked before `loan_overdue`.
  - If two runs race on the same send, the second gets the existing row back instead of failing on the unique key (P2002).
  - The `due_reminder` event on /api/notifications/payment now returns 400.
  - The seed and the asset-finance seed now give every client a Contact.
  - Review: 4 rounds with blind reviewers plus a breaker, ending with all approving. The mutation table is posted on the PR.

## Deploy (Fair Score): another agent owns it (Hein, 2026-10-21); after 17:00 SAST, Hein approval
- Build a new image from main e5f99231 or later, then do a **full re-bake**. The re-bake is needed for three reasons:
  - #198 changed the i18n hashes.
  - #191 is included.
  - Seeded demo clients in the current snapshots have **no Contact**, so every reminder and notice to them would fail with "No Contact row".
- Check the sim lock and other sessions first. Never bake Tsela and Fair Score at the same time. bake.sh's tar step can flake; re-run it if so.
- The `loan_overdue` email now needs the lender's own email provider (Settings > Email); there is no SMTP_* env fallback. Check the Fair Score tenant has one, or its overdue emails will fail and be counted.
- Tenants on legacy BulkSMS WhatsApp now need approved WABA templates.

## Open (not fixed)
- `lib/dealer/capture.ts` creates clients with no Contact (they get no messages until staff verify their details).
- `paymentDueReminderEmail` is orphaned; its customer copy was left in place.
- `escalation.ts` is 336 lines; `reminders.ts` is about 940.
- In a narrow race, the report can label a replayed QUEUED row "Retry scheduled". This affects the report only.
- A definite rejection is not released the same day. An idempotency conflict is reported as a generic failure.
- A flaky IT test: `templates-issuance.integration.test.ts:218`, an asset-finance publication race that hit the other refusal message.
- Legal/product items Hein still has to decide:
  - application_declined vs opt-out;
  - S129 to a deceased borrower;
  - the CRM WhatsApp button under holds;
  - rows 100, 105 and 108 still gated.
