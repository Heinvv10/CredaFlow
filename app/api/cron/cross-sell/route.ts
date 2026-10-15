import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { CrossSellType, OpportunityStatus } from "@prisma/client"
import { verifyCronSecret } from "@/lib/cron-auth"
const ACTIVE_OPP_STATUSES: OpportunityStatus[] = ["PENDING", "CONTACTED", "INTERESTED"]

// CrossSellOpportunity is a tenant-scope model: every query names the tenant
// being swept, matching the runWithTenant frame it runs in.
async function hasExistingOpportunity(clientId: string, tenantId: string, type: CrossSellType): Promise<boolean> {
  const count = await prisma.crossSellOpportunity.count({
    where: { tenantId, clientId, type, status: { in: ACTIVE_OPP_STATUSES } },
  })
  return count > 0
}

async function createOpportunity(clientId: string, tenantId: string, type: CrossSellType): Promise<void> {
  await prisma.crossSellOpportunity.create({
    data: { tenantId, clientId, type, status: "PENDING" },
  })
}

async function sweepTenant(tenantId: string): Promise<{ evaluated: number; created: number }> {
  // Fetch all non-blacklisted clients with loans and their products
  const clients = await prisma.client.findMany({
    // deceasedAt excluded for the same reason as blacklisted: a cross-sell
    // opportunity is an attempt to extend new credit or cover, which is
    // exactly what a recorded death must stop.
    where: { tenantId, blacklisted: false, deceasedAt: null },
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

      const exists = await hasExistingOpportunity(client.id, tenantId, "PERSONAL_LOAN")
      if (exists) continue

      await createOpportunity(client.id, tenantId, "PERSONAL_LOAN")
      created++
      break // one opportunity per client per type
    }

    // Rule 2: PERSONAL → CREDIT_LIFE
    // Personal loan > 2,000,000 cents + no insurance policy + no existing CREDIT_LIFE opportunity
    for (const loan of personalLoans) {
      if (loan.principal <= 2_000_000) continue

      const hasCreditLife = client.insurancePolicies.some((p) => p.type === "CREDIT_LIFE")
      if (hasCreditLife) continue

      const exists = await hasExistingOpportunity(client.id, tenantId, "CREDIT_LIFE")
      if (exists) continue

      await createOpportunity(client.id, tenantId, "CREDIT_LIFE")
      created++
      break
    }
  }

  return { evaluated, created }
}

/**
 * Weekly: sweeps every ACTIVE tenant, each inside its own frame. Any failed tenant
 * makes the response 503: the scheduler treats only a non-2xx as a failure,
 * and never reads the body.
 */
export async function POST(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const tenants = await prisma.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } })
    const perTenant: Array<{ tenantId: string; evaluated: number; created: number } | { tenantId: string; error: string }> = []
    let evaluated = 0
    let created = 0
    for (const { id: tenantId } of tenants) {
      try {
        const result = await runWithTenant(tenantId, () => sweepTenant(tenantId))
        evaluated += result.evaluated
        created += result.created
        perTenant.push({ tenantId, ...result })
      } catch (error) {
        console.error(`[cron/cross-sell] tenant ${tenantId} failed:`, error)
        perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    const ok = perTenant.every((t) => !("error" in t))
    return NextResponse.json({ evaluated, created, perTenant }, { status: ok ? 200 : 503 })
  } catch (error) {
    console.error("[cron/cross-sell] failed:", error)
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
