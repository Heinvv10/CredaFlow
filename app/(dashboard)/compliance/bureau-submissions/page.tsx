import { notFound } from "next/navigation"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { BureauSubmissionsClient } from "@/components/compliance/BureauSubmissionsClient"
import { getResolvedTenantId } from "@/lib/tenant"
import { previousMonthEnd } from "@/lib/bureau-submission/period"
import {
  bureauSetup,
  isBureauSubmissionEnabled,
  listAwaitingAdverse,
  listHeldRecords,
  listSubmissions,
} from "@/lib/bureau-submission/staff-view.server"

export const dynamic = "force-dynamic"

/**
 * Bureau data submission (SACRRA Layout 700v2 -> Experian): history, held
 * records, the audited download and the adverse-listing confirmation.
 *
 * LOAN_ADMIN — the floor of every API this page calls, so no role sees a
 * button the API will refuse. 404 with featureBureauSubmission off, read
 * live, so the page does not outlive the switch by the config cache.
 */
export default async function BureauSubmissionsPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getResolvedTenantId()
  // withTenantContext's binding, for a page: a session never reads another
  // tenant's rows because the host resolved to it.
  if (user.tenantId !== tenantId) notFound()
  if (!(await isBureauSubmissionEnabled(tenantId))) notFound()

  const now = new Date()
  const [setup, submissions, held, awaiting] = await Promise.all([
    bureauSetup(tenantId),
    listSubmissions(tenantId),
    listHeldRecords(tenantId, now),
    listAwaitingAdverse(tenantId),
  ])

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "Bureau submissions" },
        ]}
      />
      <BureauSubmissionsClient
        setup={setup}
        submissions={submissions}
        held={held}
        awaiting={awaiting}
        defaultPeriod={previousMonthEnd(now)}
      />
    </div>
  )
}
