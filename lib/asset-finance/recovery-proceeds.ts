import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, PaymentApplicationError, type PaymentDb } from "@/lib/loan/apply-payment"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { recoveryChargeFreeze } from "./recovery-deadline"
import { costTotals, recoveryOutcome } from "./recovery-outcome"
import { advance, RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"
import type { SigningTx } from "./signing-prepare"

export interface ProceedsInput { receivedAt: Date }
export type ProceedsApplied = {
  kind: "done"; id: string; paymentId: string | null; paymentCents: number; shortfallCents: number; surplusCents: number; replay: boolean
}

// Applying a sold recovery's proceeds, in ONE transaction with the receipt:
//   net      = sale price - costs deducted from the proceeds
//   payment  = min(net, the loan's settlement at the receipt date), a real Payment
//              through applyManualReceipt (key asset-recovery:<id>:proceeds)
//   shortfall / surplus = the gap either way between net and settlement + charged costs
// The figures, the payment and the charge-freeze start are written once
// (guardRecovery); a NON_NCA recovery also gets its freeze end now, an NCA one
// when the final notice is issued. An s127 recovery moves its surrender to
// PROCEEDS_CREDITED, whose receipt check wants the exact receipt, not the
// gross sale price. Repeating the call answers with the recorded result.
// UNTESTED: legal | the order of application and the cost treatment need the lender's legal sign-off.

const idempotencyKey = (recoveryId: string) => `asset-recovery:${recoveryId}:proceeds`
const lockRecovery = (tx: SigningTx, id: string) => tx.$queryRaw`SELECT 1 FROM "Recovery" WHERE id = ${id} FOR UPDATE`

export async function applySaleProceeds(actor: RecoveryActor, recoveryId: string, input: ProceedsInput): Promise<NotFound | NotReady | ProceedsApplied> {
  if (!Number.isFinite(input.receivedAt.getTime())) return { kind: "not_ready", reason: "Provide a valid receivedAt" }
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | ProceedsApplied> => {
    await lockRecovery(tx, recoveryId)
    const recovery = await tx.recovery.findFirst({
      where: { id: recoveryId, tenantId: actor.tenantId },
      include: {
        costs: { select: { grossCents: true, treatment: true } },
        sales: { where: { status: "COMPLETED" }, select: { id: true, priceInclVatCents: true } },
        loan: { include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } },
        surrenderRequest: { select: { id: true, status: true } },
      },
    })
    if (!recovery) return { kind: "not_found" }
    if (recovery.settlementDueCents !== null && recovery.netProceedsCents !== null) {
      return {
        kind: "done", id: recovery.id, paymentId: recovery.proceedsPaymentId, replay: true, shortfallCents: recovery.shortfallCents ?? 0, surplusCents: recovery.surplusCents ?? 0,
        paymentCents: Math.min(recovery.netProceedsCents, recovery.settlementDueCents),
      }
    }
    const sale = recovery.sales[0]
    if (recovery.status !== "SOLD" || !sale) throw new RecoveryRefusal("Proceeds are applied to a sold recovery")
    const receivedOn = sastCalendarDate(input.receivedAt)
    if (toDayNumber(receivedOn) > toDayNumber(sastCalendarDate(new Date()))) throw new RecoveryRefusal("The proceeds cannot be dated in the future")
    if (toDayNumber(receivedOn) < toDayNumber(isoOfDbDate(recovery.recoveredOn))) throw new RecoveryRefusal("The proceeds cannot be dated before the recovery")

    const { deducted, charged } = costTotals(recovery.costs)
    const settlementDueCents = (await loanSettlementFigures(tx, recovery.loan, input.receivedAt)).totalToSettle
    let outcome
    try {
      outcome = recoveryOutcome({ settlementDueCents, grossProceedsCents: sale.priceInclVatCents, deductedCostsCents: deducted, chargedCostsCents: charged })
    } catch (error) {
      if (error instanceof RangeError) throw new RecoveryRefusal(error.message)
      throw error
    }

    let paymentId: string | null = null
    if (outcome.paymentCents > 0) {
      try {
        // The receipt runs inside this transaction, so it and the recovery's figures commit or roll back together.
        const inThisTransaction = { $transaction: <T>(run: (client: SigningTx) => Promise<T>) => run(tx) } as unknown as PaymentDb
        const receipt = await applyManualReceipt(inThisTransaction, {
          loanId: recovery.loanId, tenantId: actor.tenantId, amount: outcome.paymentCents, paymentMethod: "EFT", reference: `REC-${recovery.id}`,
          notes: "Repossessed asset sale proceeds", capturedById: actor.userId, capturedByEmail: actor.userEmail,
          idempotencyKey: idempotencyKey(recovery.id), receivedAt: input.receivedAt,
        })
        paymentId = receipt.payment.id
      } catch (error) {
        if (error instanceof PaymentApplicationError) throw new RecoveryRefusal(error.message)
        throw error
      }
      await tx.remarketingSale.update({ where: { id: sale.id, tenantId: actor.tenantId }, data: { proceedsPaymentId: paymentId } })
    }

    const nca = recovery.route === "NCA_S127_SURRENDER" || recovery.route === "NCA_S131_ATTACHMENT"
    const demandDays = (await tx.tenantConfig.findUnique({ where: { tenantId: actor.tenantId }, select: { nonNcaDemandPeriodDays: true } }))?.nonNcaDemandPeriodDays ?? 10
    const freeze = nca ? null : recoveryChargeFreeze({ regime: "NON_NCA", proceedsAppliedOn: receivedOn, nonNcaDemandPeriodDays: demandDays })
    await advance(tx, actor, recovery.id, "SOLD", {
      status: "PROCEEDS_APPLIED", settlementDueCents, grossProceedsCents: sale.priceInclVatCents, deductedCostsCents: deducted, chargedCostsCents: charged,
      netProceedsCents: outcome.netProceedsCents, shortfallCents: outcome.shortfallCents, surplusCents: outcome.surplusCents, proceedsPaymentId: paymentId,
      chargesFrozenFrom: dbDate(receivedOn), ...(freeze ? { chargesFrozenUntil: dbDate(freeze.frozenUntil) } : {}),
    })

    if (recovery.route === "NCA_S127_SURRENDER") {
      if (!recovery.surrenderRequest || recovery.surrenderRequest.status !== "VALUATION_NOTICE_ISSUED" || !paymentId) {
        throw new RecoveryRefusal("An s127 recovery credits its surrender once the valuation notice is issued and a receipt is applied")
      }
      await tx.surrenderRequest.update({ where: { id: recovery.surrenderRequest.id, tenantId: actor.tenantId }, data: {
        status: "PROCEEDS_CREDITED", saleProceedsCents: outcome.paymentCents, proceedsPaymentId: paymentId,
        shortfallCents: outcome.shortfallCents, refundCents: outcome.surplusCents,
      } })
    }
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_RECOVERY_PROCEEDS_APPLIED, entity: "Recovery", entityId: recovery.id,
      newValue: {
        saleId: sale.id, paymentId, receivedOn, settlementDueCents, grossProceedsCents: sale.priceInclVatCents, deductedCostsCents: deducted, chargedCostsCents: charged,
        ...outcome, chargesFrozenFrom: receivedOn, chargesFrozenUntil: freeze?.frozenUntil ?? null,
      },
    }, tx)
    return { kind: "done", id: recovery.id, paymentId, paymentCents: outcome.paymentCents, shortfallCents: outcome.shortfallCents, surplusCents: outcome.surplusCents, replay: false }
  }, { timeout: 30_000 }))
}
