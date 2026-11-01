import { redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { BorrowerGroupsPanel } from "@/components/settings/product-types/BorrowerGroupsPanel"
import { requireMinRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = { title: "Lending groups — Settings" }

export default async function LendingGroupsPage() {
  const user = await requireMinRole("CREDIT_OFFICER")
  if (!canDo(user.role, "manage_borrower_groups")) redirect("/settings")
  const tenantId = await getStaffTenantId()
  const groups = await prisma.borrowerGroup.findMany({
    where: { tenantId }, orderBy: { name: "asc" },
    include: { members: { include: { client: { select: { id: true, firstName: true, lastName: true, idNumber: true } } } } },
  })
  const rows = groups.map((g) => ({ id: g.id, name: g.name, members: g.members.map((m) => ({ id: m.client.id, name: `${m.client.firstName} ${m.client.lastName}`, idNumber: m.client.idNumber })) }))
  return (
    <>
      <Header
        title="Lending groups"
        subtitle="The groups a group product lends to. A group loan is refused while any member is in arrears; members are not liable for each other's loans."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Products", href: "/settings/products" }, { label: "Lending groups" }]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6"><BorrowerGroupsPanel groups={rows} /></div>
    </>
  )
}
