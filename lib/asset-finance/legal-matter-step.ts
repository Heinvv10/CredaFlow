import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { dbDate } from "./dates"
import { safeFileName } from "./entity-document-io"
import { attorneyAppointer, notifyNextLegalStep } from "./legal-matter-bell"
import { LegalRefusal, refusing, type Refused } from "./legal-matter-guard"
import type { LegalStepInput } from "./legal-matter-input"
import { closeLegalMatterTx, type LegalActor } from "./legal-matter-store"
import { createRecoveryTx } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"

export type StepResult = { kind: "not_found" } | Refused | { kind: "done"; id: string; recoveryId: string | null; closed: boolean }

/**
 * Append a step to an open matter. The evidence file, the step, the Recovery
 * an ASSET_RECOVERED step opens, a settled/withdrawn closure, the audit rows
 * and the bell items commit together; the database guard (guardLegalMatterStep)
 * refuses a step out of order and that refusal comes back as `not_ready` with
 * its own sentence.
 * The step order and the recovery routes are signed off by the lender's legal team, 2026-10-17.
 */
export async function recordLegalStep(actor: LegalActor, matterId: string, input: LegalStepInput): Promise<StepResult> {
  const bytes = input.evidence ? Buffer.from(await input.evidence.file.arrayBuffer()) : null
  const stored = input.evidence && bytes ? { ...await saveFile(bytes, input.evidence.file.type), contentSha256: sha256DocumentBytes(bytes) } : null
  let committed = false
  try {
    const result = await refusing<StepResult>(() => prisma.$transaction(async (tx) => {
      const found = await tx.legalMatter.findFirst({ where: { id: matterId, tenantId: actor.tenantId }, select: { loanId: true } })
      if (!found) return { kind: "not_found" }
      await lockLoanForUpdate(tx, found.loanId)
      const matter = await tx.legalMatter.findFirst({ where: { id: matterId, tenantId: actor.tenantId } })
      if (!matter) return { kind: "not_found" }
      if (matter.status !== "OPEN") throw new LegalRefusal("A step is recorded on an open legal matter")
      const loan = await tx.loan.findFirst({ where: { id: matter.loanId, tenantId: actor.tenantId }, select: { id: true, reference: true, ncaRegime: true, clientId: true, entityId: true } })
      if (!loan) return { kind: "not_found" }
      if (input.section129RecordId && !input.correctsStepId && await tx.legalMatterStep.count({
        where: { tenantId: actor.tenantId, section129RecordId: input.section129RecordId, correctsStepId: null },
      }) > 0) throw new LegalRefusal("That section 129 notice record already backs a step; only a correction may name it again")
      if (input.kind === "ASSET_RECOVERED" && await tx.recovery.count({
        where: { tenantId: actor.tenantId, loanId: loan.id, status: { notIn: ["CLOSED", "WITHDRAWN"] } },
      }) > 0) throw new LegalRefusal("The loan already has an open recovery")
      const evidenceDocumentId = input.evidence && stored ? await createEvidence(tx, actor, loan, input.evidence.file, stored) : null
      const step = await tx.legalMatterStep.create({ data: {
        tenantId: actor.tenantId, matterId, kind: input.kind, stepDate: dbDate(input.stepDate), note: input.note,
        section129RecordId: input.section129RecordId, correctsStepId: input.correctsStepId, evidenceDocumentId, recordedById: actor.userId,
      } })
      let recoveryId: string | null = null
      if (input.kind === "ASSET_RECOVERED" && input.recovery) {
        // Signed off by the lender's legal team, 2026-10-17. An NCA loan recovers under s131 (needs the attachment order), a NON_NCA one on a court order (needs the judgment).
        const created = await createRecoveryTx(tx, actor, {
          loanId: loan.id, route: loan.ncaRegime === "NCA" ? "NCA_S131_ATTACHMENT" : "NON_NCA_COURT_ORDER", recoveredOn: input.stepDate,
          location: input.recovery.location, condition: input.recovery.condition, legalMatterId: matterId,
        })
        if (created.kind === "not_found") return { kind: "not_found" }
        if (created.kind === "not_ready") throw new LegalRefusal(created.reason)
        recoveryId = created.id
      }
      const closed = input.closeMatter
      if (closed) await closeLegalMatterTx(tx, actor, matterId, input.kind)
      await logAuditStrict({
        tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.LEGAL_MATTER_STEP_RECORDED,
        entity: "LegalMatter", entityId: matterId,
        newValue: { stepId: step.id, loanId: loan.id, kind: input.kind, stepDate: input.stepDate, section129RecordId: input.section129RecordId,
          correctsStepId: input.correctsStepId, evidenceDocumentId, recoveryId, closedMatter: closed },
      }, tx)
      await notifyNextLegalStep(tx, {
        tenantId: actor.tenantId, matterId, loanReference: loan.reference, regime: loan.ncaRegime,
        recipients: [matter.createdById, await attorneyAppointer(tx, actor.tenantId, matterId)],
      })
      return { kind: "done", id: step.id, recoveryId, closed }
    }), "The legal matter changed; reload it and try again")
    committed = result.kind === "done"
    return result
  } finally {
    if (stored && !committed) await deleteFile(stored.storagePath)
  }
}

/** The evidence row: on the loan's deal when it has one, and always on its borrower (client or entity). */
async function createEvidence(
  tx: SigningTx, actor: LegalActor, loan: { id: string; clientId: string | null; entityId: string | null }, file: File,
  stored: { storagePath: string; fileSize: number; contentSha256: string },
): Promise<string> {
  const deal = await tx.assetFinanceDeal.findFirst({ where: { tenantId: actor.tenantId, loanId: loan.id }, select: { id: true } })
  const created = await tx.entityDocument.create({ data: {
    tenantId: actor.tenantId, clientId: loan.entityId ? null : loan.clientId, entityId: loan.entityId, dealId: deal?.id ?? null, docType: "LEGAL_DOCUMENT",
    fileName: safeFileName(file.name), mimeType: file.type, fileSize: stored.fileSize, storagePath: stored.storagePath,
    contentSha256: stored.contentSha256, uploadedByType: "staff", uploadedById: actor.userId,
  }, select: { id: true } })
  await logAuditStrict({
    tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.ENTITY_DOCUMENT_UPLOADED,
    entity: "EntityDocument", entityId: created.id, newValue: { docType: "LEGAL_DOCUMENT", contentSha256: stored.contentSha256, loanId: loan.id },
  }, tx)
  return created.id
}
