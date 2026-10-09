import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { BranchesSettingsClient } from "./BranchesSettingsClient"

export default async function BranchesSettingsPage() {
  await requireMinRole("ADMIN")

  const tenant = await prisma.tenant.findFirst({ where: { status: "ACTIVE" } })
  if (!tenant) return null

  const [branches, managers] = await Promise.all([
    prisma.branch.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { users: true, applications: true, clients: true } },
      },
    }),
    prisma.user.findMany({
      where: { active: true, role: { in: ["BRANCH_MANAGER", "LOAN_ADMIN", "SUPER_ADMIN", "ADMIN"] } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ])

  return (
    <>
      <Header
        title="Settings"
        subtitle="Branch management"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Branches" },
        ]}
      />
      <BranchesSettingsClient
        initialBranches={branches.map((b) => ({
          id: b.id,
          name: b.name,
          code: b.code,
          address: b.address,
          phone: b.phone,
          managerId: b.managerId,
          active: b.active,
          userCount: b._count.users,
          applicationCount: b._count.applications,
          clientCount: b._count.clients,
          createdAt: b.createdAt.toISOString(),
        }))}
        managers={managers}
      />
    </>
  )
}
