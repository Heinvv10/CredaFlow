/**
 * Maintenance claims against a full-maintenance lease's fund (slice 3, C5),
 * in the caller's transaction. CredaFlow approves a claim and records its
 * payment reference; the money moves outside the system, as Payout does.
 *
 *   SUBMITTED → APPROVED → PAID (payment reference; a CLAIM movement), or → REJECTED
 *
 * - The provider is a Supplier with an APPROVED bank account; the provider's
 *   invoice is a supplier-invoice (or other) document on the lease's deal,
 *   backing one live claim only; the amount is ex VAT.
 * - No claim is submitted after the lease ends (the fund's leaseEndDate,
 *   unless it runs on month to month) or once the loan is no longer ACTIVE or
 *   DEFAULTED; nothing is submitted, approved or paid once the fund is settled
 *   (the end of term settles it on its final balance).
 * - Four-eyes: the approver is never the submitter; at or above the tenant
 *   threshold (TenantConfig.maintenanceClaimDualApprovalCents) a first
 *   approver records a first approval and a second, different approver
 *   approves. guardMaintenanceClaim (migration 20261014100000) refuses the
 *   same in the database; these checks give the readable refusal.
 * Every action is audited.
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate, isoOfDbDate } from "./dates"
import { needsSecondApprover } from "./maintenance-fund"
import type { SigningTx } from "./signing-prepare"

export interface ClaimActor {
  tenantId: string
  userId: string
  userEmail?: string | null
}

export type ClaimResult =
  | { kind: "ok"; claimId: string; status: string }
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }

const refused = (reason: string, error: string): ClaimResult => ({ kind: "refused", reason, error })

export interface SubmitClaimInput {
  loanId: string
  supplierId: string
  providerInvoiceDocumentId: string
  meterReadingId: string | null
  amountExclVatCents: number
  description: string
  today: string
}

export async function submitMaintenanceClaim(tx: SigningTx, actor: ClaimActor, input: SubmitClaimInput): Promise<ClaimResult> {
  const { tenantId } = actor
  const fund = await tx.maintenanceFund.findFirst({
    where: { tenantId, loanId: input.loanId },
    select: {
      id: true, leaseEndDate: true, settledAt: true,
      loan: { select: { status: true, assetId: true, assetFinanceDeal: { select: { id: true } }, leaseEndOfTerm: { select: { status: true } } } },
    },
  })
  const dealId = fund?.loan.assetFinanceDeal?.id
  const assetId = fund?.loan.assetId
  if (!fund || !dealId || !assetId) return { kind: "not_found" }
  if (fund.settledAt) return refused("fund_settled", "The maintenance fund is settled: no more claims")
  if (fund.loan.status !== "ACTIVE" && fund.loan.status !== "DEFAULTED") return refused("lease_closed", `The lease is ${fund.loan.status}: no claims`)
  const extending = fund.loan.leaseEndOfTerm?.status === "EXTENDING"
  if (input.today > isoOfDbDate(fund.leaseEndDate) && !extending) return refused("lease_ended", `The lease ended on ${isoOfDbDate(fund.leaseEndDate)}: no claims after it`)
  const supplier = await tx.supplier.findFirst({
    where: { id: input.supplierId, tenantId, active: true, bankAccounts: { some: { status: "APPROVED" } } },
    select: { id: true },
  })
  if (!supplier) return refused("provider", "The provider must be an active supplier with an APPROVED bank account")
  const document = await tx.entityDocument.findFirst({
    where: { id: input.providerInvoiceDocumentId, tenantId, dealId, deletedAt: null, docType: { in: ["SUPPLIER_INVOICE", "OTHER"] } },
    select: { id: true },
  })
  if (!document) return refused("invoice_document", "The provider's invoice must be an invoice document filed on this lease")
  const claimed = await tx.maintenanceClaim.findFirst({ where: { tenantId, providerInvoiceDocumentId: document.id, status: { not: "REJECTED" } }, select: { id: true } })
  if (claimed) return refused("invoice_claimed", "That invoice already backs a claim: one claim per provider invoice")
  if (input.meterReadingId) {
    const reading = await tx.assetMeterReading.findFirst({ where: { id: input.meterReadingId, tenantId, assetId }, select: { id: true } })
    if (!reading) return refused("meter_reading", "The meter reading is not this asset's")
  }
  if (!Number.isSafeInteger(input.amountExclVatCents) || input.amountExclVatCents <= 0) return refused("amount", "The amount must be a positive number of cents")
  const description = input.description.trim()
  if (description.length < 3) return refused("description", "Describe the work claimed")
  const claim = await tx.maintenanceClaim.create({
    data: {
      tenantId, fundId: fund.id, supplierId: supplier.id, providerInvoiceDocumentId: document.id, meterReadingId: input.meterReadingId,
      amountExclVatCents: input.amountExclVatCents, description, submittedById: actor.userId,
    },
    select: { id: true },
  })
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.MAINTENANCE_CLAIM_SUBMITTED,
    entity: "MaintenanceClaim", entityId: claim.id,
    newValue: { loanId: input.loanId, supplierId: supplier.id, amountExclVatCents: input.amountExclVatCents, description, meterReadingId: input.meterReadingId },
  }, tx)
  return { kind: "ok", claimId: claim.id, status: "SUBMITTED" }
}

async function lockClaim(tx: SigningTx, tenantId: string, claimId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MaintenanceClaim" WHERE "id" = ${claimId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  if (rows.length === 0) return null
  return tx.maintenanceClaim.findFirst({
    where: { id: claimId, tenantId },
    select: { id: true, status: true, amountExclVatCents: true, submittedById: true, firstApprovedById: true, fundId: true, fund: { select: { settledAt: true } } },
  })
}

const settledRefusal = (claim: { fund: { settledAt: Date | null } }): ClaimResult | null =>
  claim.fund.settledAt ? refused("fund_settled", "The maintenance fund is settled: the claim can only be rejected") : null

export async function approveMaintenanceClaim(tx: SigningTx, actor: ClaimActor, claimId: string): Promise<ClaimResult> {
  const { tenantId } = actor
  const claim = await lockClaim(tx, tenantId, claimId)
  if (!claim) return { kind: "not_found" }
  if (claim.status !== "SUBMITTED") return refused("not_submitted", `The claim is ${claim.status}`)
  if (claim.submittedById === actor.userId) return refused("same_user", "The person who submitted a claim cannot approve it")
  const settled = settledRefusal(claim)
  if (settled) return settled
  const config = await tx.tenantConfig.findUnique({ where: { tenantId }, select: { maintenanceClaimDualApprovalCents: true } })
  const dual = config === null || needsSecondApprover(claim.amountExclVatCents, config.maintenanceClaimDualApprovalCents)
  const now = new Date()
  let status = "APPROVED"
  if (dual && claim.firstApprovedById === null) {
    await tx.maintenanceClaim.update({ where: { id: claimId, tenantId }, data: { firstApprovedById: actor.userId, firstApprovedAt: now } })
    status = "SUBMITTED"
  } else {
    if (dual && claim.firstApprovedById === actor.userId) return refused("same_user", "A second, different approver is needed above the threshold")
    await tx.maintenanceClaim.update({ where: { id: claimId, tenantId }, data: { status: "APPROVED", approvedById: actor.userId, approvedAt: now } })
  }
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.MAINTENANCE_CLAIM_APPROVED,
    entity: "MaintenanceClaim", entityId: claimId,
    oldValue: { status: "SUBMITTED", firstApprovedById: claim.firstApprovedById },
    newValue: { status, dualApproval: dual, stage: status === "APPROVED" ? "final" : "first", amountExclVatCents: claim.amountExclVatCents },
  }, tx)
  return { kind: "ok", claimId, status }
}

export async function rejectMaintenanceClaim(tx: SigningTx, actor: ClaimActor, claimId: string, reason: string): Promise<ClaimResult> {
  const { tenantId } = actor
  const claim = await lockClaim(tx, tenantId, claimId)
  if (!claim) return { kind: "not_found" }
  if (claim.status !== "SUBMITTED") return refused("not_submitted", `The claim is ${claim.status}`)
  const text = reason.trim()
  if (text.length < 5) return refused("reason", "Give the reason for rejecting the claim")
  await tx.maintenanceClaim.update({ where: { id: claimId, tenantId }, data: { status: "REJECTED", rejectedById: actor.userId, rejectedAt: new Date(), rejectionReason: text } })
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.MAINTENANCE_CLAIM_REJECTED,
    entity: "MaintenanceClaim", entityId: claimId, oldValue: { status: "SUBMITTED" }, newValue: { status: "REJECTED", reason: text },
  }, tx)
  return { kind: "ok", claimId, status: "REJECTED" }
}

/** APPROVED → PAID with the payment reference; the fund's CLAIM movement is written with it. */
export async function markMaintenanceClaimPaid(tx: SigningTx, actor: ClaimActor, claimId: string, paymentReference: string, today: string): Promise<ClaimResult> {
  const { tenantId } = actor
  const claim = await lockClaim(tx, tenantId, claimId)
  if (!claim) return { kind: "not_found" }
  if (claim.status !== "APPROVED") return refused("not_approved", `Only an APPROVED claim is paid; this one is ${claim.status}`)
  // Lock the fund (as its settlement does), then read it settled or not.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MaintenanceFund" WHERE "id" = ${claim.fundId} AND "tenantId" = ${tenantId} FOR UPDATE`)
  const fund = await tx.maintenanceFund.findFirst({ where: { id: claim.fundId, tenantId }, select: { settledAt: true } })
  if (fund?.settledAt) return refused("fund_settled", "The maintenance fund is settled: the claim can only be rejected")
  const reference = paymentReference.trim()
  if (reference.length < 3 || reference.length > 64) return refused("payment_reference", "Record the payment reference (3–64 characters)")
  const paidAt = new Date()
  await tx.maintenanceClaim.update({ where: { id: claimId, tenantId }, data: { status: "PAID", paidById: actor.userId, paidAt, paymentReference: reference } })
  await tx.maintenanceFundMovement.create({
    data: { tenantId, fundId: claim.fundId, kind: "CLAIM", amountCents: claim.amountExclVatCents, claimId, occurredOn: dbDate(today), createdById: actor.userId },
  })
  await logAuditStrict({
    tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.MAINTENANCE_CLAIM_PAID,
    entity: "MaintenanceClaim", entityId: claimId, oldValue: { status: "APPROVED" },
    newValue: { status: "PAID", paymentReference: reference, amountExclVatCents: claim.amountExclVatCents },
  }, tx)
  return { kind: "ok", claimId, status: "PAID" }
}
