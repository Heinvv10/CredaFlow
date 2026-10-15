import type { RecoveryCostTreatment, RecoveryCostType } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { canDo } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import { dbDate } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable, type RecoveryResult } from "./recovery-result"

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
  /** The staff member who captured the invoice; the approving actor must be someone else. */
  recordedById: string
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Records one supplier cost against a recovery. A cost row is immutable and
 * the database demands two different people on it (recordedById <>
 * approvedById), so there is no pending state: the actor is the APPROVER
 * (decide_asset_finance) and names the staff member who captured the invoice.
 * The allow-lists by route and treatment, the legal-step rule and "before the
 * proceeds are applied" are the database's (guardRecoveryCost); VAT is checked
 * here against the rate in force on the incurred date for a VAT-vendor
 * supplier, and must be nil for any other supplier.
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
  if (input.recordedById === actor.userId) return { kind: "not_ready", reason: "A cost is approved by someone other than the person who recorded it" }
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { id: true } })
    if (!recovery) return { kind: "not_found" }
    const recorder = await tx.user.findFirst({ where: { id: input.recordedById, tenantId: actor.tenantId, active: true }, select: { role: true } })
    if (!recorder || !canDo(recorder.role, "manage_asset_finance")) throw new RecoveryRefusal("The recorder must be an active staff member who manages asset finance")
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
      legalStepId: input.legalStepId ?? null, note, recordedById: input.recordedById, approvedById: actor.userId,
    } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_COST_RECORDED, entity: "Recovery", entityId: recoveryId,
      newValue: { costId: cost.id, type: input.type, netCents: input.netCents, vatCents: input.vatCents, grossCents: cost.grossCents, treatment: input.treatment,
        supplierId: input.supplierId ?? null, supplierInvoiceRef: ref, incurredOn: input.incurredOn, legalStepId: input.legalStepId ?? null,
        recordedById: input.recordedById, approvedById: actor.userId },
    }, tx)
    return { kind: "done", id: cost.id }
  }))
}
