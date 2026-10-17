/**
 * The supplier payout of a CONTRACTED deal (goal §4.10, DESIGN D8): created
 * for the supplier's APPROVED bank account once every required checklist item
 * is confirmed, for payoutAmountCents (./payout-checklist.ts). At or above
 * TenantConfig.assetPayoutDualApprovalCents it is created PENDING_APPROVAL
 * and a second, different decide_asset_finance user approves it; below, the
 * creation is the approval (APPROVED, approvedById = the creator). guardPayout
 * and the Payout CHECKs (migration 20261013113000) refuse every one of these
 * rules in the database too. Booking (./booking.ts) releases it.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { INT4_MAX } from "@/lib/product-config/bounds"
import { checklistLabel, needsDualApproval, payoutAmountCents, requiredChecklistKinds } from "./payout-checklist"
import { lockDeal, type SigningActor } from "./signing-prepare"
import { dealCreditGate } from "./deal-credit-gate"

export type CreatePayoutResult =
  | { kind: "not_found" }
  | { kind: "not_contracted"; status: string }
  | { kind: "exists" }
  | { kind: "checklist_open"; open: string[] }
  | { kind: "no_approved_account" }
  | { kind: "amount_invalid"; amountCents: number }
  | { kind: "credit_gate"; reason: string; message: string }
  | { kind: "created"; payoutId: string; status: "PENDING_APPROVAL" | "APPROVED" }

export type ApprovePayoutResult =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: string }
  | { kind: "same_user" }
  | { kind: "approved" }

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"

export async function createPayout(actor: SigningActor, dealId: string): Promise<CreatePayoutResult> {
  const { tenantId } = actor
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await lockDeal(tx, tenantId, dealId)
      if (!locked) return { kind: "not_found" }
      if (locked.status !== "CONTRACTED") return { kind: "not_contracted", status: locked.status }
      const deal = await tx.assetFinanceDeal.findFirstOrThrow({
        where: { id: dealId, tenantId },
        select: {
          contractType: true, supplierId: true, depositCents: true, tradeInCents: true,
          asset: { select: { cashPriceExclVatCents: true, vatCents: true, registrationNumber: true } },
          checklist: { select: { item: true, confirmedAt: true } },
          payout: { select: { id: true } },
        },
      })
      if (deal.payout) return { kind: "exists" }
      const credit = await dealCreditGate(tx, tenantId, dealId)
      if (credit.problem) return { kind: "credit_gate", reason: credit.problem.kind, message: credit.problem.message }
      const confirmed = new Set(deal.checklist.filter((c) => c.confirmedAt).map((c) => c.item))
      const open = requiredChecklistKinds(deal.contractType, deal.asset).filter((kind) => !confirmed.has(kind))
      if (open.length > 0) return { kind: "checklist_open", open: open.map((kind) => checklistLabel(kind, deal.contractType)) }
      const account = await tx.supplierBankAccount.findFirst({
        where: { tenantId, supplierId: deal.supplierId, status: "APPROVED" },
        select: { id: true },
      })
      if (!account) return { kind: "no_approved_account" }
      const amountCents = payoutAmountCents({ ...deal.asset, depositCents: deal.depositCents, tradeInCents: deal.tradeInCents })
      if (amountCents <= 0 || amountCents > INT4_MAX) return { kind: "amount_invalid", amountCents }

      const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { assetPayoutDualApprovalCents: true } })
      // No config row: the trigger requires two approvers; so does this.
      const dual = config === null || needsDualApproval(amountCents, config.assetPayoutDualApprovalCents)
      const now = new Date()
      const payout = await tx.payout.create({
        data: {
          tenantId, dealId, supplierBankAccountId: account.id, amountCents, createdById: actor.userId,
          ...(dual ? { status: "PENDING_APPROVAL" } : { status: "APPROVED", approvedById: actor.userId, approvedAt: now }),
        },
        select: { id: true, status: true, dualApprovalRequired: true },
      })
      await logAuditStrict({
        tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? undefined,
        action: AuditAction.ASSET_PAYOUT_CREATED,
        entity: "Payout",
        entityId: payout.id,
        newValue: {
          dealId, supplierBankAccountId: account.id, amountCents, status: payout.status,
          dualApprovalRequired: payout.dualApprovalRequired, thresholdCents: config?.assetPayoutDualApprovalCents ?? null,
          ...(credit.arrearsGrown.length > 0 ? { arrearsGrownSinceApproval: credit.arrearsGrown } : {}),
        },
      }, tx)
      return { kind: "created", payoutId: payout.id, status: dual ? "PENDING_APPROVAL" : "APPROVED" }
    })
  } catch (error) {
    // A concurrent create won: Payout.dealId is unique.
    if (isUniqueViolation(error)) return { kind: "exists" }
    throw error
  }
}

export async function approvePayout(actor: SigningActor, dealId: string): Promise<ApprovePayoutResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const locked = await lockDeal(tx, tenantId, dealId)
    if (!locked) return { kind: "not_found" }
    const payout = await tx.payout.findFirst({
      where: { tenantId, dealId },
      select: { id: true, status: true, createdById: true, amountCents: true },
    })
    if (!payout) return { kind: "not_found" }
    if (payout.status !== "PENDING_APPROVAL") return { kind: "not_pending", status: payout.status }
    if (payout.createdById === actor.userId) return { kind: "same_user" }
    const approvedAt = new Date()
    const updated = await tx.payout.updateMany({
      where: { id: payout.id, tenantId, status: "PENDING_APPROVAL" },
      data: { status: "APPROVED", approvedById: actor.userId, approvedAt },
    })
    if (updated.count !== 1) return { kind: "not_pending", status: "changed" }
    await logAuditStrict({
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_PAYOUT_APPROVED,
      entity: "Payout",
      entityId: payout.id,
      oldValue: { status: "PENDING_APPROVAL", createdById: payout.createdById },
      newValue: { status: "APPROVED", approvedById: actor.userId, amountCents: payout.amountCents, dealId },
    }, tx)
    return { kind: "approved" }
  })
}
