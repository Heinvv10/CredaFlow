import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { sastParts } from "@/lib/date/sast"

// GET /api/insurance/commissions?period=2026-04&advisorId=xxx
export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { searchParams } = req.nextUrl
      const period = searchParams.get("period")
      const advisorId = searchParams.get("advisorId")

      const commissions = await prisma.advisorCommission.findMany({
        where: {
          tenantId: tenant.id,
          ...(period ? { period } : {}),
          ...(advisorId ? { advisorId } : {}),
        },
        include: {
          advisor: { select: { id: true, name: true, email: true } },
          policy: { select: { policyNumber: true, type: true, client: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: [{ period: "desc" }, { createdAt: "desc" }],
      })

      return NextResponse.json(commissions)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch commissions" }, { status: 500 })
  }
}

// POST /api/insurance/commissions — calculate + create commissions for a period
export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const body = await req.json() as { period?: string }

      const now = new Date()
      // SAST accrual period. Built from local parts, a commission recorded between
      // 00:00 and 02:00 SAST on the 1st landed in the PREVIOUS month's statement —
      // a payable in the wrong period. Same defect as the policy-bind path.
  const { year: periodYear, month: periodMonth } = sastParts(now)
  const period = body.period ?? `${periodYear}-${String(periodMonth + 1).padStart(2, "0")}`

      // Get all active policies with an assigned advisor and commission rate
      const policies = await prisma.insurancePolicy.findMany({
        where: { tenantId: tenant.id, status: "ACTIVE", advisorId: { not: null } },
        select: {
          id: true,
          advisorId: true,
          premiumAmount: true,
          commissionRate: true,
        },
      })

      let created = 0
      let skipped = 0

      for (const policy of policies) {
        if (!policy.advisorId) continue

        const premiumBase = Number(policy.premiumAmount)
        const rate = Number(policy.commissionRate)
        const amount = parseFloat((premiumBase * rate).toFixed(2))

        try {
          await prisma.advisorCommission.create({
            data: {
              tenantId: tenant.id,
              advisorId: policy.advisorId,
              policyId: policy.id,
              period,
              premiumBase: premiumBase,
              rate: rate,
              amount: amount,
              status: "PENDING",
            },
          })
          created++
        } catch {
          // @@unique([advisorId, policyId, period]) — already exists for this period
          skipped++
        }
      }

      // A batch money event: one call creates every advisor commission for the
      // period. The counts are the outcome, so they are what the row records —
      // there is no single entity id to point at.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_COMMISSIONS_CALCULATED,
        entity: "AdvisorCommission",
        newValue: { period, created, skipped, policiesConsidered: policies.length },
      })

      return NextResponse.json({ period, created, skipped }, { status: 201 })
    })
  } catch {
    return NextResponse.json({ error: "Failed to calculate commissions" }, { status: 500 })
  }
}
