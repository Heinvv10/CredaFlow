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

## Portal logins

| Client | Email | Access |
|---|---|---|
| TEST Director One | `test.director.one@acme-lending.invalid` | the company's applications, contracts and documents; signs |
| TEST Surety One | `test.surety.one@acme-lending.invalid` | no entity access (404); their own suretyship only |

Sign in at `/portal/login`. Set the passwords with `SEED_AF_DIRECTOR_PASSWORD`
and `SEED_AF_SURETY_PASSWORD` (applied on every seed run), or read the
generated ones with `SEED_PRINT_CREDENTIALS=1` on the run that creates the
clients. No password is in source. The seed refuses `NODE_ENV=production`.

## Staff logins

`admin@`, `credit.officer@`, `loan.admin.one@` and `loan.admin.two@`
`acme-lending.example`, each with TOTP enrolled. Their passwords are generated
on first creation (or set with `SEED_ADMIN_PASSWORD`, `SEED_OFFICER_PASSWORD`,
`SEED_LOAN_ADMIN_ONE_PASSWORD`, `SEED_LOAN_ADMIN_TWO_PASSWORD`) and printed
only with `SEED_PRINT_CREDENTIALS=1`.

## UI walkthrough screenshots (PR #59)

Taken on a throwaway seeded DB, Chrome 1280x800 (desk) and 375x667 (mob), light and dark where noted in the name. PDFs rendered with pdftoppm.

- `walkthrough-01-entities-list-dark-desk.png`
- `walkthrough-01-entities-list-dark-mob.png`
- `walkthrough-01-entities-list-light-desk.png`
- `walkthrough-01-entities-list-light-mob.png`
- `walkthrough-02-entity-company-detail-dark-desk.png`
- `walkthrough-02-entity-company-detail-dark-mob.png`
- `walkthrough-02-entity-company-detail-light-desk.png`
- `walkthrough-02-entity-company-detail-light-mob.png`
- `walkthrough-03-entity-trust-detail-dark-desk.png`
- `walkthrough-03-entity-trust-detail-light-desk.png`
- `walkthrough-04-assets-list-dark-desk.png`
- `walkthrough-04-assets-list-dark-mob.png`
- `walkthrough-04-assets-list-light-desk.png`
- `walkthrough-04-assets-list-light-mob.png`
- `walkthrough-05-asset-excavator-detail-dark-desk.png`
- `walkthrough-05-asset-excavator-detail-light-desk.png`
- `walkthrough-06-suppliers-list-dark-desk.png`
- `walkthrough-06-suppliers-list-light-desk.png`
- `walkthrough-07-supplier-detail-dark-desk.png`
- `walkthrough-07-supplier-detail-light-desk.png`
- `walkthrough-08-deals-list-dark-desk.png`
- `walkthrough-08-deals-list-dark-mob.png`
- `walkthrough-08-deals-list-light-desk.png`
- `walkthrough-08-deals-list-light-mob.png`
- `walkthrough-09-deal-company-detail-dark-desk.png`
- `walkthrough-09-deal-company-detail-dark-mob.png`
- `walkthrough-09-deal-company-detail-light-desk.png`
- `walkthrough-09-deal-company-detail-light-mob.png`
- `walkthrough-10-deal-trust-refused-dark-desk.png`
- `walkthrough-10-deal-trust-refused-light-desk.png`
- `walkthrough-11-deal-new-preview-dark-desk.png`
- `walkthrough-11-deal-new-preview-dark-mob.png`
- `walkthrough-11-deal-new-preview-light-desk.png`
- `walkthrough-11-deal-new-preview-light-mob.png`
- `walkthrough-12-booked-loan-dark-desk.png`
- `walkthrough-12-booked-loan-dark-mob.png`
- `walkthrough-12-booked-loan-light-desk.png`
- `walkthrough-12-booked-loan-light-mob.png`
- `walkthrough-13-tax-invoice-pdf-1.png`
- `walkthrough-14-signer-document-pdf-1.png`
- `walkthrough-14-signer-document-pdf-2.png`
- `walkthrough-20-portal-business-dark-desk.png`
- `walkthrough-20-portal-business-dark-mob.png`
- `walkthrough-20-portal-business-light-desk.png`
- `walkthrough-20-portal-business-light-mob.png`
- `walkthrough-21-portal-entity-dark-desk.png`
- `walkthrough-21-portal-entity-dark-mob.png`
- `walkthrough-21-portal-entity-light-desk.png`
- `walkthrough-21-portal-entity-light-mob.png`
- `walkthrough-22-portal-contract-dark-desk.png`
- `walkthrough-22-portal-contract-dark-mob.png`
- `walkthrough-22-portal-contract-light-desk.png`
- `walkthrough-22-portal-contract-light-mob.png`
- `walkthrough-23-portal-statement-pdf-1.png`
- `walkthrough-23-portal-statement-pdf-2.png`
- `walkthrough-24-portal-surety-business-dark-desk.png`
- `walkthrough-24-portal-surety-business-light-desk.png`
- `walkthrough-24-portal-surety-business-light-mob.png`
- `walkthrough-25-portal-surety-entity-404-dark-desk.png`
- `walkthrough-25-portal-surety-entity-404-light-desk.png`
- `walkthrough-25-portal-surety-entity-404-light-mob.png`
- `walkthrough-26-portal-surety-contract-404-dark-desk.png`
- `walkthrough-26-portal-surety-contract-404-light-desk.png`
- `walkthrough-26-portal-surety-contract-404-light-mob.png`
- `walkthrough-27-portal-home-mobile-nav.png`
