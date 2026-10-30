import type { LoanDocumentKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { LOAN_DOCUMENT_KINDS } from "./keys"

export interface LoanDocumentView {
  kind: LoanDocumentKind
  issuanceId: string
  clientDocumentId: string
  pdfSha256: string
  templateVersion: number
  sample: boolean
  issuedAt: Date
  acknowledgedAt: Date | null
}

export interface LoanDocumentState {
  /** KEY_FACTS applications only; null for a PASQ application. */
  keyFacts: {
    status: string
    signedAt: Date | null
    documents: LoanDocumentView[]
    /** Why the documents would not carry a signature now, or null when they would. */
    signingProblem: string | null
  } | null
}

/** The standing key facts statement and loan agreement of an application, and whether they would carry a signature now. */
export async function loanDocumentState(tenantId: string, applicationId: string): Promise<LoanDocumentState | null> {
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { status: true, disclosureRegime: true, agreementSignedAt: true },
  })
  if (!application) return null
  if (application.disclosureRegime !== "KEY_FACTS") return { keyFacts: null }
  const rows = await prisma.loanDocumentIssuance.findMany({ where: { tenantId, applicationId, supersededAt: null }, orderBy: { kind: "asc" } })
  return {
    keyFacts: {
      status: application.status,
      signedAt: application.agreementSignedAt,
      documents: rows.map((r) => ({
        kind: r.kind, issuanceId: r.id, clientDocumentId: r.clientDocumentId, pdfSha256: r.pdfSha256, templateVersion: r.templateVersionNumber,
        sample: r.sample, issuedAt: r.issuedAt, acknowledgedAt: r.acknowledgedAt,
      })),
      signingProblem: await documentProblem(applicationId, true),
    },
  }
}

/**
 * Why a key-facts application's documents do not hold, or null when they do:
 * the database's own test (loanDocumentProblem), the one its sign and disburse
 * gates run. `forSigning` also requires the wording to still be the template's
 * current approved version; after signing the contract stands on the version it was
 * rendered from. The disbursement route calls this (forSigning = false) before it
 * does any work.
 */
export async function documentProblem(applicationId: string, forSigning: boolean): Promise<string | null> {
  for (const kind of LOAN_DOCUMENT_KINDS) {
    const [row] = await prisma.$queryRaw<{ problem: string | null }[]>`
      SELECT public."loanDocumentProblem"(${applicationId}, ${kind}::"LoanDocumentKind", ${forSigning}) AS problem`
    if (row?.problem) return row.problem
  }
  return null
}
