import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { getResolvedTenantId } from "@/lib/tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { BreachLogClient } from "@/components/compliance/BreachLogClient"

export default async function BreachLogPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getResolvedTenantId()
  // withTenantContext's binding, for a page: a session never reads another
  // tenant's rows because the host resolved to it.
  if (user.tenantId !== tenantId) notFound()
  const logs = await prisma.breachLog.findMany({
    where: { tenantId },
    orderBy: { incidentDate: "desc" },
  })

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "Breach log" },
        ]}
      />
      <BreachLogClient logs={logs} />
    </div>
  )
}
