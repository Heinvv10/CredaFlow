import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A key facts statement and a loan agreement issued from the lender's templates (lib/non-nca-documents/issue.ts).
  LOAN_DOCUMENTS_ISSUED: "LOAN_DOCUMENTS_ISSUED",
  // The borrower acknowledged the key facts statement (lib/non-nca-documents/acknowledge.ts).
  KEY_FACTS_ACKNOWLEDGED: "KEY_FACTS_ACKNOWLEDGED",
  // The borrower signed the loan agreement of a key-facts application (lib/non-nca-documents/sign.ts).
  KEY_FACTS_AGREEMENT_SIGNED: "KEY_FACTS_AGREEMENT_SIGNED",
  // The borrower accepted the offer letter (lib/non-nca-documents/acknowledge.ts).
  LOAN_OFFER_ACCEPTED: "LOAN_OFFER_ACCEPTED",
  // What became of the notice to the borrower about a document, per channel (lib/non-nca-documents/deliver.ts).
  LOAN_DOCUMENT_NOTICE: "LOAN_DOCUMENT_NOTICE",
  // An arrears letter issued from the lender's template (lib/non-nca-documents/arrears-letter.ts).
  ARREARS_LETTER_ISSUED: "ARREARS_LETTER_ISSUED",
  // An indicative key facts statement shown before an application exists (lib/non-nca-documents/pre-submission.ts).
  KEY_FACTS_QUOTED: "KEY_FACTS_QUOTED",
  // A second staff member confirmed the payout account of a key-facts loan (lib/non-nca-documents/payout-account.ts).
  PAYOUT_ACCOUNT_VERIFIED: "PAYOUT_ACCOUNT_VERIFIED",
})
