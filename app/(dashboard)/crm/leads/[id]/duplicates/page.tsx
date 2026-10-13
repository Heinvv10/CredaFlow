import Link from "next/link"
import { notFound } from "next/navigation"
import { Copy } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { getStaffTenantId } from "@/lib/session-tenant"
import { findLeadDuplicatesForTenant, DEDUP_SCAN_LIMIT } from "@/lib/crm/lead-dedup-search"
import { describeReasons } from "@/lib/crm/lead-dedup"

const SAST_TIME_ZONE = "Africa/Johannesburg"

function formatDate(date: Date) {
  return date.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: SAST_TIME_ZONE,
  })
}

/**
 * Review the leads that share this lead's phone or email.
 *
 * Read-only by design. Merging leads moves ContactIdentity rows and message
 * history between POPIA data subjects and is deferred to its own reviewed
 * change — this page exists so a human can see the evidence and decide, using
 * the status controls on each lead, what to do about it.
 */
export default async function LeadDuplicatesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const tenantId = await getStaffTenantId()

  // Tenant-scoped: `Lead` is absent from TENANT_SCOPED_MODELS, so this filter
  // is manual and load-bearing on every read, this one included.
  const lead = await prisma.lead.findFirst({
    where: { id, tenantId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  })
  if (!lead) notFound()

  const { duplicates, scanned, truncated } = await findLeadDuplicatesForTenant(id, tenantId)

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-6"
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Leads", href: "/crm/leads" },
          { label: `${lead.firstName} ${lead.lastName}`, href: `/crm/leads/${lead.id}` },
          { label: "Possible duplicates" },
        ]}
      />

      <div className="max-w-3xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Copy className="h-5 w-5 text-orange-500" />
            Possible duplicates
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Leads that share a phone number or email address with{" "}
            <span className="font-medium text-gray-900">
              {lead.firstName} {lead.lastName}
            </span>{" "}
            ({lead.phone}
            {lead.email ? ` · ${lead.email}` : ""}).
          </p>
        </div>

        {duplicates.length === 0 ? (
          // The empty state must not assert an all-clear the scan didn't earn.
          // Under truncation we compared only part of the table, so "none
          // found" is "we didn't finish looking" — the same undercount-reads-
          // as-all-clear failure the banner guards against.
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center">
            <p className="text-sm text-gray-600">
              {truncated
                ? `There are too many leads to compare in one pass. None of the ${scanned.toLocaleString("en-ZA")} most recent leads shares this lead's phone number or email address, but older leads were not compared.`
                : "No other lead shares this lead's phone number or email address."}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 divide-y divide-gray-200 bg-white">
            {duplicates.map(({ lead: dupe, reasons }) => (
              <div key={dupe.id} className="px-4 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    href={`/crm/leads/${dupe.id}`}
                    className="text-sm font-medium text-gray-900 hover:underline"
                  >
                    {dupe.firstName} {dupe.lastName}
                  </Link>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {dupe.phone}
                    {dupe.email ? ` · ${dupe.email}` : ""}
                  </p>
                  <p className="text-xs text-orange-700 mt-1">Matched on {describeReasons(reasons)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-xs font-medium text-gray-700">{dupe.status}</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {dupe.source} · {formatDate(dupe.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {truncated && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Only the {DEDUP_SCAN_LIMIT.toLocaleString("en-ZA")} most recent leads were compared, so
            this list may be incomplete.
          </p>
        )}

        <p className="text-xs text-gray-500">
          Matching is on phone number and email address only, compared across formats — two people
          can legitimately share either. Compared against {scanned.toLocaleString("en-ZA")}{" "}
          {scanned === 1 ? "other lead" : "other leads"}. Merging leads is not available here; review
          each lead and set its status.
        </p>
      </div>
    </div>
  )
}
