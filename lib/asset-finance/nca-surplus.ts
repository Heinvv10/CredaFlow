import { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "./dates"
import { RecoveryRefusal } from "./recovery-result"
import { logAuditStrict } from "@/lib/audit"
import type { RecoveryActor } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"
import { ncaRemittanceDisposition } from "./nca-surplus-disposition"
export { ncaRemittanceDisposition } from "./nca-surplus-disposition"

/** Prepare a treasury instruction before bank execution. Final notice calls requireExecuted. */
export async function issueNcaSurplusRemittance(tx: SigningTx, actor: RecoveryActor, input: { loanId: string; surrenderId?: string; recoveryId?: string; amountCents: number }, requireExecuted = false) {
  if (input.amountCents <= 0) return null
  await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id"=${input.loanId} AND "tenantId"=${actor.tenantId} FOR UPDATE`
  const determination = await tx.ncaSurplusDetermination.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId } })
  if (!determination) throw new RecoveryRefusal("Determine competing registered credit agreements with retained evidence; unknown is not no")
  await tx.$queryRaw`SELECT "id" FROM "NcaSurplusAccount" WHERE "loanId"=${input.loanId} AND "tenantId"=${actor.tenantId} FOR SHARE`
  const existing = await tx.ncaSurplusRemittance.findFirst({ where: { tenantId: actor.tenantId, ...(input.surrenderId ? { surrenderId: input.surrenderId } : { recoveryId: input.recoveryId }) } })
  if (existing) {
    if (existing.amountCents !== input.amountCents) throw new RecoveryRefusal("Surplus instruction differs from the final account")
    if (requireExecuted && existing.status === "INSTRUCTED" && !existing.executedOn) throw new RecoveryRefusal("Record actual external bank execution before issuing the ordinary final notice")
    if (requireExecuted && existing.status === "HELD_NO_VERIFIED_ACCOUNT") {
      const currentAccount = await tx.ncaSurplusAccount.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId } })
      if (determination.competingAgreement || currentAccount?.approvedById) throw new RecoveryRefusal("A verified eligible destination or Tribunal claim requires release and actual execution before the ordinary final notice")
    }
    return existing
  }
  const account = await tx.ncaSurplusAccount.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId } })
  const status = ncaRemittanceDisposition(account)
  if (requireExecuted && status === "INSTRUCTED") throw new RecoveryRefusal("Prepare the surplus instruction and record actual bank execution before the ordinary final notice")
  if (determination.competingAgreement && status !== "INSTRUCTED") throw new RecoveryRefusal("A competing credit agreement requires Tribunal remittance; no consumer-account exception")
  const row = await tx.ncaSurplusRemittance.create({ data: { tenantId: actor.tenantId, surrenderId: input.surrenderId, recoveryId: input.recoveryId,
    accountId: status === "INSTRUCTED" ? account!.id : null, amountCents: input.amountCents, status,
    exceptionReason: status === "INSTRUCTED" ? null : "No staff-verified consumer bank account; surplus held pending verification", issuedById: actor.userId,
  } })
  if (status === "HELD_NO_VERIFIED_ACCOUNT") await tx.notification.create({ data: { tenantId: actor.tenantId, userId: actor.userId, type: "NCA_SURPLUS_PAYABLE_OUTSTANDING", title: "NCA surplus remains payable: verified consumer account required", body: "The post-sale account statement must remain accurate. Obtain bank evidence, independent verification and release authority, record actual remittance, and provide the supplemental confirmation. Do not treat the agreement as statutorily terminated while this surplus remains unpaid.", entityType: "Loan", entityId: input.loanId } })
  await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: status === "INSTRUCTED" ? "ASSET_SURPLUS_INSTRUCTION_ISSUED" : "ASSET_SURPLUS_HELD_EXCEPTION", entity: "NcaSurplusRemittance", entityId: row.id,
    newValue: { loanId: input.loanId, amountCents: row.amountCents, status, accountId: row.accountId, exceptionReason: row.exceptionReason, exceptionStatementIssued: false } }, tx)
  return row
}

/** Rendering inputs are immutable after execution; held original notices remain untouched. */
export async function ncaSurplusNoticeDetails(tenantId: string, loanId: string) {
  const row = await prisma.ncaSurplusRemittance.findFirst({ where: { tenantId, OR: [{ surrender: { loanId } }, { recovery: { loanId } }] }, include: { account: true } })
  const account = row?.account ?? await prisma.ncaSurplusAccount.findFirst({ where: { tenantId, loanId } })
  return { surplusDisposition: row?.status === "HELD_NO_VERIFIED_ACCOUNT" ? "HELD_NO_VERIFIED_ACCOUNT" as const : ncaRemittanceDisposition(account), surplusRecipient: account?.recipient === "TRIBUNAL" ? "TRIBUNAL" as const : "CONSUMER" as const, surplusExecutedOn: row?.executedOn ? isoOfDbDate(row.executedOn) : undefined }
}
