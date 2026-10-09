import { requireRole } from "@/lib/auth-guards"
import { hasMinRole } from "@/lib/permissions"
import { InsurersTable } from "@/components/settings/InsurersTable"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Insurers — Settings",
}

export default async function InsurersPage() {
  const user = await requireRole(["ADMIN", "LOAN_ADMIN", "SUPER_ADMIN", "INSURANCE_OFFICER"])

  // The page allows LOAN_ADMIN/INSURANCE_OFFICER to view, but the write
  // routes (app/api/insurers/*) require ADMIN — gate the table's write
  // actions so those roles don't fill in forms that 403.
  const canWrite = hasMinRole(user.role, "ADMIN")

  return (
    <>
      <Header
        title="Settings"
        subtitle="Insurer management"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Insurers" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <InsurersTable canWrite={canWrite} />
      </div>
    </>
  )
}
