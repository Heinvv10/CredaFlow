import { notFound } from "next/navigation"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { getStaffTenantId } from "@/lib/session-tenant"
import {
  getFscaReturnData,
  listSelectableQuarters,
  parseQuarterParam,
} from "@/lib/fsca-return"
import { FscaReturnClient } from "@/components/compliance/FscaReturnClient"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { auth } from "@/lib/auth"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-guards"

export const dynamic = "force-dynamic"

export default async function FscaReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ quarter?: string }>
}) {
  // This page carried no guard of its own: it relied on the (dashboard) layout
  // (authenticated, non-CLIENT) plus the compliance layout's featureIms
  // redirect. Neither is a role check, and the latter is gone now that
  // compliance is no longer gated on the insurance module. Matches the NCR
  // return's floor; submission stays LOAN_ADMIN+ via the POST route.
  await requireMinRole("READONLY")
  if (!isNcaJurisdiction()) notFound()

  const params = await searchParams
  const now = new Date()
  const quarter = parseQuarterParam(params.quarter, now)
  const selectableQuarters = listSelectableQuarters(now)

  const tenantId = await getStaffTenantId()
  const [data, session] = await Promise.all([
    getFscaReturnData(tenantId, quarter),
    auth(),
  ])

  // Match the POST route's requireApiRole("LOAN_ADMIN") gate exactly, so
  // every role accepted by the API also sees the submit button (otherwise
  // BRANCH_MANAGER passes the route guard but the button is hidden).
  const role = session?.user?.role as AppRole | undefined
  const canSubmit = role ? hasMinRole(role, "LOAN_ADMIN") : false

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "FSCA return" },
        ]}
      />
      <FscaReturnClient
        data={data}
        selectableQuarters={selectableQuarters}
        canSubmit={canSubmit}
      />
    </div>
  )
}
