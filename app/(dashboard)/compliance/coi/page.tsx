import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { CoiClient, type CoiRosterRow } from "@/components/compliance/CoiClient"
import { getStaffTenantId } from "@/lib/session-tenant"
import { sastParts } from "@/lib/date/sast"

function buildYearOptions(current: number, n: number = 5): number[] {
  return Array.from({ length: n }, (_, i) => current - i)
}

export default async function CoiPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const viewer = await requireMinRole("LOAN_ADMIN")

  const sp = await searchParams
  // SAST year: on 1 January between 00:00 and 02:00 SAST the UTC year is
  // still the old one, and a conflict-of-interest declaration would be filed
  // against the wrong period.
  const currentYear = sastParts(new Date()).year
  const parsed = sp.year ? parseInt(sp.year, 10) : NaN
  const minYear = currentYear - 4
  const inRange = Number.isFinite(parsed) && parsed >= minYear && parsed <= currentYear
  const year = inRange ? parsed : currentYear

  const tenantId = await getStaffTenantId()

  const users = await prisma.user.findMany({
    where: { tenantId, active: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      coiDeclarations: {
        where: { year },
        select: { id: true, hasConflict: true, details: true, declaredAt: true },
        take: 1,
      },
    },
  })

  const rows: CoiRosterRow[] = users.map((u) => {
    const d = u.coiDeclarations[0]
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      declarationId: d?.id,
      hasConflict: d?.hasConflict,
      details: d?.details ?? null,
      declaredAt: d?.declaredAt.toISOString(),
    }
  })

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "COI" },
        ]}
      />
      <CoiClient
        rows={rows}
        year={year}
        yearOptions={buildYearOptions(currentYear)}
        viewerId={viewer.id}
        viewerRole={viewer.role}
      />
    </div>
  )
}
