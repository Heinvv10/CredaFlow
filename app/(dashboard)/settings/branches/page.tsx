import { notFound } from "next/navigation"
import { requireMinRole } from "@/lib/auth-guards"
import { getResolvedTenantId } from "@/lib/tenant"
import { BRANCH_MANAGER_ROLES } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { BranchesSettingsClient } from "./BranchesSettingsClient"

export default async function BranchesSettingsPage() {
  const user = await requireMinRole("ADMIN")
  const tenantId = await getResolvedTenantId()
  // withTenantContext's binding, for a page: a session never reads another
  // tenant's rows because the host resolved to it.
  if (user.tenantId !== tenantId) notFound()

  const [branches, managers] = await Promise.all([
    prisma.branch.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { users: true, applications: true, clients: true } },
      },
    }),
    prisma.user.findMany({
      // User is not tenant-scoped, so the tenantId filter is manual; the rest
      // is what POST /api/branches accepts.
      where: { tenantId, active: true, role: { in: BRANCH_MANAGER_ROLES } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ])

  return (
    <>
      <Header
        title="Branches"
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
