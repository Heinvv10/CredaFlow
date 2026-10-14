# Asset finance slice 3 — browser and document evidence

Captured 2026-10-14 from a local `next dev` (port 3476) on branch
`feat/asset-finance-slice3-portal`, against a throwaway Postgres 16 seeded by
`npx prisma migrate reset` (the three synthetic leases of
`prisma/seed/asset-finance-leases*.ts`). Every name, number and document is
synthetic. Mobile shots are the page at 390 px wide (same-origin frame).

| # | Screen | What it shows |
|---|---|---|
| 01 | Staff, trust FML, dark | Lease terms (CPA applies, escalation, last rental 14 Mar 2027), rentals with the rental / maintenance / VAT split and the tax invoice of the paid rental |
| 02 | Staff, dark | Maintenance fund (lessee settled), contributions, claim form; meter readings and projected excess |
| 03 | Staff, dark | End of term: RETURN elected and inspected, damage line, "Issue the end-of-term invoice" |
| 04 | Staff, dark | After issuing it: excess usage R 24 000 (80 h × R 300) and the damage on invoice INV-000009; status invoiced, awaiting payment |
| 05 | Staff, company FML, light | Fund R 10 300 (contributed R 13 500 − claims paid R 3 200); one claim submitted, one paid |
| 06 | Staff, light | The submitted claim approved by a second person; "Mark paid" asks for the payment reference |
| 07 | Staff, light | New deal as a full-maintenance lease: rental timing, escalation, penalty, maintenance, risk model, usage, excess rate |
| 08 | Staff, light | Lease preview: capital, base rental, residual, per-year escalation (8 % rental, 6.5 % maintenance), VAT per line, every rental |
| 09 | Staff, mobile | Rentals table scrolls inside its card; no page-level sideways scroll |
| 10 | Portal, sole proprietor, light | Operating lease on a bakkie: term, next rental, rentals and invoices |
| 11 | Portal, light | Rentals table scrolled: the sticky header stays opaque (fixed in this PR; slice 1's ScrollTable header was transparent inside `.cf-app-surface`) |
| 12 | Portal, dark | CPA lessee's early-termination quote: ends 20 business days out, 35 rentals cancelled, PV + 10 % penalty + VAT, the Reg 5(2) basis |
| 13 | Portal, dark | After "Accept": rentals after the termination date cancelled, quote accepted, a return opened |
| 14 | Portal, entity director, dark | Company FML: rentals with invoices, fund balance and claims history (read-only) |
| 15 | Portal, dark | Meter reading, request a quote, end-of-term window (opens 14 Apr 2029), documents |
| 16 | Portal, dark | A reading below the last one is refused with the reason |
| 17 | Portal, dark | A valid reading is recorded |
| 18–19 | Portal, mobile, dark | Rentals and the action sections at 390 px |
| 20 | PDF | CPA expiry notice (DRAFT watermark) |
| 21 | PDF | Early-termination quote (DRAFT watermark) |
| 22 | PDF | End-of-term inspection report (DRAFT watermark) |

The PDFs are rendered from the unit fixture (`lease-docs.fixture.ts`). Their
wording is placeholder legal text: the DRAFT watermark stays until the
lender's legal team signs the documents off.
