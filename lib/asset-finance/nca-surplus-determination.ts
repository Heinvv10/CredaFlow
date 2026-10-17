import { logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { safeFileName, type ParsedEntityUpload } from "./entity-document-io"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable } from "./recovery-result"

/** Staff record what the retained credit enquiry/creditor evidence establishes.
 * Missing or inconclusive evidence is not a determination of no other agreement. */
export async function recordSurplusDetermination(actor: RecoveryActor, loanId: string, input: { competingAgreement: boolean; basis: string; upload: ParsedEntityUpload }) {
  if (typeof input.competingAgreement !== "boolean" || input.basis.trim().length < 20 || input.basis.trim().length > 2000) return { kind: "not_ready" as const, reason: "Record an evidenced yes/no determination and its basis in 20 to 2000 characters; unknown cannot be treated as no" }
  const bytes = Buffer.from(await input.upload.file.arrayBuffer())
  const stored = await saveFile(bytes, input.upload.file.type)
  try {
    const result = await refusable(() => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id"=${loanId} AND "tenantId"=${actor.tenantId} FOR UPDATE`
      const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId, ncaRegime: "NCA", contractType: { not: "LOAN" } } })
      if (!loan) return { kind: "not_found" as const }
      if (await tx.ncaSurplusDetermination.count({ where: { tenantId: actor.tenantId, loanId } })) throw new RecoveryRefusal("The evidenced competing-credit determination is already recorded")
      const doc = await tx.entityDocument.create({ data: { tenantId: actor.tenantId, clientId: loan.clientId, entityId: loan.entityId, docType: input.upload.docType, fileName: safeFileName(input.upload.file.name), mimeType: input.upload.file.type, fileSize: stored.fileSize, storagePath: stored.storagePath, contentSha256: sha256DocumentBytes(bytes), uploadedByType: "staff", uploadedById: actor.userId } })
      const row = await tx.ncaSurplusDetermination.create({ data: { tenantId: actor.tenantId, loanId, competingAgreement: input.competingAgreement, basis: input.basis.trim(), evidenceDocumentId: doc.id, recordedById: actor.userId } })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ENTITY_DOCUMENT_UPLOADED", entity: "EntityDocument", entityId: doc.id, newValue: { purpose: "NCA s127(6) competing credit agreement determination", contentSha256: doc.contentSha256 } }, tx)
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_SURPLUS_CREDIT_DETERMINATION_RECORDED", entity: "NcaSurplusDetermination", entityId: row.id, newValue: { loanId, competingAgreement: row.competingAgreement, evidenceDocumentId: doc.id, basis: row.basis } }, tx)
      return { kind: "done" as const, id: row.id }
    }))
    if (result.kind !== "done") await deleteFile(stored.storagePath)
    return result
  } catch (error) { await deleteFile(stored.storagePath); throw error }
}
