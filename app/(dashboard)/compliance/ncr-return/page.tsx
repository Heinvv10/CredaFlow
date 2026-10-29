import { notFound } from "next/navigation"
import { requireMinRole, hasMinRole } from "@/lib/auth-guards"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import type { AppRole } from "@/lib/auth-guards"
import { auth } from "@/lib/auth"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { NcrReturnClient } from "@/components/compliance/NcrReturnClient"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getNcrReturnData } from "@/lib/compliance/ncr-return"
import { listSelectableQuarters, parseQuarterParam } from "@/lib/compliance/quarters"
import { BookDefinitions } from "@/components/reports/BookDefinitions"
import { BOOK_DEFINITIONS } from "@/lib/reports/book-arrears"

export const dynamic = "force-dynamic"

export default async function NcrReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ quarter?: string }>
}) {
  await requireMinRole("READONLY")
  if (!isNcaJurisdiction()) notFound()

  const params = await searchParams
  const now = new Date()
  const quarter = parseQuarterParam(params.quarter, now)
  const selectableQuarters = listSelectableQuarters(now)

  const tenantId = await getStaffTenantId()
  const [data, session] = await Promise.all([
    getNcrReturnData(tenantId, quarter, now),
    auth(),
  ])

  // Mirror the POST route's requireApiRole("LOAN_ADMIN") exactly, so no role
  // sees a submit button the API will refuse — and none that the API would
  // accept has it hidden.
  const role = session?.user?.role as AppRole | undefined
  const canSubmit = role ? hasMinRole(role, "LOAN_ADMIN") : false

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "NCR return" },
        ]}
      />
      <NcrReturnClient
        data={data}
        selectableQuarters={selectableQuarters}
        canSubmit={canSubmit}
      />
      {/* The same definitions the dashboard and collections label (lib/reports/book-arrears.ts). */}
      <BookDefinitions scope={BOOK_DEFINITIONS.scopeNca} />
    </div>
  )
}
