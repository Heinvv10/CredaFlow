# Part T browser acceptance: results (2026-10-22)

All on a local dev server against a throwaway PostgreSQL 16, synthetic data.

| # | Check | Result |
|---|---|---|
| 01 | Loan in good standing, no report: position refused, theft form offered | Pass |
| 02 | Theft report CAS 417/10/2026 recorded, valid until 21 Nov 2026 (30 days) | Pass |
| 03 | Last known position shown; trail of 8 points from 15 Oct (report 22 Oct less 7 days); two access rows written (LATEST, TRAIL with count 8), each naming the report | Pass |
| 04 | Report expired (day 31): only "Renew" offered; trail API 409 "Position is shown only for…" | Pass |
| 05 | READONLY: no theft or position controls; trail and theft-report APIs 403 | Pass |
| 06 | Wrong TELEMATICS reading 51 060 h: projected excess R1,918,726,600.00 | Pass |
| 07 | Void asked by the credit officer; their own approval refused "A second person decides a void" | Pass |
| 08 | Loan admin approves: reading struck through "Voided 22 Oct 2026"; projected excess R726,600.00, used so far 54 h | Pass |
| 09 | Settled by payment (R1,567,493.32): loan COMPLETED; one TrackerClosure; cron run 1 `{"closures":1,"failed":0}`, run 2 `{"closures":0}`; staff task shows portal notice, "Email sent", letter | Pass |
| 10 | Letter: application/pdf, 2 314 bytes, DRAFT watermark (the lender has not approved the wording) | Pass |
| 11 | Portal (director): "Tracking has stopped" notice on the business contract; one NotificationLog row | Pass |
| — | Email: one Message (SENT, EMAIL) to the director, captured on the local SMTP server ("Tracking has stopped: LN-…"); nothing sent outside the machine | Pass |
| 12 | Device removed on the asset: the closure shows "Device removed", `removedById` the loan admin | Pass |

Page errors: none. The console shows only the refusals the steps provoke (403,
409, and one 400 from a void reason the test harness failed to type).

Found and fixed during this run:

- The closure cron listed pending closures across tenants with a plain query,
  which the tenant-scope extension refuses ("missing-context"): every run
  answered 500. It now lists asset-finance lenders from `TenantConfig`, as the
  poll and purge crons do (route test updated).
- The notice was missing from the portal's business contract page (an entity
  borrower's view); added beside the recovery card.
