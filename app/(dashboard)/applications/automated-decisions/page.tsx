import { AutomatedDeclinesTable } from "@/components/applications/AutomatedDeclinesTable"
import { Header } from "@/components/layout/Header"
import { requireMinRole } from "@/lib/auth-guards"
import { listAutomatedDeclines } from "@/lib/decisioning/automated-declines"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = {
  title: "Automated decisions — Applications",
}

export default async function AutomatedDecisionsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const user = await requireMinRole("CREDIT_OFFICER")
  const { cursor } = await searchParams
  const { rows, nextCursor } = await listAutomatedDeclines(await getStaffTenantId(), { cursor })
  const canAct = user.role !== "CREDIT_OFFICER"
  return (
    <>
      <Header
        title="Automated decisions to review"
        subtitle="Applications the decision engine declined without a person. A client may ask for a person to look again (POPIA section 71): reopen it here and a person decides it afresh."
        breadcrumbs={[{ label: "Applications", href: "/applications" }, { label: "Automated decisions" }]}
      />
      <div className="p-4 lg:p-8 space-y-4">
        <AutomatedDeclinesTable
          canAct={canAct}
          rows={rows.map((r) => ({ runId: r.runId, applicationId: r.applicationId, reference: r.reference, status: r.status, decidedAt: r.decidedAt.toISOString(), reasonCodes: r.reasonCodes, riskGrade: r.riskGrade, ruleSet: r.ruleSet }))}
        />
        {nextCursor && <a className="text-sm underline" href={`/applications/automated-decisions?cursor=${nextCursor}`}>Older</a>}
      </div>
    </>
  )
}
