import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { databaseMessage } from "./issue"

export type AcknowledgeResult = { ok: true; acknowledgedAt: Date } | { ok: false; status: 404 | 409 | 422; error: string }

/**
 * The borrower's acceptance of the key facts statement, on exactly the bytes they
 * were shown: the stored file is re-read and must still hash to the issued digest,
 * and the digest the page displayed (`shown`) must be the standing one. The
 * database allows it once, by the application's own borrower, on a standing
 * statement of an approved, unsigned application (guardLoanDocumentIssuance).
 */
export async function acknowledgeKeyFacts(args: {
  tenantId: string
  applicationId: string
  clientId: string
  /** The borrower is a Client, not a User: the audit row carries their email, and their id in the value. */
  clientEmail: string | null
  shown: string
  ipAddress?: string
}): Promise<AcknowledgeResult> {
  const { tenantId, applicationId, clientId } = args
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId, clientId },
    select: { id: true, status: true, disclosureRegime: true, agreementSignedAt: true },
  })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS") return { ok: false, status: 409, error: "This application has no key facts statement" }
  if (application.status !== "APPROVED" || application.agreementSignedAt) {
    return { ok: false, status: 409, error: "The key facts statement can be acknowledged on an approved, unsigned application" }
  }
  const issuance = await prisma.loanDocumentIssuance.findFirst({
    where: { tenantId, applicationId, kind: "KEY_FACTS_STATEMENT", supersededAt: null },
    include: { clientDocument: { select: { storagePath: true, deletedAt: true } } },
  })
  if (!issuance) return { ok: false, status: 409, error: "No key facts statement has been issued yet" }
  if (args.shown !== issuance.pdfSha256) {
    return { ok: false, status: 409, error: "The key facts statement was replaced after this page loaded. Refresh and read the current one." }
  }
  if (issuance.acknowledgedAt) return { ok: true, acknowledgedAt: issuance.acknowledgedAt }
  const path = issuance.clientDocument.storagePath
  const intact = path && !issuance.clientDocument.deletedAt && documentBytesMatchSha256(await readFile(path).catch(() => Buffer.alloc(0)), issuance.pdfSha256)
  if (!intact) return { ok: false, status: 422, error: "The stored key facts statement does not match what was issued" }

  const now = new Date()
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.loanDocumentIssuance.updateMany({
        where: { id: issuance.id, tenantId, supersededAt: null, acknowledgedAt: null },
        data: { acknowledgedAt: now, acknowledgedById: clientId, acknowledgedSha256: issuance.pdfSha256 },
      })
      if (claimed.count !== 1) throw new Error("The key facts statement changed while it was being acknowledged")
      await logAuditStrict({
        tenantId, userEmail: args.clientEmail ?? undefined, action: AuditAction.KEY_FACTS_ACKNOWLEDGED, entity: "LoanApplication", entityId: applicationId,
        newValue: { actor: { type: "client", clientId }, issuanceId: issuance.id, pdfSha256: issuance.pdfSha256, templateVersion: issuance.templateVersionNumber },
        ipAddress: args.ipAddress,
      }, tx)
    })
  } catch (error) {
    return { ok: false, status: 409, error: error instanceof Error ? databaseMessage(error) : "Could not record the acknowledgement" }
  }
  return { ok: true, acknowledgedAt: now }
}
