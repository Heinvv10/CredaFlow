import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A key facts statement and a loan agreement issued from the lender's templates (lib/non-nca-documents/issue.ts).
  LOAN_DOCUMENTS_ISSUED: "LOAN_DOCUMENTS_ISSUED",
  // The borrower acknowledged the key facts statement (lib/non-nca-documents/acknowledge.ts).
  KEY_FACTS_ACKNOWLEDGED: "KEY_FACTS_ACKNOWLEDGED",
  // The borrower signed the loan agreement of a key-facts application (lib/non-nca-documents/sign.ts).
  KEY_FACTS_AGREEMENT_SIGNED: "KEY_FACTS_AGREEMENT_SIGNED",
  // A second staff member confirmed the payout account of a key-facts loan (lib/non-nca-documents/payout-account.ts).
  PAYOUT_ACCOUNT_VERIFIED: "PAYOUT_ACCOUNT_VERIFIED",
})
