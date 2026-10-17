import { logAuditStrict } from "@/lib/audit"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { safeFileName, type ParsedEntityUpload } from "./entity-document-io"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable } from "./recovery-result"
import type { BankAccountFields } from "./supplier-input"


export async function recordSurplusAccount(actor: RecoveryActor, loanId: string, input: { bank: BankAccountFields; upload: ParsedEntityUpload }) {
  const bytes = Buffer.from(await input.upload.file.arrayBuffer())
  const stored = await saveFile(bytes, input.upload.file.type)
  try {
    const result = await refusable(() => prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId, ncaRegime: "NCA", contractType: { not: "LOAN" } } })
      if (!loan) return { kind: "not_found" as const }
      const document = await tx.entityDocument.create({ data: { tenantId: actor.tenantId, clientId: loan.clientId, entityId: loan.entityId,
        docType: input.upload.docType, fileName: safeFileName(input.upload.file.name), mimeType: input.upload.file.type, fileSize: stored.fileSize,
        storagePath: stored.storagePath, contentSha256: sha256DocumentBytes(bytes), uploadedByType: "staff", uploadedById: actor.userId,
      } })
      const row = await tx.ncaSurplusAccount.create({ data: { tenantId: actor.tenantId, loanId, accountHolder: input.bank.accountHolder, bankName: input.bank.bankName, branchCode: input.bank.branchCode, accountNumber: input.bank.accountNumber, evidenceDocumentId: document.id, createdById: actor.userId } })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ENTITY_DOCUMENT_UPLOADED", entity: "EntityDocument", entityId: document.id, newValue: { purpose: "NCA surplus bank confirmation", contentSha256: document.contentSha256 } }, tx)
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_SURPLUS_ACCOUNT_RECORDED", entity: "NcaSurplusAccount", entityId: row.id, newValue: { loanId, evidenceDocumentId: document.id } }, tx)
      return { kind: "done" as const, id: row.id }
    }))
    if (result.kind !== "done") await deleteFile(stored.storagePath)
    return result
  } catch (error) { await deleteFile(stored.storagePath); throw error }
}

export async function approveSurplusAccount(actor: RecoveryActor, loanId: string, action: "approve" | "authorise") {
  return refusable(() => prisma.$transaction(async (tx) => {
    const row = await tx.ncaSurplusAccount.findFirst({ where: { tenantId: actor.tenantId, loanId } })
    if (!row) return { kind: "not_found" as const }
    if (row.createdById === actor.userId || (action === "authorise" && row.approvedById === actor.userId)) throw new RecoveryRefusal("Verification and release need staff other than the account preparer and each other")
    if (action === "approve" ? Boolean(row.approvedById) : !row.approvedById || Boolean(row.releaseAuthorisedById)) throw new RecoveryRefusal("The account is not ready for this approval step")
    await tx.ncaSurplusAccount.update({ where: { id: row.id, tenantId: actor.tenantId }, data: action === "approve" ? { approvedById: actor.userId } : { releaseAuthorisedById: actor.userId } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_SURPLUS_ACCOUNT_APPROVED", entity: "NcaSurplusAccount", entityId: row.id, newValue: { loanId, step: action } }, tx)
    return { kind: "done" as const, id: row.id }
  }))
}
