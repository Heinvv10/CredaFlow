import { logAuditStrict } from "@/lib/audit"
import type { RecoveryActor } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"
import { ncaRemittanceDisposition } from "./nca-surplus-disposition"
export { ncaRemittanceDisposition } from "./nca-surplus-disposition"

/** Called inside the same transaction that stores the final notice. */
export async function issueNcaSurplusRemittance(tx: SigningTx, actor: RecoveryActor, input: { loanId: string; surrenderId?: string; recoveryId?: string; amountCents: number }) {
  if (input.amountCents <= 0) return null
  const account = await tx.ncaSurplusAccount.findFirst({ where: { tenantId: actor.tenantId, loanId: input.loanId } })
  const status = ncaRemittanceDisposition(account)
  const row = await tx.ncaSurplusRemittance.create({ data: { tenantId: actor.tenantId, surrenderId: input.surrenderId, recoveryId: input.recoveryId,
    accountId: status === "INSTRUCTED" ? account!.id : null, amountCents: input.amountCents, status,
    exceptionReason: status === "INSTRUCTED" ? null : "No staff-verified consumer bank account; surplus held pending verification", issuedById: actor.userId,
  } })
  await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: status === "INSTRUCTED" ? "ASSET_SURPLUS_INSTRUCTION_ISSUED" : "ASSET_SURPLUS_HELD_EXCEPTION", entity: "NcaSurplusRemittance", entityId: row.id,
    newValue: { loanId: input.loanId, amountCents: row.amountCents, status, accountId: row.accountId, exceptionReason: row.exceptionReason } }, tx)
  return row
}
