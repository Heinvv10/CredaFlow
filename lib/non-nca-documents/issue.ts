import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { saveFile } from "@/lib/storage"
import { LOAN_DOCUMENT_KINDS } from "./keys"
import { renderLoanDocument, type RenderedLoanDocument } from "./render"

export type IssueResult =
  | { ok: true; issued: { kind: string; issuanceId: string; clientDocumentId: string; pdfSha256: string; templateVersion: number; sample: boolean }[] }
  | { ok: false; status: 404 | 409 | 422; error: string }

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/**
 * Issues the key facts statement and the loan agreement of an approved key-facts
 * application from the lender's current approved templates, replacing any
 * standing, unsigned pair. Both are rendered and stored first; then, in one
 * transaction, the application is re-read under a lock (still approved, unsigned,
 * the same terms), the old pair is superseded, the new pair and the agreement
 * binding are written, and the issue is audited. The database re-checks all of it
 * (guardLoanDocumentIssuance, guardLoanApplicationKeyFactsDocuments).
 */
export async function issueLoanDocuments(args: {
  tenantId: string
  applicationId: string
  staff: { id: string; email: string }
  ipAddress?: string
}): Promise<IssueResult> {
  const { tenantId, applicationId, staff } = args
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { id: true, clientId: true, status: true, disclosureRegime: true, agreementSignedAt: true },
  })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS" || !application.clientId) {
    return { ok: false, status: 409, error: "This application is governed by the PASQ and credit agreement, not by a key facts statement" }
  }
  if (application.status !== "APPROVED") return { ok: false, status: 409, error: "Loan documents are issued for an approved application" }
  if (application.agreementSignedAt) return { ok: false, status: 409, error: "The loan agreement is already signed" }
  const clientId = application.clientId

  const rendered: RenderedLoanDocument[] = []
  for (const kind of LOAN_DOCUMENT_KINDS) {
    rendered.push(await renderLoanDocument({ tenantId, applicationId, kind, staffUserId: staff.id }))
  }
  const stored = await Promise.all(rendered.map(async (doc) => ({ doc, sha: sha256(doc.pdf), file: await saveFile(doc.pdf, "application/pdf") })))

  const issued = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ status: string; signed: Date | null; terms: string }[]>`
      SELECT "status"::text AS status, "agreementSignedAt" AS signed, public."loanApplicationTermsSha256"("id") AS terms
      FROM "LoanApplication" WHERE "id" = ${applicationId} AND "tenantId" = ${tenantId} FOR UPDATE`
    if (!locked || locked.status !== "APPROVED" || locked.signed) throw new IssueRefusedError("The application changed while the documents were being issued; issue them again")
    const now = new Date()
    await tx.loanDocumentIssuance.updateMany({ where: { tenantId, applicationId, supersededAt: null }, data: { supersededAt: now } })
    const rows = []
    for (const { doc, sha, file } of stored) {
      const clientDocument = await tx.clientDocument.create({
        data: {
          tenantId, clientId, docType: doc.kind === "LOAN_AGREEMENT" ? "CREDIT_AGREEMENT" : "OTHER",
          fileName: `${doc.kind === "LOAN_AGREEMENT" ? "loan-agreement" : "key-facts-statement"}-${applicationId}.pdf`,
          fileUrl: "", storagePath: file.storagePath, fileSize: file.fileSize, mimeType: "application/pdf",
          uploadedByType: "staff", uploadedById: staff.id, templateId: doc.templateId, generatedFromVersionId: doc.versionId,
          contentSha256: sha, extractionStatus: "skipped", verified: false,
        },
      })
      await tx.clientDocument.update({ where: { id: clientDocument.id }, data: { fileUrl: `/api/documents/${clientDocument.id}/view` } })
      const issuance = await tx.loanDocumentIssuance.create({
        data: {
          tenantId, applicationId, kind: doc.kind, templateId: doc.templateId, templateKey: doc.templateKey,
          templateVersionId: doc.versionId, templateVersionNumber: doc.versionNumber, templateContentSha256: doc.templateContentSha256,
          clientDocumentId: clientDocument.id, pdfSha256: sha, termsSha256: locked.terms, issuedById: staff.id,
        },
      })
      await tx.documentAccessLog.create({ data: { documentId: clientDocument.id, accessorType: "staff", accessorId: staff.id, action: "generated" } })
      rows.push({ kind: doc.kind, issuanceId: issuance.id, clientDocumentId: clientDocument.id, pdfSha256: sha, templateVersion: doc.versionNumber, sample: issuance.sample })
    }
    const agreement = rows.find((r) => r.kind === "LOAN_AGREEMENT")!
    await tx.loanApplication.update({
      where: { id: applicationId },
      data: { agreementGeneratedAt: now, agreementDocumentId: agreement.clientDocumentId, agreementDocumentSha256: agreement.pdfSha256 },
    })
    await logAuditStrict({
      tenantId, userId: staff.id, userEmail: staff.email, action: AuditAction.LOAN_DOCUMENTS_ISSUED, entity: "LoanApplication", entityId: applicationId,
      newValue: { documents: rows.map((r) => ({ kind: r.kind, issuanceId: r.issuanceId, pdfSha256: r.pdfSha256, templateVersion: r.templateVersion, sample: r.sample })) },
      ipAddress: args.ipAddress,
    }, tx)
    return rows
  }).catch((error: unknown) => {
    if (error instanceof IssueRefusedError) return error
    if (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError) return new IssueRefusedError(databaseMessage(error))
    throw error
  })
  if (issued instanceof IssueRefusedError) return { ok: false, status: 409, error: issued.message }
  return { ok: true, issued }
}

class IssueRefusedError extends Error {}

/** The sentence the database raised, without Prisma's query noise. */
export function databaseMessage(error: Error): string {
  const m = /message: "([^"]+)"/.exec(error.message) ?? /Message: `ERROR: ([^`]+)`/.exec(error.message)
  return m ? m[1] : error.message.split("\n").at(-1) ?? "The database refused the change"
}
