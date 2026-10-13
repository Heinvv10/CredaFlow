import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { UserTable } from "@/components/settings/UserTable"
import { Header } from "@/components/layout/Header"

export default async function UsersPage() {
  const user = await requireMinRole("BRANCH_MANAGER")
  const staffTotpRequired = await isStaffTotpRequired(await getStaffTenantId())

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
        <UserTable
          currentUserId={user.id}
          currentUserRole={user.role}
          currentUserTotpVerified={user.totpVerified === true}
          staffTotpRequired={staffTotpRequired}
        />
      </div>
    </>
  )
}
