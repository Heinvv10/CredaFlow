import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, PaymentApplicationError, type PaymentDb } from "@/lib/loan/apply-payment"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { isNcaRoute } from "./recovery-input"
import { recoveryChargeFreeze } from "./recovery-deadline"
import { costTotals, recoveryOutcome } from "./recovery-outcome"
import { advance, RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"
import type { SigningTx } from "./signing-prepare"

export type ProceedsApplied = {
  kind: "done"; id: string; paymentId: string | null; paymentCents: number; shortfallCents: number; surplusCents: number; unrecoverableCostsCents: number; replay: boolean
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
// The order of application and the cost treatment are signed off by the lender's legal team, 2026-10-17.

const idempotencyKey = (recoveryId: string) => `asset-recovery:${recoveryId}:proceeds`
const lockRecovery = (tx: SigningTx, id: string) => tx.$queryRaw`SELECT 1 FROM "Recovery" WHERE id = ${id} FOR UPDATE`

export async function applySaleProceeds(actor: RecoveryActor, recoveryId: string): Promise<NotFound | NotReady | ProceedsApplied> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | ProceedsApplied> => {
    // Proceeds are applied as of now: the database dates the charge freeze from today, so a back-dated receipt could not be honest.
    const receivedAt = new Date()
    const head = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { loanId: true } })
    if (!head) return { kind: "not_found" }
    // The loan first (its lock is what orders every receipt), then the recovery, before the settlement is read: a receipt landing in between would make it stale.
    await lockLoanForUpdate(tx, head.loanId)
    await lockRecovery(tx, recoveryId)
    const recovery = await tx.recovery.findFirst({
      where: { id: recoveryId, tenantId: actor.tenantId },
      include: {
        costs: { select: { grossCents: true, treatment: true, status: true } },
        sales: { where: { status: "COMPLETED" }, select: { id: true, priceInclVatCents: true } },
        loan: { include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } },
        surrenderRequest: { select: { id: true, status: true } },
      },
    })
    if (!recovery) return { kind: "not_found" }
    if (recovery.settlementDueCents !== null && recovery.netProceedsCents !== null) {
      return {
        kind: "done", id: recovery.id, paymentId: recovery.proceedsPaymentId, replay: true, shortfallCents: recovery.shortfallCents ?? 0, surplusCents: recovery.surplusCents ?? 0,
        unrecoverableCostsCents: recovery.unrecoverableCostsCents ?? 0,
        paymentCents: Math.min(recovery.netProceedsCents, recovery.settlementDueCents),
      }
    }
    const sale = recovery.sales[0]
    if (recovery.status !== "SOLD" || !sale) throw new RecoveryRefusal("Proceeds are applied to a sold recovery")
    const receivedOn = sastCalendarDate(receivedAt)
    if (toDayNumber(receivedOn) < toDayNumber(isoOfDbDate(recovery.recoveredOn))) throw new RecoveryRefusal("The proceeds cannot be dated before the recovery")

    if (recovery.costs.some((cost) => cost.status === "PENDING")) throw new RecoveryRefusal("Proceeds are applied once every cost is decided")
    const { deducted, charged } = costTotals(recovery.costs.filter((cost) => cost.status === "APPROVED"))
    const settlementDueCents = (await loanSettlementFigures(tx, recovery.loan, receivedAt)).totalToSettle
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
          idempotencyKey: idempotencyKey(recovery.id), receivedAt: receivedAt,
        })
        paymentId = receipt.payment.id
      } catch (error) {
        if (error instanceof PaymentApplicationError) throw new RecoveryRefusal(error.message)
        throw error
      }
      await tx.remarketingSale.update({ where: { id: sale.id, tenantId: actor.tenantId }, data: { proceedsPaymentId: paymentId } })
    }

    const nca = isNcaRoute(recovery.route)
    const demandDays = (await tx.tenantConfig.findUnique({ where: { tenantId: actor.tenantId }, select: { nonNcaDemandPeriodDays: true } }))?.nonNcaDemandPeriodDays ?? 10
    const freeze = nca ? null : recoveryChargeFreeze({ regime: "NON_NCA", proceedsAppliedOn: receivedOn, nonNcaDemandPeriodDays: demandDays })
    await advance(tx, actor, recovery.id, "SOLD", {
      status: "PROCEEDS_APPLIED", settlementDueCents, grossProceedsCents: sale.priceInclVatCents, deductedCostsCents: deducted, chargedCostsCents: charged,
      netProceedsCents: outcome.netProceedsCents, shortfallCents: outcome.shortfallCents, surplusCents: outcome.surplusCents, proceedsPaymentId: paymentId,
      chargesFrozenFrom: dbDate(receivedOn), ...(freeze ? { chargesFrozenUntil: dbDate(freeze.frozenUntil) } : {}),
    })

    // The freeze has begun and the charged costs are on the account from today: persist what the replay now derives (a no-op while default charges are off).
    await syncLoanCharges(tx, { tenantId: actor.tenantId, loanId: recovery.loanId }, receivedAt, { source: "recovery_proceeds", userId: actor.userId, userEmail: actor.userEmail })

    // What the account can carry: the shortfall less what the loan still owes after the sync. The rest of the charged costs (the
    // in duplum headroom refused it, or the proceeds had already settled the loan, or default charges are off) is the lender's:
    // not owed on the account. Signed off by the lender's legal team, 2026-10-17: the lender absorbs costs the account cannot lawfully carry.
    const after = await tx.loan.findFirstOrThrow({ where: { id: recovery.loanId, tenantId: actor.tenantId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    const owes = after.status === "COMPLETED" ? 0 : (await loanSettlementFigures(tx, after, receivedAt)).totalToSettle
    const unrecoverableCostsCents = Math.min(charged, Math.max(0, outcome.shortfallCents - owes))
    await advance(tx, actor, recovery.id, "PROCEEDS_APPLIED", { unrecoverableCostsCents })

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
        ...outcome, unrecoverableCostsCents, chargesFrozenFrom: receivedOn, chargesFrozenUntil: freeze?.frozenUntil ?? null,
      },
    }, tx)
    return { kind: "done", id: recovery.id, paymentId, paymentCents: outcome.paymentCents, shortfallCents: outcome.shortfallCents, surplusCents: outcome.surplusCents, unrecoverableCostsCents, replay: false }
  }, { timeout: 30_000 }))
}
