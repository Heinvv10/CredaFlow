import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { sastMonthBounds } from "@/lib/compliance/quarters"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  // The caller must belong to the host's tenant — the same rule as
  // withTenantContext — or staff of one lender read another's advisor figures.
  if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const monthsBack = parseInt(req.nextUrl.searchParams.get("months") ?? "6")
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const fromDate = sastMonthBounds(now, -(monthsBack - 1)).start

  // This tenant's staff only — every tenant's users were read, and any who
  // had activity here would have been listed.
  const users = await prisma.user.findMany({
    where: { tenantId: tenant.id, active: true },
    select: { id: true, name: true, email: true, role: true },
  })

  // Applications assigned to each user
  const [assignedApps, approvedApps, leads, loans] = await Promise.all([
    prisma.loanApplication.groupBy({
      by: ["assignedToId"],
      where: { tenantId: tenant.id, createdAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
    prisma.loanApplication.groupBy({
      // By assignee, like every other column and like the advisor report page.
      by: ["assignedToId"],
      where: { tenantId: tenant.id, status: { in: ["APPROVED", "DISBURSED"] }, approvedAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
      _sum: { approvedAmount: true },
    }),
    prisma.lead.groupBy({
      by: ["assignedToId"],
      where: { tenantId: tenant.id, createdAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
    prisma.loanApplication.groupBy({
      by: ["assignedToId"],
      where: { tenantId: tenant.id, status: "DISBURSED", disbursedAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
  ])

  const assignedMap = Object.fromEntries(assignedApps.map((r) => [r.assignedToId, r._count]))
  const approvedMap = Object.fromEntries(approvedApps.map((r) => [r.assignedToId, { count: r._count, amount: Number(r._sum.approvedAmount ?? 0) }]))
  const leadsMap = Object.fromEntries(leads.map((r) => [r.assignedToId, r._count]))
  const disbursedMap = Object.fromEntries(loans.map((r) => [r.assignedToId, r._count]))

  const data = users.map((u) => {
    const assigned = assignedMap[u.id] ?? 0
    const approved = approvedMap[u.id]?.count ?? 0
    const approvedAmount = approvedMap[u.id]?.amount ?? 0
    const leadsCount = leadsMap[u.id] ?? 0
    const disbursed = disbursedMap[u.id] ?? 0
    const conversionRate = assigned > 0 ? Math.round((disbursed / assigned) * 100) : 0

    return {
      id: u.id,
      name: u.name ?? u.email,
      email: u.email,
      role: u.role,
      leadsCreated: leadsCount,
      applicationsAssigned: assigned,
      loansApproved: approved,
      approvedAmount,
      loansDisbursed: disbursed,
      conversionRate,
    }
  }).filter((u) => u.applicationsAssigned > 0 || u.leadsCreated > 0)

  return NextResponse.json({ data, fromDate: fromDate.toISOString(), toDate: now.toISOString() })
}
