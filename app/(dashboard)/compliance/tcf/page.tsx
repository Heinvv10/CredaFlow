import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { TcfClient } from "@/components/compliance/TcfClient"
import { getDefaultTenantId } from "@/lib/tenant"
import { currentQuarter } from "@/lib/compliance/quarters"

// The SAST quarter, from the same helper the NCR and FSCA returns use — three
// definitions of "Q3" on one system is how a figure means two things at once.
const currentPeriod = currentQuarter

export default async function TcfPage() {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  const outcomes = await prisma.tcfOutcome.findMany({
    where: { tenantId },
    orderBy: { period: "desc" },
  })

  // Serialise dates so the client component receives plain JSON
  const serialised = outcomes.map((o) => ({
    id: o.id,
    period: o.period,
    outcome1: o.outcome1,
    outcome2: o.outcome2,
    outcome3: o.outcome3,
    outcome4: o.outcome4,
    outcome5: o.outcome5,
    outcome6: o.outcome6,
    notes: o.notes,
    completedBy: o.completedBy,
    completedAt: o.completedAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  }))

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "TCF" },
        ]}
      />
      <TcfClient outcomes={serialised} currentPeriod={currentPeriod()} />
    </div>
  )
}
