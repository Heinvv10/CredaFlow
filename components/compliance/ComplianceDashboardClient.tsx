"use client"

import Link from "next/link"
import { formatDate } from "@/lib/utils"
import { AlertTriangle, CheckCircle, Clock, FileText } from "lucide-react"
import { Section129ReconcileAction } from "@/components/compliance/Section129ReconcileAction"
import { Section129RecoveryAction } from "@/components/compliance/Section129RecoveryAction"
import {
  labelOf,
  legacyEvidenceHome,
  isOverdue,
  type ComplianceGroup,
  type ComplianceHealth,
} from "@/lib/compliance/record-types"

type ComplianceRecord = {
  id: string
  type: string
  status: string
  referenceId: string | null
  dueDate: Date | string | null
  completedAt: Date | string | null
  createdAt: Date | string
  data: unknown
  section129RecoveryAvailable?: boolean
}

type NcrReturnStatus = {
  /** The tenant's configured NCR number; null until identity is configured. */
  ncrNumber: string | null
  quarter: string
  quarterLabel: string
  status: string | null
  completedAt: Date | string | null
  dueDate: Date | string | null
}

function section129Lifecycle(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const lifecycle = (data as { lifecycle?: unknown }).lifecycle
  return typeof lifecycle === "string" ? lifecycle : null
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  SUBMITTED: "bg-blue-100 text-blue-800",
  PENDING: "bg-amber-100 text-amber-800",
  OVERDUE: "bg-red-100 text-red-800",
  ACKNOWLEDGED: "bg-teal-100 text-teal-800",
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  COMPLETED: <CheckCircle className="h-3.5 w-3.5 text-green-600" />,
  SUBMITTED: <CheckCircle className="h-3.5 w-3.5 text-blue-600" />,
  ACKNOWLEDGED: <CheckCircle className="h-3.5 w-3.5 text-teal-600" />,
  PENDING: <Clock className="h-3.5 w-3.5 text-amber-600" />,
  OVERDUE: <AlertTriangle className="h-3.5 w-3.5 text-red-600" />,
}

const GROUP_TABS: { key: ComplianceGroup | null; label: string; hint: string }[] = [
  { key: null, label: "All", hint: "Every compliance record" },
  { key: "OBLIGATION", label: "Obligations", hint: "Statutory duties — these drive the health score" },
  { key: "EXCEPTION", label: "Exceptions", hint: "Items awaiting a human decision" },
  { key: "REGISTER", label: "Registers", hint: "Evidence of what the system did" },
  { key: "LEGACY", label: "Legacy", hint: "Types nothing in the app writes — the evidence lives elsewhere" },
]

/**
 * The NCR card. Three states, deliberately: the absence of a record is NOT
 * evidence of submission. Treating "no PENDING row" as SUBMITTED would assert
 * a filed statutory return backed by nothing wherever no NCR_QUARTERLY_RETURN
 * record has ever been created.
 */
export function NcrCard({ ncr }: { ncr: NcrReturnStatus }) {
  const filed = ncr.status === "SUBMITTED" || ncr.status === "COMPLETED"
  const border = filed ? "#1565c0" : ncr.status === null ? "#b71c1c" : "#e65100"

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm" style={{ borderLeft: `4px solid ${border}` }}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        NCR Quarterly Return
      </p>
      {filed ? (
        <>
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
            SUBMITTED
          </span>
          <p className="mt-2 text-xs text-gray-500">
            {ncr.quarterLabel}
            {ncr.completedAt ? ` · filed ${formatDate(ncr.completedAt)}` : ""}
          </p>
          <p className="mt-1 text-xs text-gray-400">NCR Reg: {ncr.ncrNumber ?? "not configured"}</p>
        </>
      ) : ncr.status === null ? (
        <>
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
            NOT PREPARED
          </span>
          <p className="mt-2 text-xs text-gray-500">
            No return on record for {ncr.quarterLabel}.
          </p>
          <Link
            href={`/compliance/ncr-return?quarter=${ncr.quarter}`}
            className="mt-1 block text-xs font-semibold text-[#4F46E5] hover:underline"
          >
            Prepare return →
          </Link>
        </>
      ) : (
        <>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            {ncr.status}
          </span>
          <p className="mt-2 text-xs text-gray-500">
            {ncr.quarterLabel}
            {ncr.dueDate ? ` · due ${formatDate(ncr.dueDate)}` : ""}
          </p>
          <Link
            href={`/compliance/ncr-return?quarter=${ncr.quarter}`}
            className="mt-1 block text-xs font-semibold text-[#4F46E5] hover:underline"
          >
            Prepare return →
          </Link>
        </>
      )}
    </div>
  )
}

export function ComplianceDashboardClient({
  records,
  health,
  totalCount,
  groupCounts,
  activeGroup,
  activeType,
  overLimit,
  rowCap,
  bureauOverrideCount,
  canReconcileSection129,
  ncrReturn,
}: {
  records: ComplianceRecord[]
  health: ComplianceHealth
  totalCount: number
  groupCounts: Record<ComplianceGroup, number>
  activeGroup: ComplianceGroup | null
  activeType: string | null
  overLimit: boolean
  rowCap: number
  bureauOverrideCount: number | null
  canReconcileSection129: boolean
  ncrReturn: NcrReturnStatus
}) {
  const now = new Date()
  const scoreColor = health.score >= 80 ? "#1e6b3f" : health.score >= 60 ? "#e65100" : "#b71c1c"
  const scoreBg = health.score >= 80 ? "#dcfce7" : health.score >= 60 ? "#fff3e0" : "#fee2e2"

  const tabHref = (key: ComplianceGroup | null) => (key ? `/compliance?group=${key}` : "/compliance")
  const tabCount = (key: ComplianceGroup | null) => (key ? groupCounts[key] : totalCount)

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Compliance Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">NCR · FSCA · POPIA compliance management</p>
        </div>
        <Link href="/compliance/ncr-return"
          className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white hover:bg-[#4338CA]">
          <FileText className="h-4 w-4" /> NCR Return
        </Link>
      </div>

      {/* Health + NCR card row */}
      <div className={`grid grid-cols-1 ${bureauOverrideCount !== null ? "lg:grid-cols-4" : "lg:grid-cols-3"} mb-6 gap-4`}>
        {/* Health score — statutory obligations only */}
        <div className="flex items-center gap-5 rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full text-2xl font-extrabold"
            style={{ backgroundColor: scoreBg, color: scoreColor, border: `4px solid ${scoreColor}` }}>
            {health.score}%
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Compliance Health
            </p>
            <p className="text-xl font-bold" style={{ color: scoreColor }}>
              {health.total === 0
                ? "No obligations"
                : health.score >= 80 ? "Good Standing" : health.score >= 60 ? "Needs Attention" : "At Risk"}
            </p>
            {/* The denominator is stated because the percentage alone cannot
                distinguish "nothing outstanding" from "nothing recorded". */}
            <p className="mt-1 text-xs text-gray-400">
              {health.total === 0
                ? "No statutory filings recorded yet — consent, affordability, pre-agreement and complaint evidence is held on client and application records"
                : `${health.complete} of ${health.total} statutory obligations complete`}
            </p>
          </div>
        </div>

        {/* Open items */}
        <div className="rounded-2xl bg-white p-6 shadow-sm"
          style={{ borderLeft: health.overdue > 0 ? "4px solid #b71c1c" : health.openWithoutDueDate > 0 ? "4px solid #e65100" : "4px solid #1e6b3f" }}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Overdue Items</p>
          <p className="text-3xl font-extrabold"
            style={{ color: health.overdue > 0 ? "#b71c1c" : "#1e6b3f" }}>
            {health.overdue}
          </p>
          {/* "All items on track" is only claimed when nothing is open. An
              obligation with no due date can never age into overdue, so a bare
              zero here was an unearned assurance. */}
          <p className="mt-1 text-xs text-gray-400">
            {health.overdue > 0
              ? "Require immediate action"
              : health.openWithoutDueDate > 0
                ? `${health.openWithoutDueDate} open with no due date`
                : "All items on track"}
          </p>
          {health.openExceptions > 0 && (
            <p className="mt-1 text-xs font-semibold text-amber-700">
              {health.openExceptions} open exception{health.openExceptions === 1 ? "" : "s"}
            </p>
          )}
        </div>

        <NcrCard ncr={ncrReturn} />

        {/* Bureau s.81 overrides — only rendered for LOAN_ADMIN and above */}
        {bureauOverrideCount !== null ? (
          <div className="rounded-2xl bg-white p-6 shadow-sm"
            style={{ borderLeft: bureauOverrideCount > 0 ? "4px solid #e65100" : "4px solid #1e6b3f" }}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Bureau s.81 overrides
            </p>
            <p className="text-3xl font-extrabold"
              style={{ color: bureauOverrideCount > 0 ? "#e65100" : "#1e6b3f" }}>
              {bureauOverrideCount}
            </p>
            <p className="mt-1 text-xs text-gray-400">All time</p>
            <Link href="/compliance/bureau-overrides"
              className="mt-1 inline-block text-xs font-semibold text-[#4F46E5] hover:underline">
              View overrides →
            </Link>
          </div>
        ) : null}
      </div>

      {/* Quick links to compliance sub-tools not covered by the records table below */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/compliance/fsca-return"
          className="group flex items-center justify-between rounded-2xl border border-transparent bg-white p-5 shadow-sm transition-colors hover:border-[#4F46E5] hover:bg-amber-50/40">
          <div>
            <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">FSCA Return</p>
            <p className="mt-0.5 text-xs text-gray-400">Conduct-of-business quarterly return (LOAN_ADMIN+ to submit)</p>
          </div>
          <span className="text-xl text-[#4F46E5]">→</span>
        </Link>
        {/* Breach Log / COI / TCF share the bureau-overrides card's LOAN_ADMIN
            gate (requireMinRole("LOAN_ADMIN") on each page) — bureauOverrideCount
            is only non-null when the viewer clears that same floor. */}
        {bureauOverrideCount !== null ? (
          <>
            <Link href="/compliance/breach-log"
              className="group flex items-center justify-between rounded-2xl border border-transparent bg-white p-5 shadow-sm transition-colors hover:border-[#4F46E5] hover:bg-amber-50/40">
              <div>
                <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">Breach Log</p>
                <p className="mt-0.5 text-xs text-gray-400">POPIA · FSCA data breach incidents</p>
              </div>
              <span className="text-xl text-[#4F46E5]">→</span>
            </Link>
            <Link href="/compliance/coi"
              className="group flex items-center justify-between rounded-2xl border border-transparent bg-white p-5 shadow-sm transition-colors hover:border-[#4F46E5] hover:bg-amber-50/40">
              <div>
                <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">Conflict of Interest</p>
                <p className="mt-0.5 text-xs text-gray-400">FSCA Code of Conduct self-attestation</p>
              </div>
              <span className="text-xl text-[#4F46E5]">→</span>
            </Link>
            <Link href="/compliance/tcf"
              className="group flex items-center justify-between rounded-2xl border border-transparent bg-white p-5 shadow-sm transition-colors hover:border-[#4F46E5] hover:bg-amber-50/40">
              <div>
                <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">Treating Customers Fairly</p>
                <p className="mt-0.5 text-xs text-gray-400">FSCA TCF outcomes self-assessment</p>
              </div>
              <span className="text-xl text-[#4F46E5]">→</span>
            </Link>
          </>
        ) : null}
      </div>

      {/* Compliance Records Table */}
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
        {/* Server-side filtering: the badge counts are true totals over every
            record, and the rows below are the same filtered set. Client-side
            filtering of a capped fetch would have shown counts the table could
            not honour. */}
        <div className="flex overflow-x-auto border-b border-gray-100 px-4 pt-2">
          {GROUP_TABS.map((t) => {
            const active = activeGroup === t.key && !activeType
            return (
              <Link key={t.label} href={tabHref(t.key)} title={t.hint}
                className={`shrink-0 px-4 py-2.5 text-xs font-semibold transition-colors ${
                  active ? "border-b-2 border-[#4F46E5] text-[#4F46E5]" : "text-gray-400 hover:text-gray-600"
                }`}>
                {t.label}
                <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px]">
                  {tabCount(t.key)}
                </span>
              </Link>
            )
          })}
        </div>

        {activeType && (
          <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
            Filtered to {labelOf(activeType)} ·{" "}
            {legacyEvidenceHome(activeType) && <>{legacyEvidenceHome(activeType)} ·{" "}</>}
            <Link href="/compliance" className="font-semibold text-[#4F46E5] hover:underline">clear</Link>
          </p>
        )}

        {overLimit && (
          <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
            Showing the {rowCap} most recent. Filter by group or type to see older records.
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Reference</th>
                <th className="px-4 py-3 text-left">Due Date</th>
                <th className="px-4 py-3 text-left">Completed</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {records.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                    No compliance records match this filter.
                  </td>
                </tr>
              )}
              {records.map((r) => {
                const overdue = isOverdue(r, now)
                const lifecycle = r.type === "SECTION_129_NOTICE" ? section129Lifecycle(r.data) : null
                return (
                  <tr key={r.id} className={`hover:bg-gray-50 ${overdue ? "bg-red-50/30" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {STATUS_ICONS[r.status]}
                        <Link href={`/compliance?type=${r.type}`}
                          className="text-sm text-[#1b1d24] hover:text-[#4F46E5] hover:underline">
                          {labelOf(r.type)}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[r.status] || "bg-gray-100 text-gray-600"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {r.referenceId ? r.referenceId.slice(-8) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {r.dueDate ? formatDate(r.dueDate) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {r.completedAt ? formatDate(r.completedAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {r.status === "PENDING" && r.type === "NCR_QUARTERLY_RETURN" && (
                        <Link href="/compliance/ncr-return"
                          className="rounded bg-[#4F46E5] px-2 py-1 text-xs font-medium text-white hover:bg-[#4338CA]">
                          Submit
                        </Link>
                      )}
                      {r.status === "PENDING" && r.type === "SECTION_129_NOTICE" && (
                        lifecycle === "RECONCILIATION_REQUIRED" && r.referenceId
                          ? <Section129ReconcileAction loanId={r.referenceId} issuanceId={r.id} canReconcile={canReconcileSection129} />
                          : r.section129RecoveryAvailable && r.referenceId && canReconcileSection129
                            ? <Section129RecoveryAction loanId={r.referenceId} issuanceId={r.id} lifecycle={lifecycle ?? "pending"} />
                          : <span className="text-xs font-semibold text-gray-500">
                              {lifecycle === "STAGING" ? "Artifact staging"
                                : lifecycle === "READY" ? "Reserved; dispatch pending"
                                  : lifecycle === "DISPATCHING" ? "Provider dispatch in progress"
                                    : "Pending review"}
                            </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
