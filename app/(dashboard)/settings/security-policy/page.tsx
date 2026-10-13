import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getStaffTotpPolicyState } from "@/lib/security/staff-totp-policy"
import { formatDateTime } from "@/lib/utils"
import { StaffTotpPolicyToggle } from "@/components/settings/StaffTotpPolicyToggle"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Security & KYC policy — Settings",
}

export default async function SecurityPolicySettingsPage() {
  // Visible to ADMIN and above; only a SUPER_ADMIN changes the 2FA setting.
  const user = await requireMinRole("ADMIN")
  const state = await getStaffTotpPolicyState(await getStaffTenantId())
  const lastChange = state.lastChange
    ? `Last changed by ${state.lastChange.byEmail ?? "unknown"} on ${formatDateTime(state.lastChange.at)}.`
    : null

  return (
    <>
      <Header
        title="Security & KYC policy"
        subtitle="Rules this lender applies to its staff and its customer checks."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Security & KYC policy" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <StaffTotpPolicyToggle
          requireStaffTotp={state.required}
          canChange={user.role === "SUPER_ADMIN"}
          lastChange={lastChange}
        />
        {/* KYC override policy: its own card goes here, added by the KYC workstream. */}
      </div>
    </>
  )
}
