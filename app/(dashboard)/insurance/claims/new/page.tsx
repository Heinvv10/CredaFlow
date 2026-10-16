import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { NewClaimForm } from "@/components/insurance/NewClaimForm"

// Lodging a claim is the claims page's own gate and POST /api/insurance/claims's.
export default async function NewClaimPage() {
  await requireMinRole("INSURANCE_OFFICER")
  const tenantId = await getStaffTenantId()

  const policies = await prisma.insurancePolicy.findMany({
    where: { tenantId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      policyNumber: true,
      type: true,
      sumAssured: true,
      client: { select: { firstName: true, lastName: true, email: true } },
    },
  })

  return (
    <div className="p-6 lg:p-8 max-w-2xl">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Insurance", href: "/insurance" },
          { label: "Claims", href: "/insurance/claims" },
          { label: "New claim" },
        ]}
      />
      <h1 className="text-2xl font-bold text-[#1b1d24] mb-1">Lodge a claim</h1>
      <p className="text-sm text-gray-500 mb-6">
        Record the client&apos;s claim against an active policy. The insurer assesses and decides it.
      </p>
      <NewClaimForm
        policies={policies.map((p) => ({
          id: p.id,
          policyNumber: p.policyNumber,
          type: p.type,
          sumAssured: Number(p.sumAssured),
          clientName: `${p.client.firstName} ${p.client.lastName}`,
          clientEmail: p.client.email,
        }))}
      />
    </div>
  )
}
