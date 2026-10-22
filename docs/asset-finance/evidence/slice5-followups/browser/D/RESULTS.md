# Part D browser acceptance: results (2026-10-22)

Run against the PR branch after review round 1, on a local `next dev`, a
throwaway PostgreSQL 16 (`cf-it-s5fd-browser2`) seeded by
`lib/dealer/dealer-followups-browser-seed.test.ts`, Chrome via DevTools. Every
page loaded with 0 console errors.

| Step | Expected | Seen | Screenshot |
|---|---|---|---|
| Remote consent | method radio, identity field (no personal details), the v2 statement, attestation recorded | statement "I confirm that the uploaded consent form was signed by the person named, that their identity was checked in the way recorded below, …"; "Consent attested"; nothing outstanding | `01-dealer-remote-consent-form.png`, `02-dealer-consent-attested.png` |
| Staff sees the method | REMOTE and the identity check on the staff panel | "signed remotely; identity checked by: Video call with the original ID document held to the camera, matched to the person" | `06-staff-sees-remote-method.png` |
| Dealer cancels own draft | CANCELLED with the reason; accurate retention copy | "The lender keeps this draft's details for 90 days after you cancel it. It then erases the people, business and documents you captured on it, unless it holds them for another reason."; staff panel "Cancelled by the dealer (TEST Dealer User) … “The buyer chose another machine”" | `03-dealer-cancel-form.png`, `04-dealer-draft-cancelled.png`, `07-staff-sees-dealer-cancellation.png` |
| Second dealer | 404 | page "Not found"; `POST …/cancel` → `404 {"error":"Deal not found"}`; B's deal list empty | `05-other-dealer-404.png` |
| Purge cron | the 91-day draft purged, nothing else | `{"ok":true,"tenants":1,"deals":1,"failed":0}`; tombstone `ABANDONED_DRAFT`, 1 person, 1 business, 2 documents erased, 0 kept; the draft cancelled today not purged | `08-staff-sees-purge-tombstone.png` |
| Purged draft closed for the dealer | no submit, cancel, attest or upload; a notice | "This draft was closed on 22 Oct 2026 and the details captured on it were erased. Start a new deal if the customer comes back."; no action buttons; borrower "Erased" | `10-dealer-sees-purged-draft-closed.png` |
| Booked deal untouched | no tombstone, rows unchanged | no "Dealer data purged"; md5 of the booked deal's deal, business and document rows `5def26de…` before and after the cron run | `09-staff-booked-deal-untouched.png` |

## Found and fixed during the runs

- First run (before review): a cancelled draft said "The deal is with the
  lender" under Documents; erased people were listed under "Contacts a dealer
  captured"; the IT booking fixture's deal had no structure and its staff
  page failed (seed artefact, fixed in the seed). All fixed.
- This run: the purged-draft notice first said "Start a new deal to finance
  this asset", which the asset rules may not allow; it now says "if the
  customer comes back".
