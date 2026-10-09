import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { BreachLogClient } from "@/components/compliance/BreachLogClient"

export default async function BreachLogPage() {
  await requireMinRole("LOAN_ADMIN")
  const logs = await prisma.breachLog.findMany({
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
