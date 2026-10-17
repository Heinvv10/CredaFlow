# Commercial instalment sale and surety acceptance

2026-10-17, synthetic fixtures only, isolated PostgreSQL 16 and localhost:3397.
No lender legal-approval flag was enabled. Staff signed in with a password and
a freshly generated TOTP; the portal used the synthetic surety's password.

- `commercial-spouse-consent-payout-refused.png`: every ordinary payout
  checklist item is confirmed; the surety is IN_COMMUNITY and has no spouse
  consent scan. Clicking Create payout returned HTTP 409. The page shows the
  recorded regime, consent form and refusal.
- `commercial-suretyship-wet-ink-only.png`: the real surety's portal page
  explains that the deed requires wet ink and provides no electronic signing
  control. A browser-session POST to the real signature endpoint returned 409,
  whose response is in `commercial-portal-refusal.json`.

Reproduce the fixture with `RUN_ASSET_FINANCE_COMMERCIAL_BROWSER_IT=1
COMMERCIAL_BROWSER_SEED=1 npx vitest run
lib/asset-finance/commercial-browser.integration.test.ts` against a disposable,
fully migrated database. This writes local-only credentials to
`/tmp/cf-commercial-browser.json`; start a local app for that tenant slug and
use the credentials for the two browser sessions. Default test runs clean up
the fixture and never retain credentials.

Database proofs: `payout-booking.integration.test.ts` refuses an absent or
UNKNOWN regime and an IN_COMMUNITY surety without consent, then accepts a
staff-verified wet-ink legal document naming the spouse and two distinct
witnesses. Removing the payout trigger admits the same previously refused
insert inside a rolled-back mutation test. Evidence cannot be changed after
verification. `deal-signing.integration.test.ts` attacks the electronic
signature through both the route and direct database writes.

Actual cancellation acceptance (2026-10-17): a synthetic booked agreement was
opened in the staff loan page after password and TOTP authentication. The
cancellation form required the actual date, a staff legal document, reasons,
and an explicit attestation before submission. The route returned 201 and
the page displayed the permanent cancellation date and evidence.
`commercial-cancellation-evidence-required.png` captures the form before the
attestation; `commercial-cancellation-recorded.png` captures the recorded event.
The local browser log is `/tmp/cf-commercial-event-browser3.log`. Reproduce the
fixture with the browser integration suite's `booked agreement` test; its
synthetic credentials remain outside the repository.

The actual booked-agreement PostgreSQL regression independently calculates
interest earned by 1 January, records that actual cancellation, and completes
a later 1 March sale. Partial proceeds, later quotes, an ordinary receipt and
its reversal preserve the fixed debt. A mutation replacing the cancellation
cutoff with maturity fails this independent interest oracle. The separate
sale-completion database guard also refuses a direct completion without the
actual cancellation event. These focused proofs do not replace the final full
CI gate.
