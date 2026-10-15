import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Header } from "@/components/layout/Header"
import { SupportAccessPanel } from "@/components/settings/SupportAccessPanel"
import { grantState, listGrantableOperatorUsers, listSupportAudit, listTenantGrants } from "@/lib/operator/console/grants"
import { formatDateTime } from "@/lib/utils"

export const metadata = { title: "Support access — Settings" }

const ACTION_LABEL: Record<string, string> = {
  SUPPORT_ACCESS_GRANTED: "Granted",
  SUPPORT_ACCESS_REVOKED: "Revoked",
  SUPPORT_ACCESS_USED: "Used",
  SUPPORT_ACCESS_REFUSED: "Refused",
  SUPPORT_ACCESS_GRANT_REFUSED: "Grant refused",
}

const detailOf = (value: unknown): string => {
  if (!value || typeof value !== "object") return ""
  const v = value as Record<string, unknown>
  return [v.resource, v.reason, v.method].filter((x) => typeof x === "string" && x).join(" · ")
}

// Settings → Support access (ADMIN / SUPER_ADMIN): let one of the platform
// operator's staff in read-only for up to 7 days, revoke it, and see every
// use. Granting and revoking need a TOTP-verified sign-in
// (lib/operator/support-grants.ts).
export default async function SupportAccessSettingsPage() {
  const user = await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const now = new Date()
  const [grants, grantable, audit] = await Promise.all([
    listTenantGrants(tenantId), listGrantableOperatorUsers(tenantId), listSupportAudit(tenantId),
  ])

  return (
    <>
      <Header
        title="Support access"
        subtitle="Let your platform operator's support staff see your data, read-only, for a limited time."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Support access" }]}
      />
      <div className="p-4 lg:p-8 max-w-5xl">
        <SupportAccessPanel
          canManage={user.totpVerified === true}
          operatorName={grantable.operatorName}
          operatorUsers={grantable.users.map((u) => ({ id: u.id, label: `${u.name ?? u.email} (${u.email})` }))}
          grants={grants.map((g) => ({
            id: g.id,
            state: grantState(g, now),
            operatorUser: g.operatorUser.name ?? g.operatorUser.email,
            reason: g.reason,
            grantedBy: g.grantedBy.name ?? g.grantedBy.email,
            createdAt: formatDateTime(g.createdAt),
            endsAt: formatDateTime(g.revokedAt ?? g.expiresAt),
            revokedBy: g.revokedBy ? g.revokedBy.name ?? g.revokedBy.email : null,
          }))}
          audit={audit.map((a) => ({
            id: a.id,
            at: formatDateTime(a.createdAt),
            action: ACTION_LABEL[a.action] ?? a.action,
            who: a.userEmail ?? "—",
            detail: detailOf(a.newValue),
          }))}
        />
      </div>
    </>
  )
}
