import { Prisma } from "@prisma/client"

/**
 * The client's documents a payout holds FOR SHARE, whatever the regime: every selfie, and the verified core KYC and bank statement
 * documents. A verification cannot be withdrawn under a payout. Both disburse paths put this in their WHERE clause.
 */
export const KYC_AND_STATEMENT_DOCUMENTS = Prisma.sql`
  "docType" = 'SELFIE'::"DocType"
  OR (
    "deletedAt" IS NULL
    AND
    "verified" = true
    AND "docType" IN (
      'ID_COPY'::"DocType",
      'PROOF_OF_ADDRESS'::"DocType",
      'PAYSLIP'::"DocType",
      'BANK_STATEMENT'::"DocType"
    )
  )
`
