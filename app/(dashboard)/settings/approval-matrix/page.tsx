import { redirect } from "next/navigation"
import { ApprovalMatrixWorkspace } from "@/components/settings/approval-matrix/ApprovalMatrixWorkspace"
import { Header } from "@/components/layout/Header"
import { loadApprovalMatrixOverview } from "@/lib/approval/overview"
import { requireMinRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = {
  title: "Approval Matrix — Settings",
}

export default async function ApprovalMatrixSettingsPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  if (!canDo(user.role, "view_approval_matrix")) redirect("/settings")
  const overview = await loadApprovalMatrixOverview(await getStaffTenantId(), user)
  return (
    <>
      <Header
        title="Approval Matrix"
        subtitle="Multi-level approval by amount, product, risk grade and branch, with delegated authority and escalation when a decision is overdue. Every change needs a second person's approval."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Approval Matrix" }]}
      />
      <div className="p-4 lg:p-8 max-w-6xl space-y-6">
        <ApprovalMatrixWorkspace overview={overview} />
      </div>
    </>
  )
}
