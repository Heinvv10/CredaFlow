import { headers } from "next/headers"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getStaffTotpPolicyState } from "@/lib/security/staff-totp-policy"
import { formatDateTime } from "@/lib/utils"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { callerIpFromHeaders } from "@/lib/rate-limit"
import { StaffTotpPolicyToggle } from "@/components/settings/StaffTotpPolicyToggle"
import { Header } from "@/components/layout/Header"
import { getKycOverridePolicyState } from "@/lib/kyc/override-policy"
import { KycOverridePolicyCard } from "@/components/settings/KycOverridePolicyCard"
import { readStaffAccessColumns } from "@/lib/security/staff-access-enforcement"
import { policyFromConfig } from "@/lib/security/staff-access-policy"
import { getPortalPolicy } from "@/lib/portal/portal-policy"
import { StaffAccessPolicyCard } from "@/components/settings/StaffAccessPolicyCard"
import { PortalSigningPolicyCard } from "@/components/settings/PortalSigningPolicyCard"
import { getSegregationOfDutiesState } from "@/lib/security/segregation-of-duties"
import { SegregationOfDutiesToggle } from "@/components/settings/SegregationOfDutiesToggle"
import { getDecisionRetentionState } from "@/lib/learning-loop/retention/policy"
import { DecisionRetentionCard } from "@/components/settings/DecisionRetentionCard"

export const metadata = {
  title: "Security & KYC policy — Settings",
}

async function lastChangeOf(tenantId: string, action: string): Promise<string | null> {
  const last = await prisma.auditLog.findFirst({
    where: { tenantId, action, entity: "TenantConfig", entityId: tenantId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, userEmail: true },
  })
  return last ? `Last changed by ${last.userEmail ?? "unknown"} on ${formatDateTime(last.createdAt)}.` : null
}

export default async function SecurityPolicySettingsPage() {
  // Visible to ADMIN and above; only a SUPER_ADMIN changes the policies,
  // except segregation of duties, which an ADMIN changes too.
  const user = await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const [state, kycState, accessColumns, portalPolicy, accessChange, portalChange, requestHeaders, sod, retention] = await Promise.all([
    getStaffTotpPolicyState(tenantId),
    getKycOverridePolicyState(tenantId),
    readStaffAccessColumns(tenantId),
    getPortalPolicy(tenantId),
    lastChangeOf(tenantId, AuditAction.STAFF_ACCESS_POLICY_UPDATED),
    lastChangeOf(tenantId, AuditAction.PORTAL_POLICY_UPDATED),
    headers(),
    getSegregationOfDutiesState(tenantId),
    getDecisionRetentionState(tenantId),
  ])
  const access = policyFromConfig(accessColumns)
  const lastChange = state.lastChange
    ? `Last changed by ${state.lastChange.byEmail ?? "unknown"} on ${formatDateTime(state.lastChange.at)}.`
    : null
  const canChange = user.role === "SUPER_ADMIN"

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
          canChange={canChange}
          lastChange={lastChange}
        />
        <SegregationOfDutiesToggle
          required={sod.required}
          canChange={user.role === "ADMIN" || user.role === "SUPER_ADMIN"}
          lastChange={sod.lastChange
            ? `Last changed by ${sod.lastChange.byEmail ?? "unknown"} on ${formatDateTime(sod.lastChange.at)}.`
            : null}
        />
        <StaffAccessPolicyCard
          hours={access.hours}
          ipAllowlist={access.ipAllowlist}
          callerIp={callerIpFromHeaders(requestHeaders)}
          canChange={canChange}
          lastChange={accessChange}
        />
        <PortalSigningPolicyCard
          requireSigningOtp={portalPolicy.requireSigningOtp}
          signingOtpBranchExempt={portalPolicy.signingOtpBranchExempt}
          allowNewRegistrations={portalPolicy.allowNewRegistrations}
          portalEnabled={portalPolicy.portalEnabled}
          canChange={canChange}
          lastChange={portalChange}
        />
        <DecisionRetentionCard
          months={retention.months}
          canChange={canChange}
          lastChange={retention.lastChange
            ? `Last changed by ${retention.lastChange.byEmail ?? "unknown"} on ${formatDateTime(retention.lastChange.at)}.`
            : null}
        />
        <KycOverridePolicyCard
          enabled={kycState.enabled}
          minRole={kycState.minRole}
          secondApprover={kycState.secondApprover}
          canChange={canChange}
          lastChange={kycState.lastChange
            ? `Last changed by ${kycState.lastChange.byEmail ?? "unknown"} on ${formatDateTime(kycState.lastChange.at)}.`
            : null}
        />
      </div>
    </>
  )
}
