import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseBankAccountDecision } from "@/lib/asset-finance/supplier-input"
import { supplierAvsNotRun } from "@/lib/asset-finance/supplier-avs"

/**
 * Approve or reject a PENDING supplier bank account (DESIGN D8).
 * Body: `{ decision: "APPROVE" | "REJECT", note: string }`.
 *
 * Needs decide_asset_finance, and the decider must not be the requester (also
 * CHECK SupplierBankAccount_four_eyes; the route refuses first so the caller
 * gets a 403 and the attempt is audited). Approving records the verification
 * (lib/asset-finance/supplier-avs.ts) and supersedes the supplier's current
 * APPROVED account in the same transaction; the partial unique index
 * SupplierBankAccount_one_approved_per_supplier holds the invariant. The
 * supplier row is locked first so two approvals for one supplier serialise.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled

    const { accountId } = await params
    const refuse = async (reason: string, error: string) => {
      await auditRefusal({
        action: AuditAction.SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED,
        entity: "SupplierBankAccount",
        entityId: accountId,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status: 403,
      })
      return NextResponse.json({ error }, { status: 403 })
    }

    if (!canDo(guard.user.role, "decide_asset_finance")) {
      return refuse("insufficient_role", "Deciding a supplier bank account needs the decide_asset_finance permission")
    }

    const parsed = parseBankAccountDecision(await req.json().catch(() => null))
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    const { decision, note } = parsed

    const found = await prisma.supplierBankAccount.findFirst({
      where: { id: accountId, tenantId: tenant.id },
      select: { supplierId: true },
    })
    if (!found) return NextResponse.json({ error: "Bank account not found" }, { status: 404 })

    const result = await prisma.$transaction(async (tx) => {
      // Supplier first, then the account: every decision takes them in this order.
      const supplierLock = await tx.$queryRaw<Array<{ active: boolean }>>(Prisma.sql`
        SELECT "active" FROM "Supplier" WHERE "id" = ${found.supplierId} AND "tenantId" = ${tenant.id} FOR UPDATE
      `)
      const accountLock = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "SupplierBankAccount" WHERE "id" = ${accountId} AND "tenantId" = ${tenant.id} FOR UPDATE
      `)
      if (!supplierLock[0] || !accountLock[0]) return { kind: "not_found" as const }
      const account = await tx.supplierBankAccount.findFirst({ where: { id: accountId, tenantId: tenant.id } })
      if (!account) return { kind: "not_found" as const }
      if (account.status !== "PENDING") return { kind: "not_pending" as const, status: account.status }
      if (account.requestedById.trim().toLowerCase() === guard.user.id.trim().toLowerCase()) {
        return { kind: "self_decision" as const }
      }
      const approved = decision === "APPROVE"
      if (approved && !supplierLock[0].active) return { kind: "inactive" as const }

      const decidedAt = new Date()
      let supersededId: string | null = null
      if (approved) {
        const current = await tx.supplierBankAccount.findFirst({
          where: { tenantId: tenant.id, supplierId: account.supplierId, status: "APPROVED" },
          select: { id: true },
        })
        if (current) {
          await tx.supplierBankAccount.update({ where: { id: current.id }, data: { status: "SUPERSEDED" } })
          supersededId = current.id
        }
      }
      const verification = approved
        ? supplierAvsNotRun({ note, verifiedById: guard.user.id, verifiedAt: decidedAt })
        : { avsResult: undefined, avsPassed: null }
      const updated = await tx.supplierBankAccount.update({
        where: { id: accountId },
        data: {
          status: approved ? "APPROVED" : "REJECTED",
          decidedById: guard.user.id,
          decidedAt,
          avsResult: verification.avsResult,
          avsPassed: verification.avsPassed,
        },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.SUPPLIER_BANK_ACCOUNT_DECIDED,
        entity: "SupplierBankAccount",
        entityId: accountId,
        oldValue: { status: "PENDING" },
        newValue: {
          supplierId: account.supplierId,
          status: updated.status,
          note,
          requestedById: account.requestedById,
          supersededAccountId: supersededId,
          avs: approved ? "NOT_RUN" : null,
        },
      }, tx)
      return { kind: "decided" as const, account: updated }
    })

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Bank account not found" }, { status: 404 })
      case "not_pending":
        return NextResponse.json({ error: `The bank account is already ${result.status}` }, { status: 409 })
      case "inactive":
        return NextResponse.json({ error: "The supplier is inactive; its accounts cannot be approved" }, { status: 409 })
      case "self_decision":
        return refuse(
          "four_eyes_self_decision",
          "A supplier bank account must be decided by someone other than its requester",
        )
      case "decided":
        return NextResponse.json(result.account)
    }
  })
}
