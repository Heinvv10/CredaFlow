import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { analyseArrangement } from "@/lib/collections/arrangement-tracker"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const [arrangement, payments] = await Promise.all([
      prisma.paymentArrangement.findFirst({ where: { loanId: id, tenantId: tenant.id } }),
      prisma.payment.findMany({
        where: {
          tenantId: tenant.id,
          loanId: id,
          reversed: false,
          allocationStatus: "ALLOCATED",
          // A waived balance is not an arrangement instalment paid.
          ...CASH_RECEIPTS,
        },
        select: { id: true, amount: true, receivedAt: true },
        orderBy: { receivedAt: "asc" },
      }),
    ])

    if (!arrangement) {
      return NextResponse.json({ arrangement: null, analysis: null })
    }

    const analysis = analyseArrangement(
      {
        agreedAmount: arrangement.agreedAmount,
        frequency: arrangement.frequency,
        startDate: arrangement.startDate,
        endDate: arrangement.endDate,
      },
      payments.map(p => ({ id: p.id, amount: p.amount, receivedAt: p.receivedAt }))
    )

    // A read writes nothing. The stored status rolls up from ACTIVE in the
    // nightly arrangement-check cron (app/api/cron/arrangement-check), which
    // audits the change; until then the response shows the derived status.
    return NextResponse.json({ arrangement: { ...arrangement, status: resolveDisplayStatus(arrangement.status, analysis) }, analysis })
  })
}

function resolveDisplayStatus(stored: string, analysis: { overallStatus: string; complianceRate: number }): string {
  if (stored !== "ACTIVE") return stored
  if (analysis.overallStatus === "BROKEN") return "BROKEN"
  if (analysis.overallStatus === "PARTIAL") return "PARTIAL"
  if (analysis.complianceRate >= 90) return "KEPT"
  return "ACTIVE"
}
