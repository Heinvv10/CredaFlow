import type { RecoveryCostTreatment, RecoveryCostType } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import { dbDate } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { isNcaRoute } from "./recovery-input"
import { RecoveryRefusal, refusable, type RecoveryResult } from "./recovery-result"
import type { SigningTx } from "./signing-prepare"

export interface RecoveryCostInput {
  type: RecoveryCostType
  netCents: number
  vatCents: number
  supplierId?: string | null
  supplierInvoiceRef: string
  incurredOn: string
  treatment: RecoveryCostTreatment
  legalStepId?: string | null
  note?: string | null
}

/** The database's sentence (guardRecoveryCost) for a taxed legal cost without an evidenced judgment or settlement step. */
export const TAXED_LEGAL_NEEDS_EVIDENCED_STEP = "Taxed legal costs name the evidenced judgment or settlement step of the legal matter"

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Records one supplier cost against a recovery, PENDING: the actor is the
 * recorder. A different person decides it (decideRecoveryCost); proceeds are
 * applied only once every cost is decided. The allow-lists by route and
 * treatment, the legal-step rule and "before the proceeds are applied" are the
 * database's (guardRecoveryCost); VAT is checked here against the rate in force
 * on the incurred date for a VAT-vendor supplier, and must be nil for any other
 * supplier.
 * UNTESTED: legal|tax sign-off on the cost treatment and the input-tax position.
 */
export async function recordRecoveryCost(actor: RecoveryActor, recoveryId: string, input: RecoveryCostInput): Promise<RecoveryResult> {
  const ref = input.supplierInvoiceRef.trim()
  const note = input.note?.trim() || null
  if (!Number.isSafeInteger(input.netCents) || input.netCents < 0 || !Number.isSafeInteger(input.vatCents) || input.vatCents < 0 || input.netCents + input.vatCents <= 0) {
    return { kind: "not_ready", reason: "Provide the net and VAT as non-negative whole cents, summing to more than nil" }
  }
  if (!ref || ref.length > 100 || !ISO_DAY.test(input.incurredOn) || (note?.length ?? 0) > 500) {
    return { kind: "not_ready", reason: "Provide the supplier's invoice reference, the date incurred and a note of at most 500 characters" }
  }
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { route: true } })
    if (!recovery) return { kind: "not_found" }
    // NCA: a taxed legal cost follows an uncorrected judgment or settlement that carries its legal document.
    if (input.type === "LEGAL_TAXED" && isNcaRoute(recovery.route)) {
      const step = input.legalStepId
        ? await tx.legalMatterStep.findFirst({ where: { id: input.legalStepId, tenantId: actor.tenantId, kind: { in: ["JUDGMENT", "SETTLED"] }, evidenceDocumentId: { not: null } }, select: { id: true } })
        : null
      const corrected = step ? await tx.legalMatterStep.count({ where: { tenantId: actor.tenantId, correctsStepId: step.id } }) : 0
      if (!step || corrected > 0) throw new RecoveryRefusal(TAXED_LEGAL_NEEDS_EVIDENCED_STEP)
    }
    let vendor = false
    if (input.supplierId) {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: actor.tenantId }, select: { vatNumber: true } })
      if (!supplier) return { kind: "not_found" }
      vendor = !!supplier.vatNumber?.trim()
    }
    if (vendor) {
      const rate = await loadRateOn(tx, input.incurredOn).catch((error: unknown) => {
        if (error instanceof NoVatRateError) throw new RecoveryRefusal(error.message)
        throw error
      })
      const expected = vatOnExclusive(input.netCents, rate.rateTenThousandths)
      if (input.vatCents !== expected) throw new RecoveryRefusal(`VAT on ${input.incurredOn} is the net times ${rate.rate}, half-up: ${expected} cents`)
    } else if (input.vatCents !== 0) {
      throw new RecoveryRefusal("Only a VAT-vendor supplier charges VAT: record a supplier with a VAT number, or nil VAT")
    }
    const cost = await tx.recoveryCost.create({ data: {
      tenantId: actor.tenantId, recoveryId, type: input.type, netCents: input.netCents, vatCents: input.vatCents, grossCents: input.netCents + input.vatCents,
      supplierId: input.supplierId ?? null, supplierInvoiceRef: ref, incurredOn: dbDate(input.incurredOn), treatment: input.treatment,
      legalStepId: input.legalStepId ?? null, note, recordedById: actor.userId,
    } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_COST_RECORDED, entity: "Recovery", entityId: recoveryId,
      newValue: { costId: cost.id, type: input.type, netCents: input.netCents, vatCents: input.vatCents, grossCents: cost.grossCents, treatment: input.treatment,
        supplierId: input.supplierId ?? null, supplierInvoiceRef: ref, incurredOn: input.incurredOn, legalStepId: input.legalStepId ?? null,
        recordedById: actor.userId, status: "PENDING" },
    }, tx)
    return { kind: "done", id: cost.id }
  }))
}

/**
 * Once the sale is completed, approving a cost to be deducted from its proceeds must leave
 * the net proceeds above nil: the deducted costs stay below the sale price.
 */
async function requireProceedsLeft(tx: SigningTx, tenantId: string, recoveryId: string, addedCents: number): Promise<void> {
  const sale = await tx.remarketingSale.findFirst({ where: { tenantId, recoveryId, status: "COMPLETED" }, select: { priceInclVatCents: true } })
  if (!sale) return
  const deducted = await tx.recoveryCost.aggregate({ where: { tenantId, recoveryId, status: "APPROVED", treatment: "DEDUCT_FROM_PROCEEDS" }, _sum: { grossCents: true } })
  if ((deducted._sum.grossCents ?? 0) + addedCents >= sale.priceInclVatCents) {
    throw new RecoveryRefusal("Approving this cost would deduct the whole sale price from the proceeds: nothing would be left to apply")
  }
}

/**
 * The one decision on a PENDING cost, by someone other than its recorder
 * (decide_asset_finance at the route): APPROVED costs count in the proceeds and
 * on the notices, REJECTED ones stay on the ledger for the record. The
 * recorder rule is checked here and again by the database.
 */
export async function decideRecoveryCost(actor: RecoveryActor, recoveryId: string, costId: string, decision: "APPROVED" | "REJECTED"): Promise<RecoveryResult> {
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const cost = await tx.recoveryCost.findFirst({ where: { id: costId, recoveryId, tenantId: actor.tenantId }, select: { status: true, recordedById: true, type: true, grossCents: true, treatment: true } })
    if (!cost) return { kind: "not_found" }
    if (decision === "APPROVED" && cost.treatment === "DEDUCT_FROM_PROCEEDS") await requireProceedsLeft(tx, actor.tenantId, recoveryId, cost.grossCents)
    if (cost.status !== "PENDING") throw new RecoveryRefusal("This cost has already been decided")
    if (cost.recordedById === actor.userId) throw new RecoveryRefusal("A cost is decided by someone other than the person who recorded it")
    const approvedAt = new Date()
    const result = await tx.recoveryCost.updateMany({ where: { id: costId, tenantId: actor.tenantId, status: "PENDING" }, data: { status: decision, approvedById: actor.userId, approvedAt } })
    if (result.count !== 1) throw new RecoveryRefusal("This cost has already been decided")
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_COST_DECIDED, entity: "Recovery", entityId: recoveryId,
      newValue: { costId, decision, type: cost.type, grossCents: cost.grossCents, treatment: cost.treatment, recordedById: cost.recordedById, approvedById: actor.userId },
    }, tx)
    return { kind: "done", id: costId }
  }))
}
