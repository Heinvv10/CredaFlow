import { prisma } from "@/lib/prisma"
import { arrearsWithCharges } from "@/lib/loan/charge-labels"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { COLLECTIONS_ELIGIBLE_STATUSES } from "@/lib/collections/section129-eligibility"
import { collectionsQueueWhere } from "@/lib/collections/queue"
import { formatZAR } from "@/lib/utils"
import { AlertTriangle } from "lucide-react"
import Link from "next/link"
import { BulkSection129Button } from "@/components/collections/BulkSection129Button"
import { CollectionsTabs } from "@/components/collections/CollectionsTabs"
import { getDefaultTenantId } from "@/lib/tenant"
import { getPortfolioPar } from "@/lib/reports/par"
import { getSection129ReservationAvailability } from "@/lib/collections/section129-artifact"


async function getCollectionsData(tenantId: string, chargesLive: boolean) {
  const loans = await prisma.loan.findMany({
    where: collectionsQueueWhere(tenantId, chargesLive),
    orderBy: { daysInArrears: "desc" },
    include: {
      client: true,
      product: { select: { name: true, productType: true } },
      notes: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, type: true, note: true } },
      paymentPlan: { select: { active: true, installments: true, installmentAmt: true, startDate: true } },
    },
  })
  // Arrears as shown to staff include default charges owed (the synced
  // summary column), only while charges are live.
  return loans.map((loan) => ({ ...loan, arrearsAmount: arrearsWithCharges(loan, chargesLive) }))
}

async function getPendingWriteOffs(tenantId: string) {
  // Loans with an open write-off request — excluded from the ACTIVE/DEFAULTED
  // queue above, so they need their own visible group or the maker-checker
  // approval step is unreachable (see write-off route.ts step 2).
  const loans = await prisma.loan.findMany({
    where: { tenantId, status: "PENDING_WRITE_OFF" },
    orderBy: { writeOffRequestedAt: "desc" },
    include: {
      client: { select: { firstName: true, lastName: true } },
    },
  })
  const requesterIds = [...new Set(loans.map((l) => l.writeOffRequestedById).filter((v): v is string => !!v))]
  const requesters = requesterIds.length
    ? await prisma.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true, email: true } })
    : []
  const requesterName = new Map(requesters.map((u) => [u.id, u.name ?? u.email]))
  return loans.map((l) => ({
    id: l.id,
    reference: l.reference,
    clientName: `${l.client.firstName} ${l.client.lastName}`,
    outstandingPrincipal: l.outstandingPrincipal,
    writeOffReason: l.writeOffReason,
    requestedBy: l.writeOffRequestedById ? requesterName.get(l.writeOffRequestedById) ?? "Unknown" : "Unknown",
  }))
}

async function getSection129DueCount(tenantId: string) {
  // Accounts at the S129 send threshold (90+ DPD, actually in arrears) with no
  // notice yet — matches the bulk-send action + alert banner so the "S129 Due"
  // header agrees with both.
  const loans = await prisma.loan.findMany({
    where: {
      tenantId,
      status: { in: [...COLLECTIONS_ELIGIBLE_STATUSES] },
      daysInArrears: { gte: 90 },
      arrearsAmount: { gt: 0 },
      // A fully-repaid loan carrying stale arrears (arrears > outstanding) must
      // not sit in the collections queue or count toward S129 (audit N-03/N-05).
      outstandingPrincipal: { gt: 0 },
    },
    select: { id: true },
  })

  let count = 0
  for (const loan of loans) {
    const availability = await getSection129ReservationAvailability(tenantId, loan.id)
    if (availability.canReserve) count++
  }
  return count
}

async function getStageBreakdown(tenantId: string, chargesLive: boolean) {
  const rows = await prisma.loan.groupBy({
    by: ["collectionsStage"],
    where: collectionsQueueWhere(tenantId, chargesLive),
    _count: { id: true },
    _sum: { arrearsAmount: true, chargesOutstanding: true },
  })
  return rows
    .filter((r) => r.collectionsStage !== "NONE")
    .map((r) => ({
      stage: r.collectionsStage as string,
      count: r._count.id,
      totalArrears: Number(r._sum.arrearsAmount ?? 0) + (chargesLive ? Number(r._sum.chargesOutstanding ?? 0) : 0),
    }))
    .sort((a, b) => b.totalArrears - a.totalArrears)
}

export default async function CollectionsPage() {
  const tenantId = await getDefaultTenantId()
  const chargesLive = await chargesLiveForTenant(prisma, tenantId)
  const [loans, s129DueCount, par, stageBreakdown, pendingWriteOffs] = await Promise.all([
    getCollectionsData(tenantId, chargesLive),
    getSection129DueCount(tenantId),
    getPortfolioPar(tenantId),
    getStageBreakdown(tenantId, chargesLive),
    getPendingWriteOffs(tenantId),
  ])

  const totalArrears = loans.reduce((sum, l) => sum + Number(l.arrearsAmount), 0)

  // PAR30: value-weighted on the collectible book — single definition shared with the
  // dashboard, reports and NCR return (lib/reports/par).
  const par30Pct = par.par30.pct.toFixed(1)

  const soft = loans.filter((l) => l.daysInArrears >= 1 && l.daysInArrears <= 29).length
  const hard = loans.filter((l) => l.daysInArrears >= 30 && l.daysInArrears <= 59).length
  const defaultRisk = loans.filter((l) => l.daysInArrears >= 60 && l.daysInArrears <= 89).length
  const legal = loans.filter((l) => l.daysInArrears >= 90).length

  const tabs = [
    { key: "all", label: "All Overdue", count: loans.length },
    { key: "soft", label: "Soft (1-29)", count: soft },
    { key: "hard", label: "Hard (30-59)", count: hard },
    { key: "default", label: "Default Risk (60-89)", count: defaultRisk },
    { key: "legal", label: "Legal (90+)", count: legal },
  ]

  // Serialize for client component
  const serialized = JSON.parse(JSON.stringify(loans))

  return (
    <div className="p-6 lg:p-8">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Overdue Accounts", value: String(loans.length), color: "text-red-600" },
          { label: "Total Arrears", value: formatZAR(totalArrears), color: "text-red-600" },
          { label: "PAR30", value: `${par30Pct}%`, color: Number(par30Pct) > 10 ? "text-red-600" : "text-green-600" },
          { label: "S129 Due", value: String(s129DueCount), color: s129DueCount > 0 ? "text-orange-500" : "text-green-600" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl shadow-sm p-4">
            <p className="text-xs text-gray-400 mb-1">{s.label}</p>
            <p className={`whitespace-nowrap text-xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Stage breakdown */}
      {stageBreakdown.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="px-5 py-3.5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Accounts by Collections Stage</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                  {["Stage", "Accounts", "Total Arrears"].map((h) => (
                    <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stageBreakdown.map((row, i) => {
                  const label = row.stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                  return (
                    <tr key={row.stage} className="border-b border-gray-50" style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}>
                      <td className="px-5 py-2.5 font-medium text-gray-800 text-[13px]">{label}</td>
                      <td className="px-5 py-2.5 text-gray-600 text-[13px]">{row.count}</td>
                      <td className="px-5 py-2.5 font-semibold text-red-600 text-[13px]">{formatZAR(row.totalArrears)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Page header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Collections Queue</h1>
          <p className="text-sm text-gray-400 mt-1">
            {loans.length} account{loans.length !== 1 ? "s" : ""} in arrears · Total exposure {formatZAR(totalArrears)}
          </p>
        </div>
        <BulkSection129Button count90Plus={s129DueCount} />
      </div>

      {/* Alert banner — accounts due a Section 129 notice (90+ DPD, in arrears, none sent yet) */}
      {s129DueCount > 0 && (
        <div className="flex items-center gap-3 px-5 py-3.5 rounded-lg border mb-5 text-sm" style={{ backgroundColor: "#FFFBEB", borderColor: "#FCD34D" }}>
          <AlertTriangle className="h-4 w-4 flex-shrink-0" style={{ color: "#D97706" }} />
          <p style={{ color: "#78350F" }}>
            {s129DueCount} account{s129DueCount !== 1 ? "s" : ""} at 90+ DPD {s129DueCount !== 1 ? "are" : "is"} due a Section 129 notice.{" "}
            <strong>Action required today.</strong>
          </p>
        </div>
      )}

      {/* Pending write-off approvals — a separate group, never mixed into the active queue */}
      {pendingWriteOffs.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 overflow-hidden mb-6">
          <div className="px-5 py-3.5 border-b border-amber-100 bg-amber-50">
            <h2 className="text-sm font-semibold text-amber-800">
              Pending Write-Off Approval ({pendingWriteOffs.length})
            </h2>
            <p className="text-xs text-amber-600 mt-0.5">Requires sign-off from a different officer than the one who requested it.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                  {["Client", "Loan Ref", "Outstanding", "Requested By", "Reason", ""].map((h) => (
                    <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingWriteOffs.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="px-5 py-2.5 font-medium text-gray-800 text-[13px]">{l.clientName}</td>
                    <td className="px-5 py-2.5 font-mono text-xs text-gray-600">{l.reference}</td>
                    <td className="px-5 py-2.5 font-semibold text-gray-900 text-[13px]">{formatZAR(l.outstandingPrincipal)}</td>
                    <td className="px-5 py-2.5 text-gray-600 text-[13px]">{l.requestedBy}</td>
                    <td className="px-5 py-2.5 text-gray-500 text-[12px] max-w-xs truncate">{l.writeOffReason}</td>
                    <td className="px-5 py-2.5">
                      <Link href={`/collections/${l.id}`} className="text-[12px] font-semibold text-[#4F46E5] hover:underline">Review</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tabs + Table */}
      {loans.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-12 text-center">
          <p className="text-green-700 font-semibold text-lg">No overdue accounts</p>
          <p className="text-green-600 text-sm mt-1">All loans are current</p>
        </div>
      ) : (
        <CollectionsTabs tabs={tabs} loans={serialized} />
      )}
    </div>
  )
}
