import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import {
  parseFilter,
  buildWhere,
  type BureauOverrideFilter,
} from "@/lib/compliance/bureau-overrides"
import {
  BureauOverridesTable,
  type BureauOverrideRow,
} from "@/components/compliance/BureauOverridesTable"
import { borrowerDisplayName } from "@/lib/borrower"

const HARD_CAP = 200

const STATUS_OPTIONS = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "DECLINED",
  "DISBURSED",
  "CANCELLED",
] as const

function maskIdNumber(id: string | null | undefined): string {
  if (!id) return "—"
  if (id.length < 10) return id
  return `${id.slice(0, 6)}••••${id.slice(-4)}`
}

function toSearchParams(searchParams: Record<string, string | string[] | undefined>): URLSearchParams {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") sp.set(k, v)
  }
  return sp
}

export default async function BureauOverridesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()

  const sp = toSearchParams(await searchParams)
  const filter: BureauOverrideFilter = parseFilter(sp)

  const applications = await prisma.loanApplication.findMany({
    where: buildWhere(tenantId, filter),
    include: {
      client: { select: { firstName: true, lastName: true, idNumber: true } },
      entity: { select: { legalName: true } },
      bureauOverrideBy: { select: { name: true, email: true } },
    },
    orderBy: { bureauOverrideAt: "desc" },
    take: HARD_CAP + 1,
  })

  const overLimit = applications.length > HARD_CAP
  const visible = overLimit ? applications.slice(0, HARD_CAP) : applications

  const rows: BureauOverrideRow[] = visible.map((a) => ({
    applicationId: a.id,
    reference: a.reference,
    status: a.status,
    clientName: borrowerDisplayName(a),
    clientIdMasked: a.client ? maskIdNumber(a.client.idNumber) : "—",
    // Non-null by `buildWhere` invariant: `bureauOverrideAt: { not: null }`.
    overrideAt: a.bureauOverrideAt!,
    overrideByName: a.bureauOverrideBy?.name ?? a.bureauOverrideBy?.email ?? "—",
    overrideReason: a.bureauOverrideReason ?? "—",
  }))

  const fromValue = sp.get("from") ?? ""
  const toValue = sp.get("to") ?? ""
  const statusValue = sp.get("status") ?? ""

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "Bureau overrides" },
        ]}
      />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1b1d24]">Bureau s.81 overrides</h1>
        <p className="text-sm text-gray-500 mt-1">
          Every application where staff bypassed the NCA s.81 bureau-check gate. Read-only.
        </p>
      </div>

      <form method="GET" className="bg-white rounded-2xl shadow-sm p-4 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide flex flex-col gap-1">
          From
          <input
            type="date"
            name="from"
            defaultValue={fromValue}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800"
          />
        </label>
        <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide flex flex-col gap-1">
          To
          <input
            type="date"
            name="to"
            defaultValue={toValue}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800"
          />
        </label>
        <label className="text-xs text-gray-500 font-semibold uppercase tracking-wide flex flex-col gap-1">
          Status
          <select
            name="status"
            defaultValue={statusValue}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800"
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            className="px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] w-full md:w-auto"
          >
            Apply filters
          </button>
        </div>
      </form>

      {overLimit ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          Showing the {HARD_CAP} most recent — narrow the date range to see older overrides.
        </div>
      ) : null}

      <BureauOverridesTable rows={rows} />
    </div>
  )
}
