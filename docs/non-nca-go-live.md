# Going live with a lender outside the NCA (Lesotho)

The rules live in `lib/non-nca-documents/.claude.md` and `lib/non-nca-documents/regime-evidence.ts`. This is what a
person does to stand such a lender up, and what the bank must accept.

## Setting up the lender

1. Set the instance jurisdiction first. It is frozen by the first application, and applications created before the
   instance became non-ZA stay `NCA_PASQ` (the column defaults to it). Those keep the NCA path, including credit life.
2. Under Settings, Documents, "Loan documents": create both templates and save a draft; a second admin approves it (the
   author cannot); anyone but the approver publishes it. Nothing is issued until both have a published, approved version.

## Go-live conditions

The bank accepts these or changes them:

- **A screening provider is configured.** A key-facts loan has no bureau, so screening is its identity-risk check. Decide
  and the readiness board refuse without one.
- **The approval matrix rules for key-facts products set `ungraded: true`.** A key-facts application has no risk grade,
  so `riskGradeRankMin` never matches it and the row would fall to the default level.
- **Debts on a key-facts application are self-declared.** There are no bureau obligations to check them against, and the
  bank must accept that for affordability.
- **No automated engine approval.** Until a Lesotho bureau is integrated the engine refers every key-facts application.

## Paying out

The disburse route books a signed key-facts loan (`lib/non-nca-documents/disburse.ts`). What the bank should know:

- **The payout is manual.** The officer makes the transfer at the bank only after the page shows the loan as ready, then
  records the bank's reference (required, unique per lender). Nothing in the system moves money.
- **KYC at payout is VERIFIED.** Decide needs the documents. The payout needs a biometric or, where none is captured, the
  in-person attestation (`/api/clients/[id]/kyc-in-person-verification`, ADMIN by default).
- **A second person confirms the payout account**, in place of AVS: a staff member other than the disburser, recorded as an
  `AvsCheck` row with provider `second_person` and audited. Changing the account or the borrower's identity voids it. The
  rule is enforced in code under the client lock, as AVS is, whatever the segregation-of-duties setting.
- **The borrower's identity is frozen at approval.** A change to the name, ID number, date of birth or gender after
  approval refuses the agreement and the payout. Staff return the application to review, and the borrower signs again.
- **The signed agreement is payable on its start date only**, the SAST day of the approval. The loan is booked on the printed
  schedule, so a later payout would charge printed interest for days the borrower did not have the money. After that day
  staff return the application to review, approve it again and the borrower signs again. So approve, sign and pay fall on
  one day, or the bank accepts shifted schedules and its agreement says so.
- **Repayment is by EFT.** A debit-order mandate is not prepared for a key-facts loan.

## Not built: tender 2.5.1 core banking

A payout provider adapter behind `lib/payouts/registry.ts`, calling the bank's core banking disbursement API with the verified
account and the idempotency key `disburse:<applicationId>`; its confirmation callback, which replaces the staff-entered reference
and sets the loan's payout state; account verification for Lesotho banks, which replaces the second person; and, because the
payout then waits on the bank, a decision on the same-day rule. The bank supplies the API specification.
