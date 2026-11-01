import { prisma } from "@/lib/prisma"
import { checkSigningOtp, SIGNING_OTP_REFUSAL_MESSAGES } from "@/lib/signing-otp/challenge"
import { acceptOffer, acknowledgeKeyFacts, type BranchAssistant } from "./acknowledge"
import { signKeyFactsAgreement, type SignResult } from "./sign"

export type BranchSignResult = SignResult

/**
 * Staff help a borrower in the branch: the screen is the lender's, the act is the borrower's. Nothing is
 * recorded until a one-time code sent to the borrower's own mailbox or phone has been verified for this exact
 * agreement, so a staff member alone cannot get past this. The borrower's acceptance of the offer letter, their
 * acknowledgement of the key facts statement and their signature then land as theirs, on the digests they
 * were shown, each with the staff member recorded as the witness (`assistedBy`), the code spent on the signature.
 */
export async function signAtBranch(args: {
  tenantId: string
  applicationId: string
  staff: BranchAssistant
  /** The staff member confirms they watched the borrower, in person, identified, do this themselves. */
  witnessAttested: unknown
  offerSha256: unknown
  keyFactsSha256: unknown
  agreementDocumentSha256: unknown
  signature: unknown
  signingOtpChallengeId: string | null
  ipAddress: string
}): Promise<BranchSignResult> {
  const { tenantId, applicationId, staff } = args
  if (args.witnessAttested !== true) return { ok: false, status: 422, error: "Confirm that the borrower is here in person and is doing this themselves." }
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { clientId: true, disclosureRegime: true, agreementDocumentSha256: true, client: { select: { email: true } } },
  })
  if (!application?.clientId) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS") return { ok: false, status: 409, error: "This application is signed through the credit agreement ceremony" }
  const clientId = application.clientId
  if (typeof args.offerSha256 !== "string" || typeof args.keyFactsSha256 !== "string") {
    return { ok: false, status: 422, error: "The documents shown to the borrower are required" }
  }
  if (typeof args.signature !== "string" || args.signature.trim().length < 3) return { ok: false, status: 422, error: "The borrower types their full name to sign" }
  if (args.agreementDocumentSha256 !== application.agreementDocumentSha256 || !application.agreementDocumentSha256) {
    return { ok: false, status: 409, error: "The agreement was replaced after this page loaded. Refresh, read the current one, and sign again." }
  }

  // First: without the borrower's own verified code, not even the acceptance is written.
  const refusal = await checkSigningOtp(prisma, args.signingOtpChallengeId, {
    tenantId, clientId, purpose: "AGREEMENT", subjectId: applicationId, documentSha256: application.agreementDocumentSha256,
  })
  if (refusal) return { ok: false, status: 409, error: SIGNING_OTP_REFUSAL_MESSAGES[refusal], signingOtp: refusal }

  const common = { tenantId, applicationId, clientId, clientEmail: application.client?.email ?? null, ipAddress: args.ipAddress, assistedBy: staff }
  const accepted = await acceptOffer({ ...common, shown: args.offerSha256 })
  if (!accepted.ok) return accepted
  const acknowledged = await acknowledgeKeyFacts({ ...common, shown: args.keyFactsSha256 })
  if (!acknowledged.ok) return acknowledged
  return signKeyFactsAgreement({ ...common, agreementDocumentSha256: args.agreementDocumentSha256, signature: args.signature, signingOtpChallengeId: args.signingOtpChallengeId })
}
