import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { findLenderIdentity } from "@/lib/config/identity"
import { auth } from "@/lib/auth"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth"
import { ComplianceDashboardClient } from "@/components/compliance/ComplianceDashboardClient"
import {
  buildComplianceHealth,
  complianceWhere,
  groupOf,
  type ComplianceGroup,
} from "@/lib/compliance/record-types"
import {
  COMPLIANCE_GROUPS,
  parseGroup,
  parseType,
  typesInGroup,
  toDashboardClientRecord,
} from "@/lib/compliance/dashboard"
import { defaultQuarter, quarterLabel } from "@/lib/compliance/quarters"

export const dynamic = "force-dynamic"

/** Rows rendered at once. The table used to fetch every record unbounded. */
const ROW_CAP = 200

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; type?: string }>
}) {
  await requireMinRole("READONLY")

  const session = await auth()
  const role = session?.user?.role as AppRole | undefined
  const canViewBureauOverrides = role !== undefined && role !== "CLIENT" && hasMinRole(role, "LOAN_ADMIN")
  const canReconcileSection129 = role !== undefined && role !== "CLIENT" && hasMinRole(role, "LOAN_ADMIN")

  const params = await searchParams
  const group = parseGroup(params.group)
  const type = parseType(params.type)

  const tenantId = await getDefaultTenantId()
  const lender = await findLenderIdentity(tenantId)
  const now = new Date()

  // The quarter a return is currently due for: the one that has just closed.
  const dueQuarter = defaultQuarter(now)

  const rowWhere = {
    tenantId,
    ...(type ? { type } : group ? { type: { in: typesInGroup(group) } } : {}),
  }

  const [healthCounts, typeCounts, rows, bureauOverrideCount, ncrRecord] = await Promise.all([
    // The health summary spans every record, not the filtered or capped page —
    // a score that changed when you clicked a tab would be nonsense — but it is
    // COUNTED, not fetched. The register groups grow with loan volume.
    Promise.all([
      prisma.complianceRecord.count({ where: complianceWhere.obligations(tenantId) }),
      prisma.complianceRecord.count({ where: complianceWhere.completeObligations(tenantId) }),
      prisma.complianceRecord.count({ where: complianceWhere.overdueObligations(tenantId, now) }),
      prisma.complianceRecord.count({ where: complianceWhere.openObligationsWithoutDueDate(tenantId) }),
      prisma.complianceRecord.count({ where: complianceWhere.openExceptions(tenantId) }),
    ]),
    prisma.complianceRecord.groupBy({
      by: ["type"],
      where: { tenantId },
      _count: true,
    }),
    prisma.complianceRecord.findMany({
      where: rowWhere,
      orderBy: { createdAt: "desc" },
      take: ROW_CAP + 1,
    }),
    canViewBureauOverrides
      ? prisma.loanApplication.count({ where: { tenantId, bureauOverrideAt: { not: null } } })
      : Promise.resolve(null as number | null),
    // Status of the return actually due, rather than "is there any PENDING row
    // anywhere". The card previously fell through to a hardcoded SUBMITTED
    // badge whenever no PENDING row existed — including when no NCR record had
    // ever been created, which is the case on a fresh deployment.
    // A filed return outranks any other row for the quarter. Ordering by
    // createdAt alone let a later PENDING row mask an earlier SUBMITTED one and
    // report a filed quarter as outstanding, so submitted rows are preferred
    // first and only then the most recent.
    prisma.complianceRecord.findFirst({
      where: {
        tenantId,
        type: "NCR_QUARTERLY_RETURN",
        data: { path: ["quarter"], equals: dueQuarter },
      },
      orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { status: true, completedAt: true, dueDate: true },
    }),
  ])

  const [obligations, complete, overdue, openWithoutDueDate, openExceptions] = healthCounts
  const health = buildComplianceHealth({
    obligations, complete, overdue, openWithoutDueDate, openExceptions,
  })

  const groupCounts = Object.fromEntries(COMPLIANCE_GROUPS.map((g) => [g, 0])) as Record<ComplianceGroup, number>
  let totalCount = 0
  for (const row of typeCounts) {
    groupCounts[groupOf(row.type)] += row._count
    totalCount += row._count
  }

  const overLimit = rows.length > ROW_CAP
  const visible = overLimit ? rows.slice(0, ROW_CAP) : rows

  // The client component must never receive the full ComplianceRecord.data
  // payload — see toDashboardClientRecord, which is where that redaction lives
  // and is tested.
  const clientRecords = visible.map((record) => toDashboardClientRecord(record, now))

  return (
    <div className="p-6 lg:p-8">
      <ComplianceDashboardClient
        records={clientRecords}
        health={health}
        totalCount={totalCount}
        groupCounts={groupCounts}
        activeGroup={group}
        activeType={type}
        overLimit={overLimit}
        rowCap={ROW_CAP}
        bureauOverrideCount={bureauOverrideCount}
        canReconcileSection129={canReconcileSection129}
        ncrReturn={{
          ncrNumber: lender?.ncrNumber ?? null,
          quarter: dueQuarter,
          quarterLabel: quarterLabel(dueQuarter),
          status: ncrRecord?.status ?? null,
          completedAt: ncrRecord?.completedAt ?? null,
          dueDate: ncrRecord?.dueDate ?? null,
        }}
      />
    </div>
  )
}
