import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { checkSigningOtp, consumeSigningOtp, SigningOtpRefusedError } from "@/lib/signing-otp/challenge"
import { isSigningOtpRequired } from "@/lib/signing-otp/policy"
import { ConcurrentChangeError, databaseMessage, isDatabaseRefusal } from "./errors"

export type SignResult =
  | { ok: true; signedAt: Date }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string; signingOtp?: string }

/**
 * The borrower signs the loan agreement of a key-facts application. Refused unless
 * the key facts statement has been acknowledged; the signature is recorded over
 * the digest the borrower was shown (and the stored bytes must still match it),
 * with the lender's signing one-time code when the lender requires one. The write
 * itself is checked again by the database, which refuses it unless both documents
 * are standing, from the current approved template versions, with the terms
 * unchanged (guardLoanApplicationKeyFactsDocuments). A typed name is the signature
 * artefact; the signed agreement then awaits disbursement.
 */
export async function signKeyFactsAgreement(args: {
  tenantId: string
  applicationId: string
  clientId: string
  /** The borrower is a Client, not a User: the audit row carries their email, and their id in the value. */
  clientEmail: string | null
  agreementDocumentSha256: unknown
  signature: unknown
  signingOtpChallengeId: string | null
  ipAddress: string
}): Promise<SignResult> {
  const { tenantId, applicationId, clientId } = args
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId, clientId },
    select: {
      id: true, status: true, disclosureRegime: true, agreementSignedAt: true, agreementDocumentId: true, agreementDocumentSha256: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS") return { ok: false, status: 409, error: "This application is signed through the credit agreement ceremony" }
  if (application.status !== "APPROVED") return { ok: false, status: 409, error: "Only an approved application can be signed" }
  if (application.agreementSignedAt) return { ok: false, status: 409, error: "The loan agreement is already signed" }
  if (!application.agreementDocumentId || !application.agreementDocumentSha256) {
    return { ok: false, status: 422, error: "The loan agreement has not been issued yet" }
  }
  if (args.agreementDocumentSha256 !== application.agreementDocumentSha256) {
    return { ok: false, status: 409, error: "The agreement was replaced after this page loaded. Refresh, read the current one, and sign again." }
  }
  const signature = typeof args.signature === "string" ? args.signature.trim() : ""
  if (signature.length < 3 || signature.length > 200) return { ok: false, status: 422, error: "Type your full name to sign" }

  const document = await prisma.clientDocument.findFirst({
    where: { id: application.agreementDocumentId, tenantId, clientId, deletedAt: null, contentSha256: application.agreementDocumentSha256, storagePath: { not: null } },
    select: { storagePath: true },
  })
  const intact = document?.storagePath && documentBytesMatchSha256(await readFile(document.storagePath).catch(() => Buffer.alloc(0)), application.agreementDocumentSha256)
  if (!intact) return { ok: false, status: 422, error: "The stored loan agreement does not match what was issued" }

  const otpNeeded = await isSigningOtpRequired(tenantId, "portal")
  const binding = { tenantId, clientId, purpose: "AGREEMENT" as const, subjectId: applicationId, documentSha256: application.agreementDocumentSha256 }
  if (otpNeeded) {
    const refusal = await checkSigningOtp(prisma, args.signingOtpChallengeId, binding)
    if (refusal) return { ok: false, status: 409, error: "Verify the one-time code before signing", signingOtp: refusal }
  }

  const now = new Date()
  try {
    await prisma.$transaction(async (tx) => {
      if (otpNeeded) await consumeSigningOtp(tx, { ...binding, challengeId: args.signingOtpChallengeId!, method: "portal", now })
      const claimed = await tx.loanApplication.updateMany({
        where: { id: applicationId, tenantId, status: "APPROVED", agreementSignedAt: null, agreementDocumentId: application.agreementDocumentId, agreementDocumentSha256: application.agreementDocumentSha256 },
        data: { agreementSignedAt: now, agreementSignedMethod: "portal", agreementSignedByIp: args.ipAddress, agreementSignatureData: signature },
      })
      if (claimed.count !== 1) throw new ConcurrentChangeError("The application changed while it was being signed")
      await logAuditStrict({
        tenantId, userEmail: args.clientEmail ?? undefined, action: AuditAction.KEY_FACTS_AGREEMENT_SIGNED, entity: "LoanApplication", entityId: applicationId,
        newValue: { actor: { type: "client", clientId }, agreementDocumentSha256: application.agreementDocumentSha256, method: "portal", otp: otpNeeded },
        ipAddress: args.ipAddress,
      }, tx)
    })
  } catch (error) {
    if (error instanceof SigningOtpRefusedError) return { ok: false, status: 409, error: "Verify the one-time code before signing", signingOtp: error.reason }
    // Only a change under our feet or a refusal by the database is a conflict; anything else is a fault (500).
    if (error instanceof ConcurrentChangeError) return { ok: false, status: 409, error: error.message }
    if (isDatabaseRefusal(error)) return { ok: false, status: 409, error: databaseMessage(error) }
    throw error
  }
  return { ok: true, signedAt: now }
}
