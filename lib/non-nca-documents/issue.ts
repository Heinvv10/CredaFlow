import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { deleteFile, saveFile } from "@/lib/storage"
import { identityChangedSinceApproval } from "./identity"
import { LOAN_DOCUMENT_KINDS, LOAN_DOCUMENT_LABELS } from "./keys"
import { STAFF_REFUSAL, requireLivingBorrower } from "./borrower-gate"
import { ConcurrentChangeError, databaseMessage, isDatabaseRefusal } from "./errors"
import { renderLoanDocument, type RenderedLoanDocument } from "./render"
import { deliverToBorrower, operationIdFor } from "./deliver"

export type IssueResult =
  | { ok: true; issued: { kind: string; issuanceId: string; clientDocumentId: string; pdfSha256: string; templateVersion: number; sample: boolean }[] }
  | { ok: false; status: 404 | 409 | 422; error: string }

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/**
 * Issues the offer letter, the key facts statement and the loan agreement of an
 * approved key-facts application from the lender's current approved templates,
 * replacing any standing, unsigned set. All are rendered and stored first; then, in
 * one transaction, the application is re-read under a lock (still approved, unsigned,
 * the same terms), the old set is superseded, the new set and the agreement binding
 * are written, and the issue is audited. The database re-checks all of it
 * (guardLoanDocumentIssuance, guardLoanApplicationKeyFactsDocuments). The borrower
 * is told once it stands; a failed notice never undoes the issue (deliver.ts).
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
    select: {
      id: true, reference: true, clientId: true, status: true, disclosureRegime: true, agreementSignedAt: true, affordabilityResult: true,
      client: { select: { id: true, idNumber: true, firstName: true, lastName: true, dateOfBirth: true } },
    },
  })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS" || !application.clientId || !application.client) {
    return { ok: false, status: 409, error: "This application is governed by the PASQ and credit agreement, not by a key facts statement" }
  }
  if (application.status !== "APPROVED") return { ok: false, status: 409, error: "Loan documents are issued for an approved application" }
  if (application.agreementSignedAt) return { ok: false, status: 409, error: "The loan agreement is already signed" }
  if (identityChangedSinceApproval({ affordabilityResult: application.affordabilityResult, client: application.client })) {
    return { ok: false, status: 409, error: "The borrower's identity changed after approval: return the application to review and approve it again" }
  }
  const clientId = application.clientId

  // The terms the documents are rendered from, hashed now: the transaction below refuses if they moved meanwhile.
  const [{ terms: renderedTerms }] = await prisma.$queryRaw<{ terms: string }[]>`SELECT public."loanApplicationTermsSha256ById"(${applicationId}) AS terms`
  const rendered: RenderedLoanDocument[] = []
  for (const kind of LOAN_DOCUMENT_KINDS) {
    rendered.push(await renderLoanDocument({ tenantId, applicationId, kind, staffUserId: staff.id }))
  }
  const stored = await Promise.all(rendered.map(async (doc) => ({ doc, sha: sha256(doc.pdf), file: await saveFile(doc.pdf, "application/pdf") })))

  const issued = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ status: string; signed: Date | null; terms: string }[]>`
      SELECT "status"::text AS status, "agreementSignedAt" AS signed, public."loanApplicationTermsSha256ById"("id") AS terms
      FROM "LoanApplication" WHERE "id" = ${applicationId} AND "tenantId" = ${tenantId} FOR UPDATE`
    if (!locked || locked.status !== "APPROVED" || locked.signed || locked.terms !== renderedTerms) {
      throw new ConcurrentChangeError("The application changed while the documents were being issued; issue them again")
    }
    await requireLivingBorrower(tx, { tenantId, applicationId, clientId, refusal: STAFF_REFUSAL })
    const now = new Date()
    await tx.loanDocumentIssuance.updateMany({ where: { tenantId, applicationId, supersededAt: null }, data: { supersededAt: now } })
    const rows = []
    for (const { doc, sha, file } of stored) {
      const clientDocument = await tx.clientDocument.create({
        data: {
          tenantId, clientId, docType: doc.kind === "LOAN_AGREEMENT" ? "CREDIT_AGREEMENT" : "OTHER",
          fileName: `${LOAN_DOCUMENT_LABELS[doc.kind].toLowerCase().replaceAll(" ", "-")}-${applicationId}.pdf`,
          fileUrl: "", storagePath: file.storagePath, fileSize: file.fileSize, mimeType: "application/pdf",
          uploadedByType: "staff", uploadedById: staff.id, templateId: doc.templateId, generatedFromVersionId: doc.versionId,
          contentSha256: sha, issuedForApplicationId: applicationId, extractionStatus: "skipped", verified: false,
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
  }).catch(async (error: unknown) => {
    // A refused or failed issue leaves no file behind.
    await Promise.all(stored.map(({ file }) => deleteFile(file.storagePath).catch(() => undefined)))
    if (error instanceof ConcurrentChangeError) return error
    if (isDatabaseRefusal(error)) return new ConcurrentChangeError(databaseMessage(error))
    throw error
  })
  if (issued instanceof ConcurrentChangeError) return { ok: false, status: 409, error: issued.message }
  await deliverToBorrower({
    tenantId, clientId, staff, entity: { type: "LoanApplication", id: applicationId }, what: "loan documents",
    operationId: operationIdFor(`loan-documents:${issued.map((r) => r.pdfSha256).join(":")}`),
    subject: `Your loan documents for ${application.reference} are ready`,
    text: `Your offer letter, key facts statement and loan agreement for application ${application.reference} are ready. Sign in to your portal to read and accept them.`,
  })
  return { ok: true, issued }
}

