import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { InsuranceDashboardClient } from "@/components/insurance/InsuranceDashboardClient"

async function getInsuranceData() {
  const [policies, claims, premiums] = await Promise.all([
    prisma.insurancePolicy.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, firstName: true, lastName: true, phone: true } },
        claims: { select: { id: true, status: true, claimAmount: true } },
      },
    }),
    prisma.insuranceClaim.findMany({
      orderBy: { submittedAt: "desc" },
      take: 10,
      include: {
        policy: {
          select: {
            type: true,
            policyNumber: true,
            client: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.premiumPayment.aggregate({
      where: { status: "PAID" },
      _sum: { amount: true },
    }),
  ])

  const activePolicies = policies.filter((p) => p.status === "ACTIVE")
  const monthlyPremiums = activePolicies.reduce((s, p) => s + Number(p.premiumAmount), 0)
  const commissionEarned = activePolicies.reduce((s, p) => s + Number(p.commissionAmount || 0), 0)
  const openClaims = claims.filter((c) => c.status === "SUBMITTED" || c.status === "UNDER_REVIEW").length

  // Serialize Decimal types for client components
  const serializedPolicies = policies.map(p => ({
    ...p,
    premiumAmount: Number(p.premiumAmount),
    sumAssured: Number(p.sumAssured),
    commissionRate: Number(p.commissionRate),
    commissionAmount: p.commissionAmount ? Number(p.commissionAmount) : null,
    claims: p.claims.map(c => ({ ...c, claimAmount: Number(c.claimAmount) })),
  }))
  const serializedClaims = claims.map(c => ({
    ...c,
    claimAmount: Number(c.claimAmount),
    approvedAmount: c.approvedAmount ? Number(c.approvedAmount) : null,
  }))

  return { policies: serializedPolicies, claims: serializedClaims, monthlyPremiums, commissionEarned, openClaims, totalCollected: Number(premiums._sum.amount || 0) }
}

export default async function InsurancePage() {
  await requireMinRole("READONLY")

  const data = await getInsuranceData()
  return (
    <div className="p-6 lg:p-8">
      <InsuranceDashboardClient {...data} />
    </div>
  )
}
