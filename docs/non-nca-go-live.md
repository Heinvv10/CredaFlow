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
- **No automated engine approval until a bureau exists for the jurisdiction.** The engine refers every key-facts application
  with no bureau check of its review, and a South African bureau is never asked about a foreign consumer. See the next section.

## Instant approval of digital applications (tender 2.3.9): Partial

**Status: Partial until a Lesotho credit bureau is integrated.** The whole path is built and proven with the simulated bureau, which
a deployed build refuses unless `SIMULATED_INTEGRATIONS` names it: on a demo stack only. A real lender with no Lesotho bureau gets
no instant approval: the application refers to staff (`NO_BUREAU`), which is the standing decision and not a fault. A lender cannot
even switch the setting on while its bureau order has no bureau for the jurisdiction. Adding one means an adapter under
`lib/bureau/providers/`, adding it to `KEY_FACTS_BUREAU_PROVIDERS` and `APPROVAL_BUREAU_PROVIDERS` (`lib/compliance/bureau.ts`), and a
decision on the score floor: `TenantConfig.bureauMinScore` is calibrated on the Experian Sigma band.

The setting: Settings, Decision rules, "Instant approval of digital applications" (`DecisionEngineConfig.keyFactsInstantApproval`).
Off by default, a maker-checker change a SUPER_ADMIN approves, audited, and refused on a South African instance by the code and the
database. With it on and the engine LIVE for the portal channel, a client's own digital submission gets a bureau enquiry, and if the rules
approve and the affordability gate passes, the engine attests affordability and approves through the staff path. The bank accepts:

- **No person assesses affordability on such a loan.** The attestation, the rule set version and the run are on the record, and the
  decision log marks it automated. What stands behind it is the affordability gate on self-declared income and expenses, and the bureau's
  obligations. The bank's legal team confirms this is lawful in Lesotho, and that the rule set is one it approves.
- **Only an approval is instant, and only a clean file.** KYC must already be verified: an applicant whose documents a person has not yet
  verified stays with staff, so a first-time borrower will usually not get an instant decision. An open credit check (a payslip that did
  not validate, a statement that did not read), a screening match, the lender's record of a death, an approval-matrix level that needs a
  person, or a figure the gate cannot pass all send it to staff, with no attestation.
- **The approval matrix must allow it.** The engine never approves what needs a person: a matrix requiring level 1 keeps every such
  application pending. Set `requiredLevels: 0` on the rule for the small digital loans the bank wants instant. A loan with a scorecard
  grade is matched by grade, not by `ungraded`.
- **The 60 seconds.** Decided after the response is sent; measured from `submittedAt`, kept on the run (`submissionLatencyMs`) and shown on
  the Decision rules page. A bureau that is slow adds its own time, up to 25 seconds per bureau. If the task is lost to a restart the sweep
  takes it within about 8 minutes, so a target missed on a restart is seen in the p95, and the decision is still made.
- **An automated decline still needs the POPIA s71-style sign-off.** The setting changes approvals only; until the sign-off is recorded a
  decline verdict is referred. The bank decides whether Lesotho's Data Protection Act asks for the same wording.
- **Payout does not change.** The second person, in-person or biometric KYC and segregation of duties apply. Staff whose input the
  application carries cannot disburse an application the engine approved.

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
