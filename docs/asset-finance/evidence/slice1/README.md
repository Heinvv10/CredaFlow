# Asset finance slice 1 — evidence and demo logins

Screenshots and rendered PDFs for the slice-1 acceptance walk-through
(goal §4.12, §4.13). Every name, number, VIN and ID in them is synthetic.

## Seeded demo data

`npx prisma migrate reset` (or `npm run seed:base`) on a local or throwaway
database seeds, on the Acme demo tenant with `featureAssetFinance` on
(`prisma/seed/asset-finance.ts`):

- **TEST Family Farming Trust** — two natural trustees, verified Letters of
  Authority, R800 000 turnover. Its tractor deal is classified NCA
  (`TRUST_FEW_NATURAL_TRUSTEES`) and refused: deal `REFUSED_NCA`,
  application `DECLINED` with the slice-1 reason.
- **TEST Earthmoving (Pty) Ltd** — verified AFS (R25m turnover), TEST
  Director One (director, authorised signatory and surety) and TEST Surety
  One (surety only). An excavator at R1 725 000 incl. VAT on
  `ANNUAL_SEASONAL` (Apr–Jun ×3, other months ×0.5, 60 months), 20% balloon,
  PRIME + 1.00%. NON_NCA through the classifier's override (approved by the
  second loan admin), credit memo, approved, signed (director e-sign; the
  surety's suretyship in wet ink, uploaded and confirmed by two staff
  users), contracted, paid out, booked four months and five days before the
  seed ran, first three instalments paid, the fourth in arrears.

## Portal logins (synthetic, known by design)

| Client | Email | Password | Access |
|---|---|---|---|
| TEST Director One | `test.director.one@acme-lending.invalid` | `Synthetic-AF-Director-2099!` | the company's applications, contracts and documents; signs |
| TEST Surety One | `test.surety.one@acme-lending.invalid` | `Synthetic-AF-Surety-2099!` | no entity access (404); their own suretyship only |

Sign in at `/portal/login`. The passwords are set when the client row is
first created; a rerun keeps them. The seed refuses to run with
`NODE_ENV=production`.

## Staff logins

`admin@`, `credit.officer@`, `loan.admin.one@` and `loan.admin.two@`
`acme-lending.example`, each with TOTP enrolled. Their passwords are generated
on first creation (or set with `SEED_ADMIN_PASSWORD`, `SEED_OFFICER_PASSWORD`,
`SEED_LOAN_ADMIN_ONE_PASSWORD`, `SEED_LOAN_ADMIN_TWO_PASSWORD`) and printed
only with `SEED_PRINT_CREDENTIALS=1`.
