import { requireOperatorPage } from "@/lib/operator/console-auth"
import { listOperatorUsers } from "@/lib/operator/console/operator-users"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { OperatorUsersPanel } from "@/components/operator/OperatorUsersPanel"
import { formatDateTime } from "@/lib/utils"

export const dynamic = "force-dynamic"

// The operator's own staff (OPERATOR_ADMIN only).
export default async function OperatorUsersPage() {
  const principal = await requireOperatorPage({ admin: true })
  const users = await listOperatorUsers(principal.operatorId)

  return (
    <>
      <OperatorPageTitle
        title="Operator users"
        subtitle="Admins create and suspend lenders and manage this list; support staff view lenders and use the grants lenders give them."
      />
      <OperatorUsersPanel
        selfId={principal.id}
        users={users.map((u) => ({
          id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, totpEnabled: u.totpEnabled,
          lastLoginAt: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : null,
        }))}
      />
    </>
  )
}
