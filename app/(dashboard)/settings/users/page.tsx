import { requireMinRole } from "@/lib/auth-guards"
import { UserTable } from "@/components/settings/UserTable"
import { Header } from "@/components/layout/Header"

export default async function UsersPage() {
  const user = await requireMinRole("BRANCH_MANAGER")

  return (
    <>
      <Header
        title="Settings"
        subtitle="User management"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Users" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <UserTable currentUserId={user.id} currentUserRole={user.role} />
      </div>
    </>
  )
}
