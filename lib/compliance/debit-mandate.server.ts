import { Prisma } from "@prisma/client"
import { generateDebitMandatePdf } from "@/lib/pdf/debitMandate"
import {
  assertDebitMandateCreditorTenant,
  getDebitMandateCreditorBankDetails,
} from "@/lib/config/debit-mandate"
import { getLenderIdentity } from "@/lib/config/identity"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import {
  debitMandateContractTerms,
  readDebitMandateEvidence,
  verifiedBankStatementEvidence,
  verifyStoredDebitMandatePreparation,
  verifyStoredSignedDebitMandate,
  type DebitMandateBankDetails,
  type DebitMandateExpectedEvidence,
  type PayoutBankDetails,
} from "@/lib/compliance/debit-mandate"

export const debitMandateApplicationArgs =
  Prisma.validator<Prisma.LoanApplicationDefaultArgs>()({
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          idNumber: true,
          phone: true,
          email: true,
          bankName: true,
          bankBranchCode: true,
          bankAccountNumber: true,
          accountType: true,
        },
      },
    },
  })

export type DebitMandateApplication = Prisma.LoanApplicationGetPayload<
  typeof debitMandateApplicationArgs
>

export const debitMandateBankStatementSelect = {
  id: true,
  contentSha256: true,
  storagePath: true,
  verifiedAt: true,
  extractionResult: true,
  validationMismatch: true,
} as const

type DebitMandateStatementReader = {
  clientDocument: {
    findMany: (args: {
      where: {
        tenantId: string
        clientId: string
        docType: "BANK_STATEMENT"
        deletedAt: null
        verified: true
        verifiedAt: { not: null }
        id?: string
      }
      orderBy: readonly [
        { verifiedAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ]
      take: number
      select: typeof debitMandateBankStatementSelect
    }) => Promise<Array<{
      id: string
      contentSha256: string | null
      storagePath: string | null
      verifiedAt: Date | null
      extractionResult: unknown
      validationMismatch: boolean
    }>>
  }
}

/**
 * The shared payout gate, used by BOTH the EFT and debit-order paths.
 *
 * Takes the wider PayoutBankDetails despite the "ForMandate" name it kept for
 * its existing callers: an EFT payout may be to an OTHER account, and a
 * DebitMandateBankDetails is assignable here, so the debit-order callers are
 * unaffected while the narrow type keeps guarding mandate preparation itself.
 */
export async function findVerifiedBankStatementForMandate(
  reader: DebitMandateStatementReader,
  args: {
    tenantId: string
    clientId: string
    bankDetails: PayoutBankDetails
    documentId?: string
  },
) {
  const statements = await reader.clientDocument.findMany({
    where: {
      tenantId: args.tenantId,
      clientId: args.clientId,
      docType: "BANK_STATEMENT",
      deletedAt: null,
      verified: true,
      verifiedAt: { not: null },
      ...(args.documentId ? { id: args.documentId } : {}),
    },
    orderBy: [
      { verifiedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: args.documentId ? 1 : 20,
    select: debitMandateBankStatementSelect,
  })
  let strongestFailure:
    | "verified_bank_statement_missing"
    | "verified_bank_statement_integrity_missing"
    | "verified_bank_statement_mismatch" =
      "verified_bank_statement_missing"
  // Which leg the FIRST mismatching statement failed. Statements are ordered
  // most-recently-verified first, so this names the one staff are most likely
  // looking at, and it is only set once for the same reason.
  let strongestMismatchField: string | undefined
  for (const statement of statements) {
    const assessment = verifiedBankStatementEvidence(statement, args.bankDetails)
    if (assessment.ok) {
      if (!statement.storagePath) {
        strongestFailure = "verified_bank_statement_integrity_missing"
        continue
      }
      try {
        const bytes = await readFile(statement.storagePath)
        if (documentBytesMatchSha256(bytes, assessment.evidence.documentSha256)) {
          return assessment
        }
      } catch {
        // Missing or unreadable bytes are not valid banking evidence.
      }
      strongestFailure = "verified_bank_statement_integrity_missing"
      continue
    }
    if (assessment.reason === "verified_bank_statement_mismatch") {
      if (strongestFailure !== "verified_bank_statement_mismatch") {
        strongestMismatchField = assessment.mismatchField
      }
      strongestFailure = assessment.reason
    } else if (
      strongestFailure === "verified_bank_statement_missing"
      && assessment.reason === "verified_bank_statement_integrity_missing"
    ) {
      strongestFailure = assessment.reason
    }
  }
  return {
    ok: false as const,
    reason: strongestFailure,
    mismatchField: strongestMismatchField,
  }
}

export type DebitMandatePdfTenant = {
  id: string
}

export async function renderApplicationDebitMandatePdf(args: {
  tenant: DebitMandatePdfTenant
  application: Pick<DebitMandateApplication, "reference"> & {
    client: DebitMandateApplication["client"]
  }
  collectionReference: string
  bankDetails: DebitMandateBankDetails
  paymentTerms: ReturnType<typeof debitMandateContractTerms>["paymentTerms"]
  generatedAt: Date
  authorization?: {
    signedAt: Date
    method: "portal"
    signature: string
    signatureSha256: string
    evidenceSha256: string
    sourceDocumentSha256: string
  }
}) {
  assertDebitMandateCreditorTenant(args.tenant.id)
  const creditorBankDetails = getDebitMandateCreditorBankDetails()
  // Throws LenderIdentityError when unconfigured: the mandate names the
  // creditor and its NCR registration, so it must not render without them.
  const identity = await getLenderIdentity(args.tenant.id)
  // No logo here: this draft is fingerprinted when prepared and re-rendered by
  // the preview and the signature, so a logo uploaded or removed in between
  // would fail every pending mandate's integrity check. The logo is not part
  // of the frozen evidence; the text letterhead is.
  return generateDebitMandatePdf({
    lender: identity,
    creditorBank: creditorBankDetails,
    client: {
      firstName: args.application.client.firstName,
      lastName: args.application.client.lastName,
      idNumber: args.application.client.idNumber,
      phone: args.application.client.phone ?? undefined,
      email: args.application.client.email ?? undefined,
      ...args.bankDetails,
    },
    loan: {
      reference: args.collectionReference,
      ...args.paymentTerms,
    },
    generatedAt: args.generatedAt,
    authorization: args.authorization,
  })
}

export function currentDebitMandateBankDetails(
  application: DebitMandateApplication,
): DebitMandateBankDetails | null {
  const { client } = application
  if (
    !client.bankName
    || !client.bankBranchCode
    || !client.bankAccountNumber
    || (client.accountType !== "CHEQUE"
      && client.accountType !== "SAVINGS")
  ) {
    return null
  }
  return {
    bankName: client.bankName,
    branchCode: client.bankBranchCode,
    accountNumber: client.bankAccountNumber,
    accountType: client.accountType,
  }
}

/**
 * The current bank tuple for a PAYOUT, which may be an OTHER account.
 *
 * This was an alias of `currentDebitMandateBankDetails` while payout and debit
 * order accepted exactly the same account types. OTHER splits them: it is a
 * valid payout account and an invalid debit-order account, because the Netcash
 * AVS wire has no value to send for it.
 *
 * The alias had to go rather than be widened. Widening the shared function
 * would have let an OTHER account through to mandate preparation, where it
 * would have been refused later and less clearly; leaving it aliased would have
 * failed an OTHER client on the EFT path at `bank_details_incomplete` — before
 * the gate this change was made to relax ever ran, and pointing at the wrong
 * cause.
 *
 * KEEP THE TWO BODIES IN STEP. They are deliberately near-identical and differ
 * only in accepting OTHER, so a future account-type change has to be made
 * twice. Nothing in the type system enforces that. What does enforce it is
 * `debit-mandate.server.test.ts` → "payout vs debit-order bank tuple readers",
 * which asserts BOTH functions against the same inputs in the same cases — the
 * rule "OTHER may be paid by EFT but never reaches a debit order" is only
 * visible in the difference between them, so testing either one alone would let
 * them silently drift back into agreement. Add a case there before changing
 * either body.
 */
export function currentVerifiedBankDetails(
  application: DebitMandateApplication,
): PayoutBankDetails | null {
  const { client } = application
  if (
    !client.bankName
    || !client.bankBranchCode
    || !client.bankAccountNumber
    || (client.accountType !== "CHEQUE"
      && client.accountType !== "SAVINGS"
      && client.accountType !== "OTHER")
  ) {
    return null
  }
  return {
    bankName: client.bankName,
    branchCode: client.bankBranchCode,
    accountNumber: client.bankAccountNumber,
    accountType: client.accountType,
  }
}

type CurrentDebitMandateFailure = {
  ok: false
  reason: string
}

type CurrentDebitMandateContext = {
  application: DebitMandateApplication
  bankDetails: DebitMandateBankDetails
  bankStatement: DebitMandateExpectedEvidence["bankStatement"]
  contract: ReturnType<typeof debitMandateContractTerms>
}

type CurrentPreparedDebitMandate = CurrentDebitMandateContext & {
  ok: true
  evidence: NonNullable<ReturnType<typeof readDebitMandateEvidence>>
  evidenceSha256: string
  draftDocumentSha256: string
}

type CurrentSignedDebitMandate = CurrentPreparedDebitMandate & {
  signedAt: Date
  signatureSha256: string
  documentId: string
  documentSha256: string
}

export async function verifyCurrentStoredDebitMandate(
  reader: DebitMandateStatementReader,
  args: {
    tenantId: string
    application: DebitMandateApplication
    requireSignature: true
  },
): Promise<CurrentSignedDebitMandate | CurrentDebitMandateFailure>
export async function verifyCurrentStoredDebitMandate(
  reader: DebitMandateStatementReader,
  args: {
    tenantId: string
    application: DebitMandateApplication
    requireSignature: false
  },
): Promise<CurrentPreparedDebitMandate | CurrentDebitMandateFailure>
export async function verifyCurrentStoredDebitMandate(
  reader: DebitMandateStatementReader,
  args: {
    tenantId: string
    application: DebitMandateApplication
    requireSignature: boolean
  },
): Promise<
  | CurrentSignedDebitMandate
  | CurrentPreparedDebitMandate
  | CurrentDebitMandateFailure
> {
  const bankDetails = currentDebitMandateBankDetails(args.application)
  if (!bankDetails) {
    return {
      ok: false as const,
      reason: "bank_details_incomplete" as const,
    }
  }
  const storedEvidence = readDebitMandateEvidence(
    args.application.debitMandateEvidence,
  )
  if (!storedEvidence) {
    return {
      ok: false as const,
      reason: "evidence_invalid" as const,
    }
  }
  const bankStatement = await findVerifiedBankStatementForMandate(reader, {
    tenantId: args.tenantId,
    clientId: args.application.clientId,
    bankDetails,
    documentId: storedEvidence.bankStatement.documentId,
  })
  if (!bankStatement.ok) return bankStatement
  const contract = debitMandateContractTerms(
    args.application.affordabilityResult,
    args.application.pasqEvidence,
  )
  const expected: DebitMandateExpectedEvidence = {
    applicationId: args.application.id,
    clientId: args.application.clientId,
    contractFingerprint: contract.contractFingerprint,
    bankDetails,
    bankStatement: bankStatement.evidence,
    terms: contract.evidence,
  }
  const verification = args.requireSignature
    ? verifyStoredSignedDebitMandate(args.application, expected)
    : verifyStoredDebitMandatePreparation(args.application, expected)
  if (!verification.ok) return verification
  return {
    ...verification,
    application: args.application,
    bankDetails,
    bankStatement: bankStatement.evidence,
    contract,
  }
}
