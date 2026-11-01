import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { hasClientBorrower } from "@/lib/borrower"
import { staffMessageRefusal } from "@/lib/collections/client-holds"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { section129NoticeDateLabel } from "@/lib/collections/section129-artifact"
import { findLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import type { ArrearsFigures } from "@/lib/documents/tokens"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { loanSettlementFigures, section129NoticeAmounts } from "@/lib/loan/charges-summary"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { deleteFile, saveFile } from "@/lib/storage"
import { sha256Text } from "@/lib/affordability/snapshot"
import { deliverToBorrower, deliverySummary, operationIdFor, type DeliveryLeg } from "./deliver"
import { ConcurrentChangeError, databaseMessage, isDatabaseRefusal } from "./errors"
import { ARREARS_LETTER_TEMPLATE_KEY } from "./keys"
import { currentApprovedTemplate, renderedPdf } from "./render"

export type ArrearsLetterResult =
  | { ok: true; letterId: string; clientDocumentId: string; pdfSha256: string; sample: boolean; templateVersion: number; delivery: DeliveryLeg[]; deliverySummary: string }
  | { ok: false; status: 404 | 409 | 422; error: string }

/**
 * An arrears letter of a key-facts loan: rendered from the current approved version of the lender's own
 * template, on today's figures, from the same settlement calculation a statement prints; stored as the
 * borrower's document, recorded (LoanArrearsLetter, immutable), audited, then sent to the borrower through the
 * collections messaging path. Section 129 is South African law: this is what a key-facts loan has instead, and a South
 * African loan cannot have one (the route answers 409, the database refuses it). The holds of a dunning message apply: a
 * deceased client or one under debt review gets none. The wording is the lender's own, never written here.
 */
export async function issueArrearsLetter(args: {
  tenantId: string
  loanId: string
  staff: { id: string; email: string }
  ipAddress?: string
}): Promise<ArrearsLetterResult> {
  const { tenantId, loanId, staff } = args
  await ensureActiveJurisdiction()
  const loan = await prisma.loan.findUnique({
    where: { id: loanId, tenantId },
    include: { client: true, application: { select: { disclosureRegime: true } }, repaymentSchedule: { orderBy: { dueDate: "asc" } } },
  })
  if (!loan) return { ok: false, status: 404, error: "Loan not found" }
  if (loan.application.disclosureRegime !== "KEY_FACTS") {
    return { ok: false, status: 409, error: "An arrears letter belongs to a key-facts loan. This loan has its Section 129 notice." }
  }
  if (!hasClientBorrower(loan)) return { ok: false, status: 409, error: "This loan's borrower is not a natural person" }
  const eligibility = evaluateCollectionsEligibility(loan, "DUNNING")
  if (!eligibility.eligible) return { ok: false, status: 422, error: `Cannot issue an arrears letter: ${eligibility.reason}.` }
  const client = loan.client
  const refusal = await staffMessageRefusal(prisma, { tenantId, clientId: client.id })
  if (refusal) return { ok: false, status: 409, error: `Cannot issue an arrears letter: ${refusal}.` }

  const now = new Date()
  const amounts = section129NoticeAmounts(loan, await loanSettlementFigures(prisma, loan, now))
  const arrears: ArrearsFigures = {
    arrearsCents: amounts.arrearsAmount, totalOutstandingCents: amounts.totalOutstanding, daysInArrears: loan.daysInArrears, noticeDate: section129NoticeDateLabel(now),
  }
  const { template, version } = await currentApprovedTemplate(tenantId, ARREARS_LETTER_TEMPLATE_KEY)
  const [tenant, config, lender, staffRow] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }),
    findLenderIdentity(tenantId),
    prisma.user.findFirst({ where: { id: staff.id, tenantId } }),
  ])
  const pdf = await renderedPdf(version.bodyHtml, { tenant, lender, client, loan, staff: staffRow, arrears }, config?.isDemoLender === true)
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex")
  const file = await saveFile(pdf, "application/pdf")

  const letter = await prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, loanId)
    const locked = await tx.loan.findUniqueOrThrow({ where: { id: loanId, tenantId } })
    if (locked.arrearsAmount !== loan.arrearsAmount || locked.daysInArrears !== loan.daysInArrears || locked.outstandingPrincipal !== loan.outstandingPrincipal || locked.status !== loan.status) {
      throw new ConcurrentChangeError("The loan changed while the letter was being prepared; issue it again")
    }
    const document = await tx.clientDocument.create({
      data: {
        tenantId, clientId: client.id, docType: "OTHER", fileName: `arrears-letter-${loan.reference}-${sastCalendarDate(now)}.pdf`, fileUrl: "",
        storagePath: file.storagePath, fileSize: file.fileSize, mimeType: "application/pdf", uploadedByType: "staff", uploadedById: staff.id,
        templateId: template.id, generatedFromVersionId: version.id, contentSha256: pdfSha256, extractionStatus: "skipped", verified: false,
      },
    })
    await tx.clientDocument.update({ where: { id: document.id }, data: { fileUrl: `/api/documents/${document.id}/view` } })
    const row = await tx.loanArrearsLetter.create({
      data: {
        tenantId, loanId, templateId: template.id, templateVersionId: version.id, templateVersionNumber: version.version, templateContentSha256: sha256Text(version.bodyHtml),
        clientDocumentId: document.id, pdfSha256, noticeDate: new Date(`${sastCalendarDate(now)}T00:00:00.000Z`),
        arrearsAmount: arrears.arrearsCents, totalOutstanding: arrears.totalOutstandingCents, daysInArrears: arrears.daysInArrears, issuedById: staff.id,
      },
    })
    await tx.documentAccessLog.create({ data: { documentId: document.id, accessorType: "staff", accessorId: staff.id, action: "generated" } })
    await logAuditStrict({
      tenantId, userId: staff.id, userEmail: staff.email, action: AuditAction.ARREARS_LETTER_ISSUED, entity: "Loan", entityId: loanId,
      newValue: { letterId: row.id, pdfSha256, templateVersion: version.version, sample: row.sample, arrearsAmount: arrears.arrearsCents, totalOutstanding: arrears.totalOutstandingCents, daysInArrears: arrears.daysInArrears, noticeDate: sastCalendarDate(now) },
      ipAddress: args.ipAddress,
    }, tx)
    return { id: row.id, sample: row.sample, clientDocumentId: document.id }
  }).catch(async (error: unknown) => {
    // A refused letter leaves no file behind.
    await deleteFile(file.storagePath).catch(() => undefined)
    if (error instanceof ConcurrentChangeError) return error
    if (isDatabaseRefusal(error)) {
      const already = "code" in error && error.code === "P2002"
      return new ConcurrentChangeError(already ? "An arrears letter for this loan was already issued today" : databaseMessage(error))
    }
    throw error
  })
  if (letter instanceof ConcurrentChangeError) return { ok: false, status: 409, error: letter.message }

  const delivery = await deliverToBorrower({
    tenantId, clientId: client.id, staff, entity: { type: "Loan", id: loanId }, what: "arrears letter", category: "arrears_letter",
    operationId: operationIdFor(`arrears-letter:${letter.id}`),
    subject: `Your loan account ${loan.reference} is in arrears`,
    text: `Your loan account ${loan.reference} is in arrears. Your letter is attached and is in your portal.`,
    textWithoutAttachment: `Your loan account ${loan.reference} is in arrears. Your letter is in your portal.`,
    attachments: [{ filename: `arrears-letter-${loan.reference}.pdf`, content: pdf, contentType: "application/pdf" }],
  })
  const summary = deliverySummary(delivery)
  await prisma.loanNote.create({
    data: { tenantId, loanId, type: "arrears_letter", note: `Arrears letter issued from template version ${version.version}. ${summary}.`, documentId: letter.clientDocumentId, createdBy: staff.id },
  })
  return { ok: true, letterId: letter.id, clientDocumentId: letter.clientDocumentId, pdfSha256, sample: letter.sample, templateVersion: version.version, delivery, deliverySummary: summary }
}
