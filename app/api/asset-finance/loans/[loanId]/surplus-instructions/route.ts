import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { issueNcaSurplusRemittance } from "@/lib/asset-finance/nca-surplus"
import { refusable } from "@/lib/asset-finance/recovery-result"
export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async tenant => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "record_payment")) return NextResponse.json({ error: "Payment permission required" }, { status: 403 })
    const { loanId } = await params
    const result = await refusable(() => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id"=${loanId} AND "tenantId"=${tenant.id} FOR UPDATE`
      const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: tenant.id, ncaRegime: "NCA", contractType: { not: "LOAN" } } })
      if (!loan) return { kind: "not_found" as const }
      const surrender = await tx.surrenderRequest.findFirst({ where: { tenantId: tenant.id, loanId, status: { in: ["PROCEEDS_CREDITED", "FINAL_NOTICE_ISSUED"] }, refundCents: { gt: 0 } } })
      const recovery = surrender ? null : await tx.recovery.findFirst({ where: { tenantId: tenant.id, loanId, route: "NCA_S131_ATTACHMENT", status: { in: ["PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED", "SURPLUS_HELD"] }, surplusCents: { gt: 0 } } })
      if (!surrender && !recovery) return { kind: "not_ready" as const, reason: "Apply actual sale proceeds before preparing its surplus instruction" }
      const row = await issueNcaSurplusRemittance(tx, { tenantId: tenant.id, userId: guard.user.id }, { loanId, surrenderId: surrender?.id, recoveryId: recovery?.id, amountCents: surrender?.refundCents ?? recovery!.surplusCents! })
      return { kind: "done" as const, id: row!.id }
    }))
    if (result.kind === "not_found") return NextResponse.json({ error: "NCA asset-finance loan not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
