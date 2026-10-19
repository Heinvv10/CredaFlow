import { prisma } from "@/lib/prisma"
import { loadHeadlinePremiums } from "@/lib/insurance/headline-premium"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { PolicyCreationWizard } from "@/components/insurance/PolicyCreationWizard"

async function getNewPolicyData() {
  const tenantId = await getStaffTenantId()
  const [clients, advisors, products] = await Promise.all([
    prisma.client.findMany({
      where: { tenantId },
      select: { id: true, email: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
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
    prisma.insuranceProduct.findMany({
      where: { active: true, tenantId },
      select: {
        id: true,
        name: true,
        type: true,
        premiumAmount: true,
        sumAssured: true,
        commissionRate: true,
        active: true,
        code: true,
        insurer: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
  ])

  const headlines = await loadHeadlinePremiums(
    prisma,
    tenantId,
    products.map((p) => ({ id: p.id, premiumAmount: Number(p.premiumAmount) })),
  )

  return {
    clients,
    advisors,
    // Serialize Decimal fields so they pass the client component boundary
    products: products.map(({ insurer, ...p }) => ({
      ...p,
      insurerName: insurer?.name ?? null,
      premiumAmount: Number(p.premiumAmount),
      headlinePremium: headlines.get(p.id)?.amount ?? Number(p.premiumAmount),
      headlineIsFrom: headlines.get(p.id)?.from ?? false,
      headlineCover: headlines.get(p.id)?.cover ?? null,
      sumAssured: Number(p.sumAssured),
      commissionRate: Number(p.commissionRate),
    })),
  }
}

export default async function NewPolicyPage() {
  // Issuing a policy is INSURANCE_OFFICER and above (POST /api/insurance/policies/draft),
  // and the page lists every client: a role that cannot issue does not open it.
  await requireMinRole("INSURANCE_OFFICER")
  const { clients, advisors, products } = await getNewPolicyData()

  return (
    <div className="p-6 lg:p-8 max-w-2xl">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Insurance", href: "/insurance" },
          { label: "New policy" },
        ]}
      />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1b1d24]">Issue New Policy</h1>
        <p className="text-sm text-gray-500 mt-1">
          Create a new insurance policy for a client
        </p>
      </div>
      <PolicyCreationWizard
        clients={clients}
        advisors={advisors}
        products={products}
      />
    </div>
  )
}
