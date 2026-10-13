import { prisma } from "@/lib/prisma"
import { notFound } from "next/navigation"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { PolicyDetailClient } from "@/components/insurance/PolicyDetailClient"
import { getStaffTenantId } from "@/lib/session-tenant"

export default async function PolicyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // Pages run outside a tenant frame: this predicate keeps another lender's
  // policy out, and the tenant-scope extension throws without it.
  const tenantId = await getStaffTenantId()

  const policy = await prisma.insurancePolicy.findFirst({
    where: { id, tenantId },
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          idNumber: true,
          phone: true,
          email: true,
        },
      },
      claims: { orderBy: { submittedAt: "desc" } },
      premiumPayments: { orderBy: { dueDate: "asc" } },
      beneficiaries: { orderBy: { createdAt: "asc" } },
    },
  })

  if (!policy) notFound()

  // Serialize Decimal types
  const serialized = {
    ...policy,
    premiumAmount: Number(policy.premiumAmount),
    sumAssured: Number(policy.sumAssured),
    commissionRate: Number(policy.commissionRate),
    commissionAmount: policy.commissionAmount ? Number(policy.commissionAmount) : null,
    pprIssuedAt: policy.pprIssuedAt ?? null,
    pprAcknowledgedAt: policy.pprAcknowledgedAt ?? null,
    pprAcknowledgedBy: policy.pprAcknowledgedBy ?? null,
    claims: policy.claims.map((c) => ({
      ...c,
      claimAmount: Number(c.claimAmount),
      approvedAmount: c.approvedAmount ? Number(c.approvedAmount) : null,
    })),
    premiumPayments: policy.premiumPayments.map((p) => ({
      ...p,
      amount: Number(p.amount),
    })),
    beneficiaries: policy.beneficiaries.map((b) => ({
      ...b,
      coverAmount: b.coverAmount ? Number(b.coverAmount) : null,
    })),
  }

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Insurance", href: "/insurance" },
          { label: policy.policyNumber },
        ]}
      />
      <PolicyDetailClient policy={serialized} />
    </div>
  )
}
