import { logAuditStrict } from "@/lib/audit"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { sastCalendarDate } from "@/lib/date/sast"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "./dates"
import { advance, RecoveryRefusal, refusable } from "./recovery-result"
import type { RecoveryActor } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"

export const SALE_WINDOW = "NCA sale waits until ten business days after valuation notice receipt"

export async function requireNcaSaleWindow(tx: SigningTx, tenantId: string, id: string, kind: "surrender" | "recovery", asOf = new Date()): Promise<void> {
  let received: Date | null = null
  if (kind === "surrender") {
    received = (await tx.surrenderRequest.findFirst({ where: { id, tenantId }, select: { valuationNoticeReceivedOn: true } }))?.valuationNoticeReceivedOn ?? null
  } else {
    const row = await tx.recovery.findFirst({ where: { id, tenantId }, select: { route: true, valuationNoticeReceivedOn: true, surrenderRequest: { select: { valuationNoticeReceivedOn: true } } } })
    if (!row || !row.route.startsWith("NCA_")) return
    received = row.surrenderRequest?.valuationNoticeReceivedOn ?? row.valuationNoticeReceivedOn
  }
  if (!received || sastCalendarDate(asOf) <= addSouthAfricanBusinessDays(isoOfDbDate(received), 10)) throw new RecoveryRefusal(SALE_WINDOW)
}

/** Staff attest actual receipt; issuing a notice does not start the statutory window. */
export async function recordValuationReceipt(actor: RecoveryActor, id: string, kind: "surrender" | "recovery", input: { receivedOn: string; reference: string; issuedOn?: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn) || input.reference.trim().length < 10 || input.reference.length > 1000) return { kind: "not_ready" as const, reason: "Provide the receipt date and delivery evidence reference (10 to 1000 characters)" }
  try { dbDate(input.receivedOn); if (input.issuedOn) dbDate(input.issuedOn) } catch { return { kind: "not_ready" as const, reason: "Provide valid calendar dates for notice issue and receipt" } }
  return refusable(() => prisma.$transaction(async (tx) => {
    const row = kind === "surrender"
      ? await tx.surrenderRequest.findFirst({ where: { id, tenantId: actor.tenantId } })
      : await tx.recovery.findFirst({ where: { id, tenantId: actor.tenantId } })
    if (!row) return { kind: "not_found" as const }
    if (!(kind === "surrender" ? ["VALUATION_NOTICE_ISSUED", "PROCEEDS_CREDITED"] : ["VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED"]).includes(row.status) || !row.valuationNoticePath || row.valuationNoticeReceivedOn) throw new RecoveryRefusal("Receipt is recorded once after the valuation notice issues")
    if (!row.valuationNoticeIssuedOn && (!input.issuedOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.issuedOn))) throw new RecoveryRefusal("Record the historical notice issue date with its issue and delivery evidence")
    if (input.issuedOn && row.valuationNoticeIssuedOn) throw new RecoveryRefusal("The recorded notice issue date cannot be changed")
    const data = { valuationNoticeReceivedOn: dbDate(input.receivedOn), valuationReceiptReference: input.reference.trim(), ...(!row.valuationNoticeIssuedOn && input.issuedOn ? { valuationNoticeIssuedOn: dbDate(input.issuedOn) } : {}) }
    if (kind === "surrender") await tx.surrenderRequest.update({ where: { id, tenantId: actor.tenantId }, data })
    else {
      const recovery = row as Awaited<ReturnType<typeof tx.recovery.findFirstOrThrow>>
      if (recovery.surrenderRequestId) throw new RecoveryRefusal("Record receipt on the surrender notice for this recovery")
      await tx.recovery.update({ where: { id, tenantId: actor.tenantId }, data })
    }
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: "ASSET_VALUATION_NOTICE_RECEIPT_RECORDED", entity: kind === "surrender" ? "SurrenderRequest" : "Recovery", entityId: id,
      newValue: { historicalIssuedOn: input.issuedOn ?? null, receivedOn: input.receivedOn, deliveryEvidenceReference: input.reference.trim() },
    }, tx)
    return { kind: "done" as const, id }
  }))
}

/** Staff confirm the consumer's timely withdrawal and actual handover of the goods. */
export async function withdrawSurrender(actor: RecoveryActor, id: string, goodsReturnReference: string) {
  const reference = goodsReturnReference.trim()
  if (reference.length < 10 || reference.length > 1000) return { kind: "not_ready" as const, reason: "Record the return-of-goods evidence in 10 to 1000 characters" }
  return refusable(() => prisma.$transaction(async (tx) => {
    const head = await tx.surrenderRequest.findFirst({ where: { id, tenantId: actor.tenantId }, select: { loanId: true } })
    if (!head) return { kind: "not_found" as const }
    await lockLoanForUpdate(tx, head.loanId)
    await tx.$queryRaw`SELECT 1 FROM "SurrenderRequest" WHERE id=${id} AND "tenantId"=${actor.tenantId} FOR UPDATE`
    const row = await tx.surrenderRequest.findFirst({ where: { id, tenantId: actor.tenantId }, include: { recovery: true } })
    if (!row) return { kind: "not_found" as const }
    const today = sastCalendarDate(new Date())
    if (row.status !== "VALUATION_NOTICE_ISSUED" || !row.valuationNoticeReceivedOn || today > addSouthAfricanBusinessDays(isoOfDbDate(row.valuationNoticeReceivedOn),10)) throw new RecoveryRefusal("Withdrawal is available within ten business days after receipt of the valuation notice")
    if (row.recovery && row.recovery.status !== "WITHDRAWN") {
      await advance(tx, actor, row.recovery.id, row.recovery.status, { status: "WITHDRAWN", withdrawnReason: `Consumer s127 withdrawal: ${reference}`, closedAt: new Date() })
      await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: "ASSET_RECOVERY_WITHDRAWN", entity: "Recovery", entityId: row.recovery.id, newValue: { surrenderId: id, goodsReturnReference: reference } }, tx)
    }
    await tx.surrenderRequest.update({ where: { id, tenantId: actor.tenantId }, data: { status: "WITHDRAWN", goodsReturnedOn: dbDate(today), goodsReturnReference: reference } })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: "ASSET_SURRENDER_WITHDRAWN", entity: "SurrenderRequest", entityId: id, newValue: { goodsReturnedOn: today, goodsReturnReference: reference } }, tx)
    return { kind: "done" as const, id }
  }))
}
