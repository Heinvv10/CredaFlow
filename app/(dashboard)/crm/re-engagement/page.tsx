import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { RefreshCw, Phone, Mail } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { getStaffTenantId } from "@/lib/session-tenant"

const LOST_REASON_LABELS: Record<string, string> = {
  TOO_EXPENSIVE: "Too Expensive",
  WENT_ELSEWHERE: "Went Elsewhere",
  PRODUCT_MISMATCH: "Product Mismatch",
}

const REASON_COLORS: Record<string, { bg: string; text: string }> = {
  TOO_EXPENSIVE: { bg: "#FEF3C7", text: "#92400E" },
  WENT_ELSEWHERE: { bg: "#EDE9FE", text: "#5B21B6" },
  PRODUCT_MISMATCH: { bg: "#DBEAFE", text: "#1E40AF" },
}

async function getReEngagementLeads(tenantId: string) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  return prisma.lead.findMany({
    where: {
      tenantId,
      status: "LOST",
      updatedAt: { lt: cutoff },
      lostReason: { in: ["TOO_EXPENSIVE", "WENT_ELSEWHERE", "PRODUCT_MISMATCH"] },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      source: true,
      lostReason: true,
      requestedAmount: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  })
}

function formatRand(cents: number | null) {
  if (!cents) return "—"
  return `R${(cents / 100).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`
}

export default async function ReEngagementPage() {
  const tenantId = await getStaffTenantId()
  const leads = await getReEngagementLeads(tenantId)

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-3"
          items={[
            { label: "CRM", href: "/crm" },
            { label: "Re-engagement" },
          ]}
        />
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: "#EDE9FE" }}>
            <RefreshCw className="h-4 w-4" style={{ color: "#5B21B6" }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Re-engagement Queue</h1>
            <p className="text-sm text-gray-400">
              {leads.length} leads lost 90+ days ago — worth re-contacting
            </p>
          </div>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-12 text-center">
          <RefreshCw className="h-8 w-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No re-engageable leads yet.</p>
          <p className="text-xs text-gray-400 mt-1">Lost leads eligible for re-contact appear here after 90 days.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-5 py-3 text-left font-semibold">Lead</th>
                <th className="px-5 py-3 text-left font-semibold">Contact</th>
                <th className="px-5 py-3 text-left font-semibold">Lost Reason</th>
                <th className="px-5 py-3 text-left font-semibold">Requested</th>
                <th className="px-5 py-3 text-left font-semibold">Lost</th>
                <th className="px-5 py-3 text-left font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {leads.map((lead) => {
                const daysSince = Math.floor((new Date().getTime() - new Date(lead.updatedAt).getTime()) / 86400000)
                const reasonStyle = REASON_COLORS[lead.lostReason ?? ""] ?? { bg: "#F3F4F6", text: "#374151" }
                return (
                  <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: "linear-gradient(135deg, #4338CA 0%, #4F46E5 100%)" }}
                        >
                          {lead.firstName[0]}{lead.lastName[0]}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{lead.firstName} {lead.lastName}</p>
                          <p className="text-[11px] text-gray-400">{lead.source}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1">
                        <a href={`tel:${lead.phone}`} className="flex items-center gap-1 text-xs text-gray-600 hover:text-[#4F46E5]">
                          <Phone className="h-3 w-3" /> {lead.phone}
                        </a>
                        {lead.email && (
                          <a href={`mailto:${lead.email}`} className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#4F46E5]">
                            <Mail className="h-3 w-3" /> {lead.email}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold"
                        style={{ backgroundColor: reasonStyle.bg, color: reasonStyle.text }}>
                        {LOST_REASON_LABELS[lead.lostReason ?? ""] ?? "Unknown"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-gray-700 font-medium">
                      {formatRand(lead.requestedAmount)}
                    </td>
                    <td className="px-5 py-3.5 text-sm text-gray-400">
                      {daysSince}d ago
                    </td>
                    <td className="px-5 py-3.5">
                      <Link href={`/crm/leads/${lead.id}`}
                        className="text-xs font-medium px-3 py-1.5 rounded-md text-white"
                        style={{ backgroundColor: "#4338CA" }}>
                        Re-contact →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
