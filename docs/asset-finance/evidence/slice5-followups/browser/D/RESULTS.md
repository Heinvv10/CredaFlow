# Part D browser acceptance: results (2026-10-22)

Run against the PR branch on a local `next dev`, a throwaway PostgreSQL 16
(`cf-it-s5fd-browser`), Chrome via DevTools. Every page loaded with 0 console
errors, except one noted under "Found and fixed".

| Step | Expected | Seen | Screenshot |
|---|---|---|---|
| Remote consent | method radio, identity field, attestation recorded | "Consent attested"; nothing outstanding | `01-dealer-remote-consent-form.png`, `02-dealer-consent-attested.png` |
| Staff sees the method | REMOTE and the identity check on the staff panel | "signed remotely; identity checked by: Video call with the original ID document held to the camera, matched to the person" | `06-staff-sees-remote-method.png` |
| Dealer cancels own draft | CANCELLED with the reason | status CANCELLED; staff panel "Cancelled by the dealer (TEST Dealer User) … “The buyer chose another machine”" | `03-dealer-cancel-form.png`, `04-dealer-draft-cancelled.png`, `07-staff-sees-dealer-cancellation.png` |
| Second dealer | 404 | page "Not found"; `POST …/cancel` → `404 {"error":"Deal not found"}`; B's deal list empty | `05-other-dealer-404.png` |
| Purge cron | the 91-day draft purged, nothing else | `{"ok":true,"tenants":1,"deals":1,"failed":0}`; tombstone `ABANDONED_DRAFT`, 1 person, 1 business, 2 documents; the draft cancelled today not purged | `08-staff-sees-purge-tombstone.png` |
| Booked deal untouched | no tombstone, rows unchanged | no "Dealer data purged" on the page; md5 of the booked deal's deal, business and document rows identical before and after a second cron run (`058891b1…` both; that run purged 0) | `09-staff-booked-deal-untouched.png` |

## Found and fixed during the run

- A cancelled draft still said "The deal is with the lender" under Documents;
  the line now shows only while the deal takes documents.
- Erased people were still listed under "Contacts a dealer captured" with a
  verify action; the staff panel now leaves out a purged person.
- The booked deal from the IT booking fixture had no structure
  (`MONTHLY_36`, no weights) and its staff page failed to render (a 500 and
  "structurePreset MONTHLY_36 is not a known preset"). A seed artefact: the
  seed now gives it a real structure (applied to this run's database before the
  second cron run and screenshot 09).
