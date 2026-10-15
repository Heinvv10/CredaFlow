/**
 * Usage and billing counts per lender per calendar month (SAST). Aggregates
 * only: every figure is a groupBy count or sum, keyed by tenantId.
 *
 *  - applications     LoanApplication rows created in the month.
 *  - activeLoans      loans on the book at any point in the month: started
 *                     before it ended, not cancelled, and not closed
 *                     (closedAt) or written off (writeOffAt) before it began.
 *                     A loan still on the collectible book counts for every
 *                     month since its start.
 *  - disbursements    applications whose disbursedAt falls in the month, and
 *                     the principal (cents) of their loans.
 *  - providerApiCalls IntegrationLog rows (bureau, KYC, payment and other
 *                     third-party calls) in the month.
 *  - messagesSent     outbound Message rows sent (sentAt) in the month.
 */
import type { TenantStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { sastMonthStart, sastParts } from "@/lib/date/sast"

export type UsageMonth = { key: string; start: Date; end: Date }

export type LenderMonthUsage = {
  tenantId: string
  name: string
  slug: string
  status: TenantStatus
  applications: number
  activeLoans: number
  disbursements: number
  disbursedCents: number
  providerApiCalls: number
  messagesSent: number
}

/** "YYYY-MM" → the month's SAST bounds; anything else → the current SAST month. */
export function usageMonth(raw: string | null | undefined, now: Date = new Date()): UsageMonth {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw ?? "")
  const { year, month } = match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : sastParts(now)
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    start: sastMonthStart(year, month),
    end: sastMonthStart(year, month + 1),
  }
}

type Counted = Array<{ tenantId: string; _count: { _all: number } }>
const byTenant = (rows: Counted) => new Map(rows.map((r) => [r.tenantId, r._count._all]))

export async function operatorUsageForMonth(operatorId: string, month: UsageMonth): Promise<LenderMonthUsage[]> {
  const tenants = await prisma.tenant.findMany({
    where: { operatorId },
    select: { id: true, name: true, slug: true, status: true },
    orderBy: { name: "asc" },
  })
  if (tenants.length === 0) return []
  const tenantId = { in: tenants.map((t) => t.id) }
  const inMonth = { gte: month.start, lt: month.end }

  const [applications, activeLoans, disbursements, disbursedValue, apiCalls, messages] = await withoutTenantScope(async () => await Promise.all([
    prisma.loanApplication.groupBy({ by: ["tenantId"], where: { tenantId, createdAt: inMonth }, _count: { _all: true } }),
    prisma.loan.groupBy({
      by: ["tenantId"],
      where: {
        tenantId,
        startDate: { lt: month.end },
        status: { not: "CANCELLED" },
        OR: [
          { status: { in: [...COLLECTIBLE_STATUSES] } },
          { closedAt: { gte: month.start } },
          { writeOffAt: { gte: month.start } },
        ],
      },
      _count: { _all: true },
    }),
    prisma.loanApplication.groupBy({ by: ["tenantId"], where: { tenantId, disbursedAt: inMonth }, _count: { _all: true } }),
    prisma.loan.groupBy({ by: ["tenantId"], where: { tenantId, application: { disbursedAt: inMonth } }, _sum: { principal: true } }),
    prisma.integrationLog.groupBy({ by: ["tenantId"], where: { tenantId, createdAt: inMonth }, _count: { _all: true } }),
    prisma.message.groupBy({ by: ["tenantId"], where: { tenantId, direction: "OUTBOUND", sentAt: inMonth }, _count: { _all: true } }),
  ]))

  const apps = byTenant(applications)
  const active = byTenant(activeLoans)
  const disbursed = byTenant(disbursements)
  const value = new Map(disbursedValue.map((r) => [r.tenantId, r._sum.principal ?? 0]))
  const calls = byTenant(apiCalls)
  const sent = byTenant(messages)
  return tenants.map((t) => ({
    tenantId: t.id, name: t.name, slug: t.slug, status: t.status,
    applications: apps.get(t.id) ?? 0,
    activeLoans: active.get(t.id) ?? 0,
    disbursements: disbursed.get(t.id) ?? 0,
    disbursedCents: value.get(t.id) ?? 0,
    providerApiCalls: calls.get(t.id) ?? 0,
    messagesSent: sent.get(t.id) ?? 0,
  }))
}
