"use client"

import Link from "next/link"
import { Users, TrendingUp, Target, Clock, Plus, RefreshCw, Banknote } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"

type Lead = {
  id: string
  firstName: string
  lastName: string
  status: string
  source: string
  createdAt: Date
}

type Activity = {
  id: string
  type: string
  subject: string
  leadId: string | null
  clientId: string | null
  createdAt: Date
}

type FunnelItem = { status: string; count: number; pct: number; avgDays?: number }
type SourceItem = { source: string; total: number; converted: number; rate: number; avgLoanAmount?: number; expectedRevenuePerLead?: number }
type StaleLead = { id: string; firstName: string; lastName: string; status: string; daysSinceUpdate: number }
type CallbackLead = { id: string; firstName: string; lastName: string; callbackDate: Date | null; callbackNotes: string | null }
type AgentPerfItem = { id: string; name: string; activePipeline: number; convertedThisMonth: number; avgConvertDays: number; oldestUnactionedDays: number }
type OpportunityItem = {
  id: string
  type: string
  status: string
  daysOpen: number
  client: { id: string; firstName: string; lastName: string; loans: { outstandingPrincipal: number }[] }
}

type Props = {
  totalLeads: number
  convertedThisMonth: number
  crossSellCount: number
  recentActivities: Activity[]
  topLeads: Lead[]
  funnelData: FunnelItem[]
  bySource: SourceItem[]
  staleLeads: StaleLead[]
  callbacksDueToday: CallbackLead[]
  reEngagementCount: number
  lostReasons: { reason: string; count: number }[]
  agentPerf: AgentPerfItem[]
  revenueFromLeads: number
  topOpportunities: OpportunityItem[]
}

const ACTIVITY_COLORS: Record<string, { bg: string; text: string }> = {
  CALL: { bg: "#DBEAFE", text: "#1E40AF" },
  EMAIL: { bg: "#D1FAE5", text: "#065F46" },
  WHATSAPP: { bg: "#D1FAE5", text: "#065F46" },
  MEETING: { bg: "#EDE9FE", text: "#5B21B6" },
  NOTE: { bg: "#F3F4F6", text: "#374151" },
  FOLLOW_UP: { bg: "#FEF3C7", text: "#92400E" },
  LOAN_OFFER: { bg: "#FEF3E2", text: "#4F46E5" },
  INSURANCE_OFFER: { bg: "#FCE7F3", text: "#9D174D" },
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  NEW: { bg: "#DBEAFE", text: "#1E40AF" },
  CONTACTED: { bg: "#FEF3C7", text: "#92400E" },
  QUALIFIED: { bg: "#D1FAE5", text: "#065F46" },
  PROPOSAL_SENT: { bg: "#EDE9FE", text: "#5B21B6" },
  CONVERTED: { bg: "#DCFCE7", text: "#166534" },
  INCOMPLETE: { bg: "#FEF3C7", text: "#92400E" },
  STRANDED: { bg: "#FFEDD5", text: "#9A3412" },
  LOST: { bg: "#FEE2E2", text: "#991B1B" },
}

const FUNNEL_COLORS: Record<string, string> = {
  NEW: "#1E40AF",
  CONTACTED: "#92400E",
  QUALIFIED: "#065F46",
  PROPOSAL_SENT: "#5B21B6",
  CONVERTED: "#166534",
  INCOMPLETE: "#92400E",
  STRANDED: "#9A3412",
  LOST: "#991B1B",
}

function timeAgo(date: Date) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const LOST_REASON_LABELS: Record<string, string> = {
  TOO_EXPENSIVE: "Too Expensive", WENT_ELSEWHERE: "Went Elsewhere",
  NOT_QUALIFIED: "Not Qualified", NO_RESPONSE: "No Response",
  PRODUCT_MISMATCH: "Product Mismatch", UNKNOWN: "Unknown",
}

function formatRand(cents: number) {
  return `R${(cents / 100).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  PERSONAL_LOAN: "Personal Loan Upsell",
  PO_FUNDING: "PO Funding",
  TOP_UP: "Loan Top-Up",
}

export function CrmDashboardClient({
  totalLeads, convertedThisMonth, crossSellCount,
  recentActivities, topLeads, funnelData, bySource, staleLeads,
  callbacksDueToday, reEngagementCount, lostReasons, agentPerf, revenueFromLeads,
  topOpportunities,
}: Props) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">CRM</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manage leads, track pipeline and cross-sell opportunities</p>
        </div>
        <Link href="/crm/leads/new">
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-md text-white text-sm font-medium"
            style={{ backgroundColor: "#4338CA" }}
          >
            <Plus className="h-4 w-4" />
            New Lead
          </button>
        </Link>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: "Total Leads", value: totalLeads, icon: Users, color: "#4F46E5", format: "number" },
          { label: "Converted This Month", value: convertedThisMonth, icon: TrendingUp, color: "#16A085", format: "number" },
          { label: "Cross-sell Opportunities", value: crossSellCount, icon: Target, color: "#8E44AD", format: "number" },
          { label: "Active Pipeline", value: funnelData.filter(f => !["CONVERTED","LOST"].includes(f.status)).reduce((s, f) => s + f.count, 0), icon: Clock, color: "#E67E22", format: "number" },
          { label: "Revenue This Month", value: revenueFromLeads, icon: Banknote, color: "#166534", format: "rand" },
        ].map(({ label, value, icon: Icon, color, format }) => (
          <div key={label} className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}15` }}>
                <Icon className="h-4 w-4" style={{ color }} />
              </div>
            </div>
            <p className="text-3xl font-bold text-gray-900">
              {format === "rand" ? formatRand(value) : value}
            </p>
          </div>
        ))}
      </div>

      {/* Funnel + Stale leads */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Funnel */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Pipeline Funnel</h2>
          </div>
          <div className="p-5 space-y-3">
            {funnelData.map(({ status, count, pct, avgDays }) => (
              <div key={status} className="flex items-center gap-3">
                <span className="w-28 text-[11px] font-semibold text-gray-500 uppercase shrink-0">
                  {status.replace(/_/g, " ")}
                </span>
                <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: FUNNEL_COLORS[status] ?? "#6B7280" }}
                  />
                </div>
                <span className="text-[11px] font-bold text-gray-700 w-6 text-right">{count}</span>
                <span className="text-[11px] text-gray-400 w-8 text-right">{pct}%</span>
                {avgDays !== undefined && count > 0 && (
                  <span className="text-[10px] text-gray-300 w-10 text-right shrink-0">
                    {avgDays}d
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Stale leads */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
            <h2 className="font-semibold text-gray-900 text-sm">Needs Attention</h2>
            {staleLeads.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
                {staleLeads.length}
              </span>
            )}
          </div>
          <div className="divide-y divide-gray-50">
            {staleLeads.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-gray-400">All leads active ✓</p>
            ) : (
              staleLeads.map((lead) => {
                const s = STATUS_COLORS[lead.status] ?? { bg: "#F3F4F6", text: "#374151" }
                return (
                  <Link key={lead.id} href={`/crm/leads/${lead.id}`}>
                    <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{lead.firstName} {lead.lastName}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: s.bg, color: s.text }}>
                            {lead.status.replace(/_/g, " ")}
                          </span>
                          <span className="text-[11px] text-red-400">{lead.daysSinceUpdate} days stale</span>
                        </div>
                      </div>
                    </div>
                  </Link>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Revenue Opportunities */}
      {topOpportunities.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-gray-900 text-sm">Revenue Opportunities</h2>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                {topOpportunities.length}
              </span>
            </div>
            <Link href="/crm/opportunities" className="text-xs font-medium hover:underline" style={{ color: "#4338CA" }}>
              View all →
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                {["Client", "Product", "Status", "Active Loan", "Days Open"].map((h) => (
                  <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topOpportunities.map((opp, i) => {
                const activeLoan = opp.client.loans[0]?.outstandingPrincipal ?? 0
                return (
                  <tr key={opp.id} className="border-b border-gray-50" style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}>
                    <td className="px-5 py-3">
                      <Link href={`/clients/${opp.client.id}`} className="font-medium text-gray-800 text-[13px] hover:underline">
                        {opp.client.firstName} {opp.client.lastName}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-gray-600">{TYPE_LABELS[opp.type] ?? opp.type}</td>
                    <td className="px-5 py-3">
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded" style={{ backgroundColor: "#EDE9FE", color: "#5B21B6" }}>
                        {opp.status.charAt(0) + opp.status.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[13px] font-semibold text-gray-700">
                      {activeLoan > 0 ? formatRand(activeLoan) : "—"}
                    </td>
                    <td className="px-5 py-3 text-[13px] text-gray-500">{opp.daysOpen}d</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent activity feed */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Recent Activity</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {recentActivities.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400">No activities yet</p>
            )}
            {recentActivities.map((a) => {
              const style = ACTIVITY_COLORS[a.type] ?? { bg: "#F3F4F6", text: "#374151" }
              return (
                <div key={a.id} className="px-5 py-3.5 flex items-start gap-3">
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold mt-0.5 flex-shrink-0"
                    style={{ backgroundColor: style.bg, color: style.text }}
                  >
                    {a.type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate">{a.subject}</p>
                  </div>
                  <span className="text-[11px] text-gray-400 flex-shrink-0">{timeAgo(a.createdAt)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Top leads */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 text-sm">Recent Leads</h2>
            <Link href="/crm/leads" className="text-xs font-medium hover:underline" style={{ color: "#4338CA" }}>
              View pipeline →
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {topLeads.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400">No leads yet</p>
            )}
            {topLeads.map((lead) => {
              const s = STATUS_COLORS[lead.status] ?? { bg: "#F3F4F6", text: "#374151" }
              return (
                <Link key={lead.id} href={`/crm/leads/${lead.id}`}>
                  <div className="px-5 py-3.5 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                      style={{ background: "linear-gradient(135deg, #4338CA 0%, #4F46E5 100%)" }}
                    >
                      {lead.firstName[0]}{lead.lastName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{lead.firstName} {lead.lastName}</p>
                      <p className="text-[11px] text-gray-400">{lead.source.replace(/_/g, " ")}</p>
                    </div>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: s.bg, color: s.text }}>
                      {lead.status.replace(/_/g, " ")}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </div>

      {/* Source breakdown */}
      {bySource.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Leads by Source</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                {["Source", "Total", "Converted", "Rate", "Avg Loan", "Rev/Lead"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bySource.map(({ source, total, converted, rate, avgLoanAmount, expectedRevenuePerLead }, i) => (
                <tr key={source} className="border-b border-gray-50" style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}>
                  <td className="px-5 py-3 font-medium text-gray-800 text-[13px]">{source.replace(/_/g, " ")}</td>
                  <td className="px-5 py-3 text-gray-600 text-[13px]">{total}</td>
                  <td className="px-5 py-3 text-gray-600 text-[13px]">{converted}</td>
                  <td className="px-5 py-3">
                    <span className="text-[12px] font-semibold" style={{ color: rate >= 50 ? "#166534" : rate >= 20 ? "#92400E" : "#991B1B" }}>
                      {rate}%
                    </span>
                  </td>
                  <td className="px-5 py-3 text-[12px] text-gray-600">{avgLoanAmount ? formatRand(avgLoanAmount) : "—"}</td>
                  <td className="px-5 py-3 text-[12px] font-semibold" style={{ color: expectedRevenuePerLead ? "#166534" : "#9CA3AF" }}>
                    {expectedRevenuePerLead ? formatRand(expectedRevenuePerLead) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Callbacks due today + Re-engagement + Lost reasons */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Due Today */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-2">
            <h2 className="font-semibold text-gray-900 text-sm">Due Today</h2>
            {callbacksDueToday.length > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {callbacksDueToday.length}
              </span>
            )}
          </div>
          <div className="divide-y divide-gray-50">
            {callbacksDueToday.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-gray-400">No callbacks due today ✓</p>
            ) : (
              callbacksDueToday.map((lead) => (
                <Link key={lead.id} href={`/crm/leads/${lead.id}`}>
                  <div className="px-5 py-3 hover:bg-amber-50 transition-colors">
                    <p className="text-sm font-medium text-gray-900">{lead.firstName} {lead.lastName}</p>
                    <p className="text-[11px] text-amber-600 mt-0.5">
                      {lead.callbackDate ? new Date(lead.callbackDate).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE }) : ""}
                      {lead.callbackNotes ? ` — ${lead.callbackNotes.slice(0, 40)}` : ""}
                    </p>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Re-engagement */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-purple-500" />
              <h2 className="font-semibold text-gray-900 text-sm">Re-engage</h2>
              {reEngagementCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                  {reEngagementCount}
                </span>
              )}
            </div>
            <Link href="/crm/re-engagement" className="text-xs font-medium hover:underline" style={{ color: "#4338CA" }}>View all →</Link>
          </div>
          <div className="px-5 py-6 text-center">
            {reEngagementCount === 0 ? (
              <p className="text-sm text-gray-400">No leads eligible yet</p>
            ) : (
              <>
                <p className="text-3xl font-bold text-gray-900">{reEngagementCount}</p>
                <p className="text-xs text-gray-400 mt-1">leads lost 90+ days ago worth re-contacting</p>
                <Link href="/crm/re-engagement"
                  className="mt-4 inline-block px-4 py-2 rounded-md text-white text-sm font-medium"
                  style={{ backgroundColor: "#8E44AD" }}>
                  View Queue →
                </Link>
              </>
            )}
          </div>
        </div>

        {/* Lost Reasons */}
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Why We Lose Deals</h2>
          </div>
          <div className="p-5 space-y-3">
            {lostReasons.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-4">No lost leads yet</p>
            ) : (
              lostReasons.sort((a, b) => b.count - a.count).map(({ reason, count }) => {
                const lostTotal = lostReasons.reduce((s, r) => s + r.count, 0)
                const pct = lostTotal > 0 ? Math.round((count / lostTotal) * 100) : 0
                return (
                  <div key={reason} className="flex items-center gap-3">
                    <span className="w-32 text-[11px] text-gray-500 shrink-0">{LOST_REASON_LABELS[reason] ?? reason}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                      <div className="h-1.5 rounded-full bg-red-400" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[11px] font-bold text-gray-600 w-6 text-right">{count}</span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Agent Performance */}
      {agentPerf.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Agent Performance</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                {["Agent", "Active Pipeline", "Converted This Month", "Avg Days to Convert", "Oldest Lead (days stale)"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agentPerf.sort((a, b) => b.convertedThisMonth - a.convertedThisMonth).map((agent, i) => (
                <tr key={agent.id} className="border-b border-gray-50" style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}>
                  <td className="px-5 py-3 font-medium text-gray-800 text-[13px]">{agent.name}</td>
                  <td className="px-5 py-3 text-gray-600 text-[13px]">{agent.activePipeline}</td>
                  <td className="px-5 py-3">
                    <span className="text-[13px] font-semibold" style={{ color: agent.convertedThisMonth > 0 ? "#166534" : "#9CA3AF" }}>
                      {agent.convertedThisMonth}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-[13px] text-gray-600">{agent.avgConvertDays}d</td>
                  <td className="px-5 py-3">
                    <span className="text-[13px]" style={{ color: agent.oldestUnactionedDays >= 4 ? "#991B1B" : agent.oldestUnactionedDays >= 2 ? "#92400E" : "#166534" }}>
                      {agent.oldestUnactionedDays}d
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
