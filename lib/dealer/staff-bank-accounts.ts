/**
 * Dealer bank accounts, the supplier pattern (DESIGN D8) field for field
 * (spec deviation 7): staff capture only — a dealer user signs in with a
 * password alone, and self-service bank details would let one stolen password
 * redirect commission. A request is created PENDING (manage_dealers); a
 * different user with decide_asset_finance approves it against independent
 * evidence (CHECK DealerBankAccount_four_eyes), which supersedes the dealer's
 * current APPROVED account (partial unique DealerBankAccount_one_approved_per_dealer).
 * The input parsers and the account-number masking are the supplier ones.
 */
import { Prisma, type DealerBankAccount } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { BankAccountDecision, BankAccountFields } from "@/lib/asset-finance/supplier-input"
import type { StaffActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type DealerBankDecisionTx = Pick<Tx, "$queryRaw" | "dealerBankAccount" | "auditLog">

// The only AVS integration verifies an account against a natural person's ID
// number (lib/asset-finance/supplier-avs.ts); a dealer is usually a juristic
// person, so approval records the approver's manual evidence instead.
export const DEALER_AVS_NOT_RUN_REASON =
  "Dealer AVS needs provider support: the AVS integration verifies an account against a natural person's ID number only"

export async function requestDealerBankAccount(
  staff: StaffActor,
  dealerId: string,
  fields: BankAccountFields,
): Promise<{ kind: "requested"; account: DealerBankAccount } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const dealer = await tx.dealer.findFirst({ where: { id: dealerId, tenantId: staff.tenantId }, select: { active: true } })
    if (!dealer) return dealerMiss("Dealer")
    if (!dealer.active) return dealerRefused(409, "The dealer is deactivated")
    const account = await tx.dealerBankAccount.create({
      data: { ...fields, tenantId: staff.tenantId, dealerId, status: "PENDING", requestedById: staff.userId },
    })
    await logAuditStrict({
      tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_BANK_ACCOUNT_REQUESTED, entity: "DealerBankAccount", entityId: account.id,
      newValue: {
        dealerId, bankName: fields.bankName, branchCode: fields.branchCode, accountNumberLast4: fields.accountNumber.slice(-4),
        accountHolder: fields.accountHolder, accountType: fields.accountType,
      },
    }, tx)
    return { kind: "requested" as const, account }
  })
}

export interface DealerBankDecisionInput {
  tenantId: string
  accountId: string
  decision: BankAccountDecision
  /** The verification evidence (to approve) or the reason (to reject). */
  note: string
  decider: { id: string; email?: string }
}

export type DealerBankDecisionResult =
  | { kind: "decided"; account: DealerBankAccount; supersededId: string | null }
  | { kind: "self_decision" }
  | DealerRefusal

/**
 * The decision, inside the caller's transaction (the route and the demo seed).
 * Locks the dealer, then the account, as every decision does, so two approvals
 * for one dealer serialise. The caller checks decide_asset_finance first.
 */
export async function decideDealerBankAccount(tx: DealerBankDecisionTx, input: DealerBankDecisionInput): Promise<DealerBankDecisionResult> {
  const { tenantId, accountId, decision, note, decider } = input
  const found = await tx.dealerBankAccount.findFirst({ where: { id: accountId, tenantId }, select: { dealerId: true } })
  if (!found) return dealerMiss("Bank account")
  const dealerLock = await tx.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
    SELECT "active" FROM "Dealer" WHERE "id" = ${found.dealerId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DealerBankAccount" WHERE "id" = ${accountId} AND "tenantId" = ${tenantId} FOR UPDATE`)
  const account = await tx.dealerBankAccount.findFirst({ where: { id: accountId, tenantId } })
  if (!account || !dealerLock[0]) return dealerMiss("Bank account")
  if (account.status !== "PENDING") return dealerRefused(409, `The bank account is already ${account.status}`)
  if (account.requestedById.trim().toLowerCase() === decider.id.trim().toLowerCase()) return { kind: "self_decision" }
  const approved = decision === "APPROVE"
  if (approved && !dealerLock[0].active) return dealerRefused(409, "The dealer is deactivated; its accounts cannot be approved")

  const decidedAt = new Date()
  let supersededId: string | null = null
  if (approved) {
    const current = await tx.dealerBankAccount.findFirst({ where: { tenantId, dealerId: account.dealerId, status: "APPROVED" }, select: { id: true } })
    if (current) {
      await tx.dealerBankAccount.update({ where: { id: current.id, tenantId }, data: { status: "SUPERSEDED" } })
      supersededId = current.id
    }
  }
  const avsResult = approved
    ? {
        status: "NOT_RUN", reason: DEALER_AVS_NOT_RUN_REASON,
        manualVerification: { note, verifiedById: decider.id, verifiedAt: decidedAt.toISOString() },
      }
    : undefined
  const updated = await tx.dealerBankAccount.update({
    where: { id: accountId, tenantId },
    data: { status: approved ? "APPROVED" : "REJECTED", decidedById: decider.id, decidedAt, avsResult, avsPassed: null },
  })
  await logAuditStrict({
    tenantId, userId: decider.id, userEmail: decider.email,
    action: AuditAction.DEALER_BANK_ACCOUNT_DECIDED, entity: "DealerBankAccount", entityId: accountId,
    oldValue: { status: "PENDING" },
    newValue: {
      dealerId: account.dealerId, status: updated.status, note, requestedById: account.requestedById,
      supersededAccountId: supersededId, avs: approved ? "NOT_RUN" : null,
    },
  }, tx)
  return { kind: "decided", account: updated, supersededId }
}
