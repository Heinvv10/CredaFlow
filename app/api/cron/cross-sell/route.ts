import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { CrossSellType, OpportunityStatus } from "@prisma/client"
import { verifyCronSecret } from "@/lib/cron-auth"
const ACTIVE_OPP_STATUSES: OpportunityStatus[] = ["PENDING", "CONTACTED", "INTERESTED"]

async function hasExistingOpportunity(clientId: string, type: CrossSellType): Promise<boolean> {
  const count = await prisma.crossSellOpportunity.count({
    where: { clientId, type, status: { in: ACTIVE_OPP_STATUSES } },
  })
  return count > 0
}

async function createOpportunity(clientId: string, tenantId: string, type: CrossSellType): Promise<void> {
  await prisma.crossSellOpportunity.create({
    data: { tenantId, clientId, type, status: "PENDING" },
  })
}

export async function POST(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const fallbackTenantId = await getDefaultTenantId()

    // Fetch all non-blacklisted clients with loans and their products
    const clients = await prisma.client.findMany({
      // deceasedAt excluded for the same reason as blacklisted: a cross-sell
      // opportunity is an attempt to extend new credit or cover, which is
      // exactly what a recorded death must stop.
      where: { tenantId: fallbackTenantId, blacklisted: false, deceasedAt: null },
      select: {
        id: true,
        loans: {
          where: { status: "ACTIVE" },
          select: {
            id: true,
            principal: true,
            product: { select: { productType: true } },
            repaymentSchedule: {
              select: { status: true },
            },
          },
        },
        insurancePolicies: {
          where: { status: "ACTIVE" },
          select: { id: true, type: true },
        },
      },
    })

    let evaluated = 0
    let created = 0

    for (const client of clients) {
      evaluated++

      const microLoans = client.loans.filter((l) => l.product.productType === "MICRO")
      const personalLoans = client.loans.filter((l) => l.product.productType === "PERSONAL")

      // Rule 1: MICRO → PERSONAL_LOAN
      // Has a micro loan + 3+ paid repayments + no active personal loan + no existing opportunity
      for (const loan of microLoans) {
        const paidCount = loan.repaymentSchedule.filter((r) => r.status === "PAID").length
        if (paidCount < 3) continue
        if (personalLoans.length > 0) continue

        const exists = await hasExistingOpportunity(client.id, "PERSONAL_LOAN")
        if (exists) continue

        await createOpportunity(client.id, fallbackTenantId, "PERSONAL_LOAN")
        created++
        break // one opportunity per client per type
      }

      // Rule 2: PERSONAL → CREDIT_LIFE
      // Personal loan > 2,000,000 cents + no insurance policy + no existing CREDIT_LIFE opportunity
      for (const loan of personalLoans) {
        if (loan.principal <= 2_000_000) continue

        const hasCreditLife = client.insurancePolicies.some((p) => p.type === "CREDIT_LIFE")
        if (hasCreditLife) continue

        const exists = await hasExistingOpportunity(client.id, "CREDIT_LIFE")
        if (exists) continue

        await createOpportunity(client.id, fallbackTenantId, "CREDIT_LIFE")
        created++
        break
      }
    }

    return NextResponse.json({ evaluated, created })
  } catch {
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
