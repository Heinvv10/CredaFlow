/**
 * The four-eyes decision on a PENDING supplier bank account (DESIGN D8), shared
 * by POST /api/asset-finance/suppliers/bank-accounts/[accountId]/decide and the
 * demo seed so both write exactly the same rows.
 *
 * Runs inside the caller's transaction. Locks the supplier, then the account
 * (every decision takes them in that order, so two approvals for one supplier
 * serialise). The decider must not be the requester (also CHECK
 * SupplierBankAccount_four_eyes). Approving records the verification
 * (./supplier-avs.ts) and supersedes the supplier's current APPROVED account;
 * the partial unique index SupplierBankAccount_one_approved_per_supplier holds
 * the invariant. The caller checks decide_asset_finance first.
 */
import { Prisma, type SupplierBankAccount } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { supplierAvsNotRun } from "./supplier-avs"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type SupplierBankDecisionTx = Pick<Tx, "$queryRaw" | "supplierBankAccount" | "auditLog">

export interface SupplierBankDecisionInput {
  tenantId: string
  supplierId: string
  accountId: string
  decision: "APPROVE" | "REJECT"
  /** The decider's verification evidence (to approve) or reason (to reject). */
  note: string
  decider: { id: string; email?: string }
}

export type SupplierBankDecisionResult =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: string }
  | { kind: "self_decision" }
  | { kind: "inactive" }
  | { kind: "decided"; account: SupplierBankAccount; supersededId: string | null }

export async function decideSupplierBankAccount(
  tx: SupplierBankDecisionTx,
  input: SupplierBankDecisionInput,
): Promise<SupplierBankDecisionResult> {
  const { tenantId, supplierId, accountId, decision, note, decider } = input
  const supplierLock = await tx.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
    SELECT "active" FROM "Supplier" WHERE "id" = ${supplierId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  const accountLock = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "SupplierBankAccount" WHERE "id" = ${accountId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  if (!supplierLock[0] || !accountLock[0]) return { kind: "not_found" }
  const account = await tx.supplierBankAccount.findFirst({ where: { id: accountId, tenantId } })
  if (!account || account.supplierId !== supplierId) return { kind: "not_found" }
  if (account.status !== "PENDING") return { kind: "not_pending", status: account.status }
  if (account.requestedById.trim().toLowerCase() === decider.id.trim().toLowerCase()) return { kind: "self_decision" }
  const approved = decision === "APPROVE"
  if (approved && !supplierLock[0].active) return { kind: "inactive" }

  const decidedAt = new Date()
  let supersededId: string | null = null
  if (approved) {
    const current = await tx.supplierBankAccount.findFirst({
      where: { tenantId, supplierId, status: "APPROVED" },
      select: { id: true },
    })
    if (current) {
      await tx.supplierBankAccount.update({ where: { id: current.id }, data: { status: "SUPERSEDED" } })
      supersededId = current.id
    }
  }
  const verification = approved
    ? supplierAvsNotRun({ note, verifiedById: decider.id, verifiedAt: decidedAt })
    : { avsResult: undefined, avsPassed: null }
  const updated = await tx.supplierBankAccount.update({
    where: { id: accountId },
    data: {
      status: approved ? "APPROVED" : "REJECTED",
      decidedById: decider.id,
      decidedAt,
      avsResult: verification.avsResult,
      avsPassed: verification.avsPassed,
    },
  })
  await logAuditStrict({
    tenantId,
    userId: decider.id,
    userEmail: decider.email,
    action: AuditAction.SUPPLIER_BANK_ACCOUNT_DECIDED,
    entity: "SupplierBankAccount",
    entityId: accountId,
    oldValue: { status: "PENDING" },
    newValue: {
      supplierId,
      status: updated.status,
      note,
      requestedById: account.requestedById,
      supersededAccountId: supersededId,
      avs: approved ? "NOT_RUN" : null,
    },
  }, tx)
  return { kind: "decided", account: updated, supersededId }
}
