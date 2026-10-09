import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { formatZAR, formatDate } from "@/lib/utils"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { sastMonthBounds } from "@/lib/compliance/quarters"

async function getAdvisorData(monthsBack: number) {
  const now = new Date()
  // SAST boundary: the container has no TZ, so date parts resolve in UTC and
  // land two hours inside the previous South African day.
  const fromDate = sastMonthBounds(now, -(monthsBack - 1)).start
  const tenantId = await getDefaultTenantId()

  const users = await prisma.user.findMany({
    where: { tenantId, active: true },
    select: { id: true, name: true, email: true, role: true },
  })

  const [assignedApps, approvedApps, leads, disbursed] = await Promise.all([
    prisma.loanApplication.groupBy({
      by: ["assignedToId"],
      where: { tenantId, createdAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
    // By assignee like every other column, so each row is one advisor's
    // funnel. It was by approver, which credited approvals to whoever signed
    // them off and showed advisors disbursing more than they had approved.
    prisma.loanApplication.groupBy({
      by: ["assignedToId"],
      where: { tenantId, status: { in: ["APPROVED", "DISBURSED"] }, approvedAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
      _sum: { approvedAmount: true },
    }),
    prisma.lead.groupBy({
      by: ["assignedToId"],
      where: { tenantId, createdAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
    prisma.loanApplication.groupBy({
      by: ["assignedToId"],
      where: { tenantId, status: "DISBURSED", disbursedAt: { gte: fromDate }, assignedToId: { not: null } },
      _count: true,
    }),
  ])

  const assignedMap = Object.fromEntries(assignedApps.map((r) => [r.assignedToId!, r._count]))
  const approvedMap = Object.fromEntries(approvedApps.map((r) => [r.assignedToId!, { count: r._count, amount: Number(r._sum.approvedAmount ?? 0) }]))
  const leadsMap = Object.fromEntries(leads.map((r) => [r.assignedToId!, r._count]))
  const disbursedMap = Object.fromEntries(disbursed.map((r) => [r.assignedToId!, r._count]))

  return {
    fromDate,
    advisors: users.map((u) => {
      const assigned = assignedMap[u.id] ?? 0
      const appsDisbursed = disbursedMap[u.id] ?? 0
      return {
        id: u.id,
        name: u.name ?? u.email,
        email: u.email,
        role: u.role,
        leadsCreated: leadsMap[u.id] ?? 0,
        applicationsAssigned: assigned,
        loansApproved: approvedMap[u.id]?.count ?? 0,
        approvedAmount: approvedMap[u.id]?.amount ?? 0,
        loansDisbursed: appsDisbursed,
        conversionRate: assigned > 0 ? Math.round((appsDisbursed / assigned) * 100) : 0,
      }
    }).sort((a, b) => b.loansDisbursed - a.loansDisbursed),
  }
}

export default async function AdvisorReportPage() {
  await requireMinRole("LOAN_ADMIN")
  const { fromDate, advisors } = await getAdvisorData(6)

  return (
    <div>
      <div className="bg-[var(--cf-bg-panel)] border-b border-[var(--cf-border-subtle)] px-6 py-3.5 flex items-center justify-between">
        <div>
          <Breadcrumbs
            className="mb-1.5"
            items={[
              { label: "Reports", href: "/reports" },
              { label: "Advisor" },
            ]}
          />
          <h1 className="text-[17px] font-bold text-[var(--cf-text)]">Advisor Performance</h1>
          <p className="text-[11px] text-[var(--cf-text-muted)]">
            6-month view · from {formatDate(fromDate)}
          </p>
        </div>
        <a
          href="/api/reports/export?type=loans"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--cf-success)] text-[#0b0d12] rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity"
        >
          Export Excel
        </a>
      </div>

      <div className="p-6">
        {advisors.length === 0 ? (
          <div className="bg-[var(--cf-bg-panel)] rounded-lg border border-[var(--cf-border-subtle)] p-12 text-center text-[var(--cf-text-muted)]">
            No advisor activity in the last 6 months
          </div>
        ) : (
          <div className="bg-[var(--cf-bg-panel)] rounded-lg border border-[var(--cf-border-subtle)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--cf-bg-subtle)] border-b border-[var(--cf-border-subtle)]">
                <tr>
                  {["Advisor", "Role", "Leads", "Applications", "Approved", "Disbursed", "Conversion", "Approved Value"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--cf-text-muted)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cf-border-subtle)]">
                {advisors.map((a) => (
                  <tr key={a.id} className="hover:bg-[var(--cf-bg-subtle)]">
                    <td className="px-4 py-3">
                      <p className="font-medium text-[var(--cf-text)]">{a.name}</p>
                      <p className="text-[11px] text-[var(--cf-text-muted)]">{a.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[11px] px-2 py-0.5 rounded bg-[var(--cf-bg-subtle)] text-[var(--cf-text-secondary)] font-medium">
                        {a.role.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-[var(--cf-text)]">{a.leadsCreated}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--cf-text)]">{a.applicationsAssigned}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--cf-text)]">{a.loansApproved}</td>
                    <td className="px-4 py-3 font-semibold text-[var(--cf-text)]">{a.loansDisbursed}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-[var(--cf-bg-subtle)] rounded-full h-2 overflow-hidden" style={{ minWidth: "60px" }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${a.conversionRate}%`,
                              backgroundColor: a.conversionRate >= 60 ? "var(--cf-success)" : a.conversionRate >= 30 ? "var(--cf-warning)" : "var(--cf-danger)",
                            }}
                          />
                        </div>
                        <span className="text-[12px] font-semibold text-[var(--cf-text)]">{a.conversionRate}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold text-[var(--cf-brand)]">
                      {a.approvedAmount > 0 ? formatZAR(a.approvedAmount) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
