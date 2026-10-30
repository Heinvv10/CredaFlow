import { redirect } from "next/navigation"
import { DecisionRulesWorkspace } from "@/components/settings/decision-rules/DecisionRulesWorkspace"
import type { Overview } from "@/components/settings/decision-rules/types"
import { Header } from "@/components/layout/Header"
import { requireMinRole } from "@/lib/auth-guards"
import { loadDecisioningOverview } from "@/lib/decisioning/overview"
import { canDo } from "@/lib/permissions"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = {
  title: "Decision Rules — Settings",
}

export default async function DecisionRulesSettingsPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  if (!canDo(user.role, "view_decision_rules")) redirect("/settings")
  const overview = await loadDecisioningOverview(await getStaffTenantId(), user)
  // The overview is plain JSON (dates are strings), safe to hand to the client.
  const props = { ...overview, canManage: canDo(user.role, "manage_decision_rules"), canApprove: canDo(user.role, "approve_decision_rules") } as unknown as Overview

  return (
    <>
      <Header
        title="Decision Rules"
        subtitle="Business rules, scorecards and risk grades for automatic approve, decline and refer decisions. Every change needs a second person's approval."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Decision Rules" }]}
      />
      <div className="p-4 lg:p-8 max-w-6xl space-y-6">
        <DecisionRulesWorkspace overview={props} />
      </div>
    </>
  )
}
