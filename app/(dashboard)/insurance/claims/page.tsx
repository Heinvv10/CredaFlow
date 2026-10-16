import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { InsuranceClaimsClient } from "@/components/insurance/InsuranceClaimsClient"

export default async function ClaimsPage() {
  // Claim records carry client PII (name/phone) and the page assigns assessors —
  // gate at INSURANCE_OFFICER (was ungated: any staff incl READONLY could read).
  await requireMinRole("INSURANCE_OFFICER")
  const tenantId = await getStaffTenantId()

  const [raw, advisorUsers] = await Promise.all([
    prisma.insuranceClaim.findMany({
      where: { tenantId },
      orderBy: { submittedAt: "desc" },
      include: {
        policy: {
          select: {
            type: true,
            policyNumber: true,
            sumAssured: true,
            client: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
        assessor: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.user.findMany({
      where: {
        tenantId,
        active: true,
        role: { in: ["ADMIN", "INSURANCE_OFFICER", "LOAN_ADMIN"] },
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ])

  const claims = raw.map(c => ({
    ...c,
    policy: { ...c.policy, sumAssured: Number(c.policy.sumAssured) },
    claimAmount: Number(c.claimAmount),
    approvedAmount: c.approvedAmount ? Number(c.approvedAmount) : null,
  }))

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Insurance", href: "/insurance" },
          { label: "Claims" },
        ]}
      />
      <InsuranceClaimsClient claims={claims} advisors={advisorUsers} />
    </div>
  )
}
