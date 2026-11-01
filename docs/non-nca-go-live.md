# Going live with a lender outside the NCA (Lesotho)

The rules live in `lib/non-nca-documents/.claude.md` and `lib/non-nca-documents/regime-evidence.ts`. This is what a
person does to stand such a lender up, and what the bank must accept.

## Setting up the lender

1. Set the instance jurisdiction first. It is frozen by the first application, and applications created before the
   instance became non-ZA stay `NCA_PASQ` (the column defaults to it). Those keep the NCA path, including credit life.
2. Under Settings, Documents, "Loan documents": create the four templates (offer letter, key facts statement, loan agreement,
   arrears letter) and save a draft; a second admin approves it (the author cannot); anyone but the approver publishes it.
   Nothing is issued until a template has a published, approved version.
3. Publish all four before the first application: the portal refuses a submission without the key facts statement, and the
   documents issue on approval.

## Go-live conditions

The bank accepts these or changes them:

- **A screening provider is configured.** A key-facts loan has no bureau, so screening is its identity-risk check. Decide
  and the readiness board refuse without one. The demo seed uses the simulated one; on a production build that needs
  `SIMULATED_INTEGRATIONS=screening`, which a real lender never sets.
- **The approval matrix rules for key-facts products set `ungraded: true`.** A key-facts application has no risk grade,
  so `riskGradeRankMin` never matches it and the row would fall to the default level.
- **Debts on a key-facts application are self-declared.** There are no bureau obligations to check them against, and the
  bank must accept that for affordability.
- **No automated engine approval.** Until a Lesotho bureau is integrated the engine refers every key-facts application.

## Legal wording the bank must supply

The templates in a demo are structure and figures only, marked SAMPLE. **There is no Lesotho wording in this system.** The gaps:

- **Offer letter:** the offer's terms, how long it stands, and what acceptance means.
- **Key facts statement:** the required disclosures, and the wording of the indicative statement shown before applying.
- **Loan agreement:** all of it.
- **Arrears letter:** the demand, any statutory period, the consequences, how to dispute or pay. Whether Lesotho law requires a
  form of notice, a delivery method or a waiting period before enforcement is for the bank's counsel. The system sends the letter by
  email with the PDF attached, at any arrears from 1 day; it has no minimum period and starts no enforcement step.

## Before an application is submitted

The borrower reads an indicative key facts statement for the exact product, amount and term, and the application claims it: from then
on the statement is evidence of that application and cannot be deleted or replaced. A statement stands for 24 hours and for the published
template version.

- **Portal:** the borrower reads it on the apply page. This is the digital route.
- **Staff capture (the branch):** the application is saved as a draft and submitted from its page, once staff have shown the borrower the
  statement for the draft's terms and confirmed they read it. The wizard has no submit on this instance. The confirmation is the staff member's.
- **Public website:** the form takes the lead and sends the visitor to the portal. It makes no application.
- **CRM lead conversion:** refused. Capture the client, then a draft.
- **Partner API:** makes drafts only, which staff submit as above.
- **Asset finance:** refused. It is an NCA product.

## Signing at a branch

Staff open the documents on the application; the borrower reads them and types their own name. A one-time code goes to the
borrower's own mailbox or phone, and nothing is recorded until it is verified: the lender's branch exemption does not apply to a
key-facts agreement. The staff member attests to identity and presence and is recorded as witness, and cannot disburse that loan, whatever the
segregation-of-duties setting. The borrower's email and WhatsApp number are frozen with the approval, because the code goes there: a change
before payout refuses until the application is returned to review and approved again. A borrower with no email or
WhatsApp on file cannot sign this way: capture one first, or the bank chooses a wet-ink route (not built).

An address staff capture or change is unverified: ordinary mail follows at once, but no signing code and no portal login recovery goes
there until a second staff member confirms the address they reviewed, on the client record, with a note. The borrower cannot confirm it: a
session reached by recovering the login through that address proves nothing. The one who confirmed does not witness that signature. A
number the borrower changed themselves needs nobody. So every client staff capture on a key-facts lender needs a second person before they can
sign or activate the portal. On a South African lender only a later edit needs this, not the first capture.

## Paying out

The disburse route books a signed key-facts loan (`lib/non-nca-documents/disburse.ts`). What the bank should know:

- **The payout is manual.** The officer makes the transfer at the bank only after the page shows the loan as ready, then
  records the bank's reference (required, unique per lender; case, spaces and character width do not make a different reference, punctuation does). Nothing in the system moves money.
- **KYC at payout is VERIFIED.** Decide needs the documents. The payout needs a biometric or, where none is captured, the
  in-person attestation (`/api/clients/[id]/kyc-in-person-verification`, ADMIN by default).
- **A second person confirms the payout account**, in place of AVS: a staff member other than the disburser, recorded as an
  `AvsCheck` row with provider `second_person` and audited. Changing the account or the borrower's identity voids it. The
  rule is enforced in code under the client lock, as AVS is, whatever the segregation-of-duties setting.
- **The borrower's identity is frozen at approval.** A change to the name, ID number or date of birth after
  approval refuses issuing, acknowledging, signing and the payout. Staff return the application to review, and the borrower signs again.
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

## The demo lender

`DEMO_LENDER=basotho npx prisma db seed` on a fresh database gives: the four templates approved, the simulated screening provider,
an approval matrix with an `ungraded` rule, Mpho Thamae with verified evidence and nothing applied for (the walk from the portal),
Tumelo Sekhonyana with `APP-SEED-0005` approved and its documents issued, and Lineo Ramokoena's `LN-SEED-0001` 15 days in arrears
(booked in the seed, not through the flow). A demo stack sets `DEMO_MODE=true`, so `.invalid` mailboxes are simulated and one-time
codes show on screen.

Staff, at `@basotho-lending.example`: `super.admin`, `admin`, `credit.officer`, `payout.confirmer`, `loan.admin.one`, `loan.admin.two`. Passwords come from
`SEED_SUPER_ADMIN_PASSWORD`, `SEED_ADMIN_PASSWORD`, `SEED_OFFICER_PASSWORD`, `SEED_PAYOUT_CONFIRMER_PASSWORD`, `SEED_LOAN_ADMIN_ONE_PASSWORD`, `SEED_LOAN_ADMIN_TWO_PASSWORD`, or are
printed once with `SEED_PRINT_CREDENTIALS=1`, with each TOTP secret. Borrowers sign in at `/portal/login` with `<first>.<last>@basotho-lending.invalid`
and `SEED_PORTAL_PASSWORD`. `loan.admin.one` approved `APP-SEED-0005`, so `loan.admin.two` pays it out; in-person KYC is an `admin` step and `payout.confirmer` confirms
the account: someone with no other part in the application. `APP-SEED-0005` can be paid out on the seed's day only: on a later day return it to review and approve it again.
