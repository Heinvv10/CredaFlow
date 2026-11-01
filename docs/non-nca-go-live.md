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
