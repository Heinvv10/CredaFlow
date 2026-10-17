import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { safeFileName, type ParsedEntityUpload } from "./entity-document-io"
import type { RecoveryActor } from "./recovery-create"
import { advance, RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"
import type { SigningTx } from "./signing-prepare"
import type { BankAccountFields } from "./supplier-input"

export type RefundDone = { kind: "done"; id: string; amountCents: number }

// The surplus refund: the whole surplus of a SURPLUS_HELD recovery goes back
// to the debtor, bank details evidenced by an uploaded confirmation, created by
// one person, approved by another and released (which closes the recovery) by
// a LOAN_ADMIN. The database repeats the amount, the two-person rule and the
// SURPLUS_HELD -> CLOSED step (guardRecoveryRefund). The account number is
// never written to the audit log or returned in a response.
// Refunding the surplus to the debtor is signed off by the lender's legal team, 2026-10-17.

/**
 * A refund moves only while the proceeds stand: the proceeds receipt is not reversed
 * and the loan is settled (a reversal reopens the loan, so the surplus is no longer one).
 * Checked at each step; the database repeats it.
 */
async function requireStandingProceeds(tx: SigningTx, tenantId: string, recoveryId: string): Promise<void> {
  const recovery = await tx.recovery.findFirst({
    where: { id: recoveryId, tenantId }, select: { proceedsPayment: { select: { reversed: true } }, loan: { select: { status: true } } },
  })
  if (recovery?.proceedsPayment?.reversed) throw new RecoveryRefusal("The proceeds receipt was reversed: the surplus is no longer held")
  if (recovery?.loan.status !== "COMPLETED") throw new RecoveryRefusal("A surplus is refunded once the loan is settled")
}

const actorAudit = (actor: RecoveryActor) => ({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined })

export async function createRefund(actor: RecoveryActor, recoveryId: string, input: { bank: BankAccountFields; upload: ParsedEntityUpload }): Promise<NotFound | NotReady | RefundDone> {
  const buffer = Buffer.from(await input.upload.file.arrayBuffer())
  const stored = await saveFile(buffer, input.upload.file.type)
  const contentSha256 = sha256DocumentBytes(buffer)
  let result: NotFound | NotReady | RefundDone
  try {
    result = await refusable(() => prisma.$transaction(async (tx): Promise<NotFound | RefundDone> => {
      const recovery = await tx.recovery.findFirst({
        where: { id: recoveryId, tenantId: actor.tenantId },
        select: { id: true, status: true, surplusCents: true, loan: { select: { clientId: true, entityId: true } } },
      })
      if (!recovery) return { kind: "not_found" }
      if (recovery.status !== "SURPLUS_HELD" || !recovery.surplusCents) throw new RecoveryRefusal("A refund is created for a recovery that holds a surplus")
      await requireStandingProceeds(tx, actor.tenantId, recoveryId)
      if (await tx.recoveryRefund.count({ where: { tenantId: actor.tenantId, recoveryId } }) > 0) throw new RecoveryRefusal("The surplus already has a refund")
      const document = await tx.entityDocument.create({ data: {
        tenantId: actor.tenantId, entityId: recovery.loan.entityId, clientId: recovery.loan.clientId, docType: input.upload.docType,
        fileName: safeFileName(input.upload.file.name), mimeType: input.upload.file.type, fileSize: stored.fileSize,
        storagePath: stored.storagePath, contentSha256, uploadedByType: "staff", uploadedById: actor.userId,
      } })
      const refund = await tx.recoveryRefund.create({ data: {
        tenantId: actor.tenantId, recoveryId, amountCents: recovery.surplusCents, accountHolder: input.bank.accountHolder, bankName: input.bank.bankName,
        branchCode: input.bank.branchCode, accountNumber: input.bank.accountNumber, bankVerifiedById: actor.userId, bankVerificationDocumentId: document.id,
        createdById: actor.userId,
      } })
      await logAuditStrict({
        ...actorAudit(actor), action: AuditAction.ENTITY_DOCUMENT_UPLOADED, entity: "Recovery", entityId: recoveryId,
        newValue: { documentId: document.id, docType: input.upload.docType, contentSha256, purpose: "surplus refund bank verification" },
      }, tx)
      await logAuditStrict({
        ...actorAudit(actor), action: AuditAction.ASSET_RECOVERY_REFUND_CREATED, entity: "RecoveryRefund", entityId: refund.id,
        newValue: { recoveryId, amountCents: refund.amountCents, bankVerificationDocumentId: document.id },
      }, tx)
      return { kind: "done", id: refund.id, amountCents: refund.amountCents }
    }))
  } catch (error) {
    await deleteFile(stored.storagePath)
    throw error
  }
  if (result.kind !== "done") await deleteFile(stored.storagePath)
  return result
}

export async function approveRefund(actor: RecoveryActor, recoveryId: string): Promise<NotFound | NotReady | RefundDone> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | RefundDone> => {
    const refund = await tx.recoveryRefund.findFirst({ where: { recoveryId, tenantId: actor.tenantId } })
    if (!refund) return { kind: "not_found" }
    if (refund.status !== "PENDING_APPROVAL") throw new RecoveryRefusal(`The refund is already ${refund.status.toLowerCase().replace("_", " ")}`)
    if (refund.createdById === actor.userId) throw new RecoveryRefusal("A refund is approved by someone other than the person who created it")
    await requireStandingProceeds(tx, actor.tenantId, recoveryId)
    await tx.recoveryRefund.update({ where: { id: refund.id, tenantId: actor.tenantId }, data: { status: "APPROVED", approvedById: actor.userId } })
    await logAuditStrict({
      ...actorAudit(actor), action: AuditAction.ASSET_RECOVERY_REFUND_APPROVED, entity: "RecoveryRefund", entityId: refund.id,
      newValue: { recoveryId, amountCents: refund.amountCents, createdById: refund.createdById },
    }, tx)
    return { kind: "done", id: refund.id, amountCents: refund.amountCents }
  }))
}

export async function releaseRefund(actor: RecoveryActor, recoveryId: string): Promise<NotFound | NotReady | RefundDone> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | RefundDone> => {
    const refund = await tx.recoveryRefund.findFirst({ where: { recoveryId, tenantId: actor.tenantId } })
    if (!refund) return { kind: "not_found" }
    if (refund.status !== "APPROVED") throw new RecoveryRefusal("A refund is released once it is approved, and once")
    if (refund.approvedById === actor.userId || refund.createdById === actor.userId) {
      throw new RecoveryRefusal("A refund is released by someone other than the people who created and approved it")
    }
    await requireStandingProceeds(tx, actor.tenantId, recoveryId)
    const releasedAt = new Date()
    await tx.recoveryRefund.update({ where: { id: refund.id, tenantId: actor.tenantId }, data: { status: "RELEASED", releasedById: actor.userId, releasedAt } })
    await advance(tx, actor, recoveryId, "SURPLUS_HELD", { status: "CLOSED", closedAt: releasedAt })
    await logAuditStrict({
      ...actorAudit(actor), action: AuditAction.ASSET_RECOVERY_REFUND_RELEASED, entity: "RecoveryRefund", entityId: refund.id,
      newValue: { recoveryId, amountCents: refund.amountCents },
    }, tx)
    await logAuditStrict({ ...actorAudit(actor), action: AuditAction.ASSET_RECOVERY_CLOSED, entity: "Recovery", entityId: recoveryId, newValue: { reason: "surplus refunded" } }, tx)
    return { kind: "done", id: refund.id, amountCents: refund.amountCents }
  }))
}
