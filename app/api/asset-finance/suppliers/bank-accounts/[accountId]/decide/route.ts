import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseBankAccountDecision } from "@/lib/asset-finance/supplier-input"
import { decideSupplierBankAccount } from "@/lib/asset-finance/supplier-bank-decision"

/**
 * Approve or reject a PENDING supplier bank account (DESIGN D8).
 * Body: `{ decision: "APPROVE" | "REJECT", note: string }`.
 *
 * Needs decide_asset_finance, and the decider must not be the requester (also
 * CHECK SupplierBankAccount_four_eyes; the refusal is a 403 and audited). The
 * decision itself, its locks and its audit row are
 * lib/asset-finance/supplier-bank-decision.ts, which the demo seed also uses.
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

    const result = await prisma.$transaction((tx) => decideSupplierBankAccount(tx, {
      tenantId: tenant.id,
      supplierId: found.supplierId,
      accountId,
      decision,
      note,
      decider: { id: guard.user.id, email: guard.user.email },
    }))

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
