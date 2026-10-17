import { requireNcaSaleWindow } from "./surrender-lifecycle"
import type { RecoveryRoute, SurrenderStatus, ValuationSource } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { dbDate } from "./dates"
import { recordMeterReading } from "./meter-readings"
import { createRecoveryTx, type RecoveryActor } from "./recovery-create"
import { isNcaRoute } from "./recovery-input"
import { advance, RecoveryRefusal, refusable, type RecoveryResult } from "./recovery-result"

// A surrender whose proceeds are credited already has its sale: only an earlier one is linked to a recovery.
const LINKABLE_SURRENDER: SurrenderStatus[] = ["REQUESTED", "VALUED", "VALUATION_NOTICE_ISSUED"]

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export interface StaffRecoveryInput {
  route: RecoveryRoute
  recoveredOn: string
  location: string
  condition: string
  surrenderRequestId?: string | null
  legalMatterId?: string | null
  /** An inspection meter reading (leases only), dated the recovery by default. */
  meterReading?: { value: number; readingDate?: string }
}

/**
 * Staff open a recovery of a loan's asset: a NON_NCA voluntary hand-over, an
 * s127 surrender once the asset is in the yard, or (with the legal matter) an
 * s131 / court-order recovery. The legal agent's ASSET_RECOVERED step goes
 * through createRecoveryTx directly. The route, regime and surrender rules
 * are the database's (guardRecovery).
 */
export async function createRecovery(actor: RecoveryActor, loanId: string, input: StaffRecoveryInput): Promise<RecoveryResult> {
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId, contractType: { not: "LOAN" } }, select: { id: true, ncaRegime: true } })
    if (!loan) return { kind: "not_found" }
    if (input.route === "NCA_S127_SURRENDER") {
      const surrender = input.surrenderRequestId
        ? await tx.surrenderRequest.findFirst({ where: { id: input.surrenderRequestId, tenantId: actor.tenantId, loanId }, select: { status: true } })
        : null
      if (!surrender) return { kind: "not_found" }
      if (!LINKABLE_SURRENDER.includes(surrender.status)) throw new RecoveryRefusal("A recovery links a surrender before its sale proceeds are credited")
    } else if (input.surrenderRequestId) {
      throw new RecoveryRefusal("Only an s127 recovery names a surrender")
    }
    if (input.legalMatterId) {
      const matter = await tx.legalMatter.findFirst({ where: { id: input.legalMatterId, tenantId: actor.tenantId, loanId }, select: { id: true } })
      if (!matter) return { kind: "not_found" }
    }
    let meterReadingId: string | null = null
    if (input.meterReading) {
      const today = sastCalendarDate(new Date())
      const reading = await recordMeterReading(tx, { tenantId: actor.tenantId, userId: actor.userId }, {
        loanId, readingDate: input.meterReading.readingDate ?? input.recoveredOn, value: input.meterReading.value, evidenceDocumentId: null, today,
      })
      if (reading.kind === "not_found") throw new RecoveryRefusal("A meter reading applies to a lease only")
      if (reading.kind === "refused") throw new RecoveryRefusal(reading.error)
      meterReadingId = reading.readingId
    }
    const created = await createRecoveryTx(tx, actor, {
      loanId, route: input.route, recoveredOn: input.recoveredOn, location: input.location, condition: input.condition,
      surrenderRequestId: input.surrenderRequestId, legalMatterId: input.legalMatterId, meterReadingId,
    })
    if (created.kind === "not_ready") throw new RecoveryRefusal(created.reason)
    return created
  }))
}

export interface RecoveryValuationInput { valuedOn: string; source: ValuationSource; valuerName: string; amountCents: number }

/**
 * RECOVERED → VALUED. An s127 recovery reuses its surrender's valuation (the
 * surrender must be valued); every other route records a new valuation of the
 * asset.
 */
export async function recordRecoveryValuation(actor: RecoveryActor, id: string, input: RecoveryValuationInput): Promise<RecoveryResult> {
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { status: true, assetId: true, surrenderRequest: { select: { status: true, valuationId: true } } },
    })
    if (!recovery) return { kind: "not_found" }
    if (recovery.status !== "RECOVERED") throw new RecoveryRefusal("The recovery is not awaiting its valuation")
    let valuationId: string
    let valuerName = ""
    let reused = false
    if (recovery.surrenderRequest) {
      if (!recovery.surrenderRequest.valuationId) throw new RecoveryRefusal("Record the surrender's valuation first: an s127 recovery reuses it")
      valuationId = recovery.surrenderRequest.valuationId
      reused = true
    } else {
      valuerName = input.valuerName.trim()
      if (!ISO_DAY.test(input.valuedOn) || !valuerName || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
        throw new RecoveryRefusal("Provide a valid date, valuer and positive valuation in cents")
      }
      valuationId = (await tx.assetValuation.create({ data: {
        tenantId: actor.tenantId, assetId: recovery.assetId, valuedOn: dbDate(input.valuedOn), source: input.source,
        valuerName, amountCents: input.amountCents, createdById: actor.userId,
      } })).id
    }
    await advance(tx, actor, id, "RECOVERED", { status: "VALUED", valuationId })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_VALUED, entity: "Recovery", entityId: id,
      newValue: reused ? { valuationId, reusedFromSurrender: true } : { valuationId, valuedOn: input.valuedOn, source: input.source, valuerName, amountCents: input.amountCents },
    }, tx)
    return { kind: "done", id }
  }))
}

/** NCA: VALUATION_NOTICE_ISSUED → LISTED. NON_NCA: VALUED → LISTED. */
export async function listForSale(actor: RecoveryActor, id: string): Promise<RecoveryResult> {
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true, route: true } })
    if (!recovery) return { kind: "not_found" }
    const nca = isNcaRoute(recovery.route)
    const from = nca ? "VALUATION_NOTICE_ISSUED" : "VALUED"
    if (recovery.status !== from) throw new RecoveryRefusal(nca ? "An NCA recovery is listed after its valuation notice" : "A recovery is listed once it is valued")
    await requireNcaSaleWindow(tx, actor.tenantId, id, "recovery")
    await advance(tx, actor, id, from, { status: "LISTED" })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_LISTED, entity: "Recovery", entityId: id, newValue: { route: recovery.route },
    }, tx)
    return { kind: "done", id }
  }))
}

/** Any status before the sale → WITHDRAWN; the database frees the asset. */
export async function withdrawRecovery(actor: RecoveryActor, id: string, reason: string): Promise<RecoveryResult> {
  const withdrawnReason = reason.trim()
  if (withdrawnReason.length < 10 || withdrawnReason.length > 1_000) return { kind: "not_ready", reason: "Give the reason for the withdrawal in 10 to 1000 characters" }
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true } })
    if (!recovery) return { kind: "not_found" }
    await advance(tx, actor, id, recovery.status, { status: "WITHDRAWN", withdrawnReason, closedAt: new Date() })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_WITHDRAWN, entity: "Recovery", entityId: id, newValue: { fromStatus: recovery.status, reason: withdrawnReason },
    }, tx)
    return { kind: "done", id }
  }))
}

/** SHORTFALL_OPEN → CLOSED, once the loan is settled or written off (SURPLUS_HELD closes with the refund release). */
export async function closeRecovery(actor: RecoveryActor, id: string): Promise<RecoveryResult> {
  return refusable(() => prisma.$transaction(async (tx): Promise<RecoveryResult> => {
    const recovery = await tx.recovery.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true, shortfallCents: true, loan: { select: { status: true } } } })
    if (!recovery) return { kind: "not_found" }
    if (recovery.status !== "SHORTFALL_OPEN") throw new RecoveryRefusal("Only a recovery with an open shortfall is closed here")
    if (recovery.loan.status !== "COMPLETED" && recovery.loan.status !== "WRITTEN_OFF") throw new RecoveryRefusal("A shortfall closes when the loan is settled or written off")
    await advance(tx, actor, id, "SHORTFALL_OPEN", { status: "CLOSED", closedAt: new Date() })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_CLOSED, entity: "Recovery", entityId: id,
      newValue: { loanStatus: recovery.loan.status, shortfallCents: recovery.shortfallCents },
    }, tx)
    return { kind: "done", id }
  }))
}
