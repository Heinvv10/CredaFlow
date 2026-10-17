import { logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { dbDate } from "./dates"
import { parseEntityDocumentForm, safeFileName, type ParsedEntityUpload } from "./entity-document-io"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable } from "./recovery-result"

export async function parseSurplusExecutionForm(req: Request) {
  const parsed = await parseEntityDocumentForm(req.clone(), ["BANK_STATEMENT", "OTHER"], { allowDeal: false })
  if ("error" in parsed) return { ok: false as const, error: parsed.error }
  const form = await req.formData()
  const bankReference = String(form.get("bankReference") ?? "").trim()
  const executedOn = String(form.get("executedOn") ?? "")
  const amount = String(form.get("amountCents") ?? "")
  if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) <= 0) return { ok: false as const, error: "Exact positive amountCents is required" }
  if (bankReference.length < 6 || bankReference.length > 200) return { ok: false as const, error: "Bank reference must contain 6 to 200 characters" }
  try { dbDate(executedOn) } catch { return { ok: false as const, error: "A valid execution date is required" } }
  return { ok: true as const, bankReference, executedOn, amountCents: Number(amount), upload: parsed.upload }
}

/** Records an already executed bank payment. This never initiates a transfer. */
export async function recordSurplusExecution(actor: RecoveryActor, loanId: string, instructionId: string, input: { executedOn: string; bankReference: string; amountCents: number; upload: ParsedEntityUpload }) {
  const bytes = Buffer.from(await input.upload.file.arrayBuffer())
  const stored = await saveFile(bytes, input.upload.file.type)
  try {
    const result = await refusable(() => prisma.$transaction(async (tx) => {
      // Same loan-before-instruction lock order as final notice issuance.
      await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id"=${loanId} AND "tenantId"=${actor.tenantId} FOR UPDATE`
      const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId, ncaRegime: "NCA", contractType: { not: "LOAN" } } })
      const row = await tx.ncaSurplusRemittance.findFirst({ where: { id: instructionId, tenantId: actor.tenantId, OR: [{ surrender: { loanId } }, { recovery: { loanId } }] }, include: { surrender: true, recovery: true } })
      if (!loan || !row) return { kind: "not_found" as const }
      const parent = row.surrender ?? row.recovery
      if (row.status !== "INSTRUCTED" || row.executedOn || parent?.status !== "FINAL_NOTICE_ISSUED" || !parent.finalNoticePath) throw new RecoveryRefusal("An unpaid instruction and issued final notice are required; execution is recorded once")
      if (input.amountCents !== row.amountCents) throw new RecoveryRefusal("Bank execution must equal the exact instructed surplus")
      const document = await tx.entityDocument.create({ data: { tenantId: actor.tenantId, clientId: loan.clientId, entityId: loan.entityId,
        docType: input.upload.docType, fileName: safeFileName(input.upload.file.name), mimeType: input.upload.file.type, fileSize: stored.fileSize,
        storagePath: stored.storagePath, contentSha256: sha256DocumentBytes(bytes), uploadedByType: "staff", uploadedById: actor.userId } })
      await tx.ncaSurplusRemittance.update({ where: { id: row.id, tenantId: actor.tenantId }, data: { executedOn: dbDate(input.executedOn), bankExecutionReference: input.bankReference.trim(), executionEvidenceDocumentId: document.id, executedById: actor.userId, executionRecordedAt: new Date() } })
      const recovery = row.recovery ?? await tx.recovery.findFirst({ where: { tenantId: actor.tenantId, surrenderRequestId: row.surrenderId ?? "", status: "SURPLUS_HELD" } })
      if (recovery?.status === "SURPLUS_HELD") {
        await tx.recovery.update({ where: { id: recovery.id, tenantId: actor.tenantId }, data: { status: "CLOSED", closedAt: new Date() } })
        await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_RECOVERY_CLOSED", entity: "Recovery", entityId: recovery.id, newValue: { reason: "Surplus bank execution evidenced", instructionId: row.id } }, tx)
      }
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ENTITY_DOCUMENT_UPLOADED", entity: "EntityDocument", entityId: document.id, newValue: { purpose: "NCA surplus bank execution", contentSha256: document.contentSha256 } }, tx)
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_SURPLUS_EXECUTION_RECORDED", entity: "NcaSurplusRemittance", entityId: row.id, newValue: { loanId, amountCents: row.amountCents, executedOn: input.executedOn, evidenceDocumentId: document.id, bankTransferInitiated: false } }, tx)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return { kind: "done" as const, id: row.id }
    }))
    if (result.kind !== "done") await deleteFile(stored.storagePath)
    return result
  } catch (error) { await deleteFile(stored.storagePath); throw error }
}
