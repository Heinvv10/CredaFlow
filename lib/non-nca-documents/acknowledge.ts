import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { BORROWER_REFUSAL, requireLivingBorrower } from "./borrower-gate"
import { ConcurrentChangeError, databaseMessage, isDatabaseRefusal } from "./errors"

export type AcknowledgeResult = { ok: true; acknowledgedAt: Date } | { ok: false; status: 404 | 409 | 422; error: string }

/** The staff member beside the borrower at a branch. They witness; the borrower's own code carries the act (branch-sign.ts). */
export interface BranchAssistant { id: string; email: string }

const WORDS = {
  KEY_FACTS_STATEMENT: { name: "key facts statement", act: "acknowledged", action: AuditAction.KEY_FACTS_ACKNOWLEDGED },
  OFFER_LETTER: { name: "offer letter", act: "accepted", action: AuditAction.LOAN_OFFER_ACCEPTED },
} as const

interface AcknowledgeArgs {
  tenantId: string
  applicationId: string
  clientId: string
  /** The borrower is a Client, not a User: the audit row carries their email, and their id in the value. */
  clientEmail: string | null
  shown: string
  ipAddress?: string
  assistedBy?: BranchAssistant
}

/**
 * The borrower's acceptance of the offer letter or the key facts statement, on exactly the bytes they
 * were shown: the stored file is re-read and must still hash to the issued digest, and the digest the page
 * displayed (`shown`) must be the standing one. The database allows it once, by the application's own borrower,
 * on a standing document of an approved, unsigned application (guardLoanDocumentIssuance).
 */
async function acknowledge(kind: keyof typeof WORDS, args: AcknowledgeArgs): Promise<AcknowledgeResult> {
  const { tenantId, applicationId, clientId, assistedBy } = args
  const { name, act, action } = WORDS[kind]
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId, clientId },
    select: { id: true, status: true, disclosureRegime: true, agreementSignedAt: true },
  })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS") return { ok: false, status: 409, error: `This application has no ${name}` }
  if (application.status !== "APPROVED" || application.agreementSignedAt) {
    return { ok: false, status: 409, error: `The ${name} can be ${act} on an approved, unsigned application` }
  }
  const issuance = await prisma.loanDocumentIssuance.findFirst({
    where: { tenantId, applicationId, kind, supersededAt: null },
    include: { clientDocument: { select: { storagePath: true, deletedAt: true } } },
  })
  if (!issuance) return { ok: false, status: 409, error: `No ${name} has been issued yet` }
  if (args.shown !== issuance.pdfSha256) {
    return { ok: false, status: 409, error: `The ${name} was replaced after this page loaded. Refresh and read the current one.` }
  }
  if (issuance.acknowledgedAt) return { ok: true, acknowledgedAt: issuance.acknowledgedAt }
  const path = issuance.clientDocument.storagePath
  const intact = path && !issuance.clientDocument.deletedAt && documentBytesMatchSha256(await readFile(path).catch(() => Buffer.alloc(0)), issuance.pdfSha256)
  if (!intact) return { ok: false, status: 422, error: `The stored ${name} does not match what was issued` }

  const now = new Date()
  try {
    await prisma.$transaction(async (tx) => {
      await requireLivingBorrower(tx, { tenantId, applicationId, clientId, refusal: BORROWER_REFUSAL })
      const claimed = await tx.loanDocumentIssuance.updateMany({
        where: { id: issuance.id, tenantId, supersededAt: null, acknowledgedAt: null },
        data: { acknowledgedAt: now, acknowledgedById: clientId, acknowledgedSha256: issuance.pdfSha256 },
      })
      if (claimed.count !== 1) throw new ConcurrentChangeError(`The ${name} changed while it was being ${act}`)
      await logAuditStrict({
        tenantId, userEmail: args.clientEmail ?? undefined, action, entity: "LoanApplication", entityId: applicationId,
        newValue: {
          actor: { type: "client", clientId }, issuanceId: issuance.id, pdfSha256: issuance.pdfSha256, templateVersion: issuance.templateVersionNumber,
          ...(assistedBy ? { assistedBy } : {}),
        },
        ipAddress: args.ipAddress,
      }, tx)
    })
  } catch (error) {
    // Only a change under our feet or a refusal by the database is a conflict; anything else is a fault (500).
    if (error instanceof ConcurrentChangeError) return { ok: false, status: 409, error: error.message }
    if (isDatabaseRefusal(error)) return { ok: false, status: 409, error: databaseMessage(error) }
    throw error
  }
  return { ok: true, acknowledgedAt: now }
}

export const acknowledgeKeyFacts = (args: AcknowledgeArgs) => acknowledge("KEY_FACTS_STATEMENT", args)
export const acceptOffer = (args: AcknowledgeArgs) => acknowledge("OFFER_LETTER", args)
