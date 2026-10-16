import { NextResponse, type NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { ownLenderArrears, withOwnLenderDebts } from "@/lib/affordability/own-lender-debt"
import { loadOwnLenderDebts } from "@/lib/affordability/own-lender-debt-load"

/**
 * One client's obligations to this lender, for the staff new-application
 * wizard (lib/affordability/own-lender-debt.ts): their declared debts plus
 * their loans and approved applications with us, as the approval will count
 * them, and "in arrears with us". Read for the selected client only.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const client = await prisma.client.findUnique({
      where: { id, tenantId: tenant.id },
      select: { id: true, debtObligations: { select: { id: true, creditProvider: true, monthlyInstalment: true } } },
    })
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })
    const own = await loadOwnLenderDebts(prisma, tenant.id, client.id)
    return NextResponse.json({
      debtObligations: withOwnLenderDebts(client.debtObligations, own).map((debt) => ({
        monthlyInstalment: Number(debt.monthlyInstalment ?? debt.monthlyInstalmentCents ?? 0),
      })),
      ownLenderArrears: ownLenderArrears(own),
    })
  })
}
