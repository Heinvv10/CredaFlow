# Part T browser acceptance: results (2026-10-22, after review round 1)

All on a local dev server against a throwaway PostgreSQL 16 migrated to the
branch head, synthetic data.

| # | Check | Result |
|---|---|---|
| 01 | Loan in good standing, no report: position refused, theft form offered | Pass |
| 02 | Theft report CAS 417/10/2026 (reported 20 Oct) recorded, "Waiting for a second person to confirm"; position API 409; the recorder's own confirm 409 "A second person confirms…" | Pass |
| 03 | Confirmed by the credit officer; position shown; trail of 10 points from 13 Oct (20 Oct less 7 days); access rows LATEST and TRAIL (count 10), each naming the report | Pass |
| 04 | Report expired (day 31): only "Renew" offered; trail API 409 | Pass |
| 05 | READONLY: no theft or position controls; trail, record and confirm APIs 403 | Pass |
| 06 | Wrong TELEMATICS reading 51 060 h: projected excess R1,918,726,600.00 | Pass |
| 07 | Void asked by the credit officer; their own approval refused | Pass |
| 08 | Loan admin approves: reading struck through "Voided 22 Oct 2026"; projected excess R726,600.00 | Pass |
| 09 | Settled by payment (R1,567,493.32): loan COMPLETED, one closure; cron `{"closures":0,"held":1}`; staff task "Held: nothing is told to the borrower until the lender approves the asset-finance wording"; nothing sent | Pass |
| 10 | After approval: cron run 1 `{"closures":1}`, run 2 `{"tenants":0}`; staff task shows portal notice, "Email sent", letter | Pass |
| 11 | Letter: the reviewed wording, no DRAFT watermark | Pass |
| — | Email: one Message (SENT) to the director, captured on the local SMTP server: "The agreement … between TEST Earthmoving (Pty) Ltd and TEST Asset Credit (Pty) Ltd ended on 22 October 2026 …", retention 90 days; nothing sent outside the machine | Pass |
| 12 | Portal (director): the notice on the business contract, same words | Pass |
| 13 | Portal: the voided reading, struck through, with "Why: …" | Pass |
| 14 | Device removed on the asset: "Device removed" | Pass |

Page errors: none. The console shows only the refusals the steps provoke
(409 position before confirmation, 409 self-confirmation, 409 self-approval,
403 READONLY, 409 after expiry, 400 from a form value the harness failed to type).
