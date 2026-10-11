"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import type { FscaReturnData } from "@/lib/fsca-return"
import { SAST_TIME_ZONE } from "@/lib/utils"

// InsurancePolicy / InsuranceClaim amounts are stored as Decimal(12, 2)
// rands (not cents-as-integers like Loan.principal), so we format the value
// directly without dividing. Shared formatZAR is for cents-scaled fields.
const formatZAR = (rands: number) =>
  `R ${rands.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`

const COUNT = (n: number) => new Intl.NumberFormat("en-ZA").format(n)

const PCT = (ratio: number | null) =>
  ratio === null ? "n/a" : `${(ratio * 100).toFixed(0)}%`

function pprTone(ratio: number | null): "danger" | "warning" | "success" | "neutral" {
  if (ratio === null) return "neutral"
  if (ratio < 0.8) return "danger"
  if (ratio < 0.95) return "warning"
  return "success"
}

const CLAIM_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected (repudiated)",
  PAID: "Paid",
}

const POLICY_TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral cover",
  CREDIT_LIFE: "Credit life",
  LIFE_INSURANCE: "Life insurance",
  SHORT_TERM_MOTOR: "Short-term motor",
  SHORT_TERM_HOME: "Short-term home",
  SHORT_TERM_CONTENTS: "Short-term contents",
  BUSINESS_INSURANCE: "Business insurance",
}

const COMPLAINT_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  UNDER_INVESTIGATION: "Under investigation",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
  ESCALATED_OMBUD: "Escalated to ombud",
  CLOSED: "Closed",
}

const COMPLAINT_OUTCOME_LABELS: Record<string, string> = {
  UPHELD: "Upheld",
  PARTIALLY_UPHELD: "Partially upheld",
  NOT_UPHELD: "Not upheld",
  WITHDRAWN: "Withdrawn",
}

export function FscaReturnClient({
  data,
  selectableQuarters,
  canSubmit,
}: {
  data: FscaReturnData
  selectableQuarters: string[]
  canSubmit: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [submitting, setSubmitting] = useState(false)
  const [submittedAt, setSubmittedAt] = useState<Date | null>(data.submittedAt)
  const submittedByName = data.submittedByName
  const [error, setError] = useState<string | null>(null)

  const onQuarterChange = (q: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("quarter", q)
    router.push(`?${params.toString()}`)
  }

  const onMarkSubmitted = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/compliance/fsca-return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quarter: data.quarter }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { submittedAt: string }
      setSubmittedAt(new Date(body.submittedAt))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed")
    } finally {
      setSubmitting(false)
    }
  }

  const tone = pprTone(data.ppr.ratio)

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">FSCA Conduct of Business Return</h1>
          <p className="text-sm text-gray-500 mt-1">
            FSP: {data.fspNumber} · Quarterly self-assessment
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500" htmlFor="fsca-quarter">
            Quarter
          </label>
          <select
            id="fsca-quarter"
            value={data.quarter}
            onChange={(e) => onQuarterChange(e.target.value)}
            disabled={submitting}
            className="border rounded px-3 py-1.5 text-sm bg-transparent"
          >
            {selectableQuarters.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
          {submittedAt ? (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
              Submitted
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
              Pending
            </span>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Policies in force" primary={COUNT(data.policiesInForce.count)} secondary={formatZAR(data.policiesInForce.sumAssured)} />
        <StatCard label="GWP this quarter" primary={formatZAR(data.gwp.total)} secondary={`${COUNT(data.gwp.count)} new policies`} />
        <StatCard label="New business" primary={COUNT(data.newBusiness.total)} secondary="By type below" />
        <StatCard label="Lapses" primary={COUNT(data.lapses.count)} secondary={formatZAR(data.lapses.sumAssured)} />
        <StatCard label="Claims paid" primary={COUNT(data.claims.PAID.count)} secondary={formatZAR(data.claims.PAID.value)} />
        <StatCard label="Claims rejected" primary={COUNT(data.claims.REJECTED.count)} secondary={formatZAR(data.claims.REJECTED.value)} />
        <StatCard label="Complaints" primary={COUNT(data.complaints.total)} secondary={`${COUNT(data.complaints.byStatus.OPEN)} open`} />
        <StatCard label="PPR acknowledged" primary={PCT(data.ppr.ratio)} secondary={`${COUNT(data.ppr.acknowledged)} / ${COUNT(data.ppr.issued)}`} tone={tone} />
      </section>

      <section className="space-y-2">
        <details className="border rounded p-3">
          <summary className="cursor-pointer font-medium text-sm">Claims breakdown</summary>
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-gray-500 text-xs"><th className="text-left">Status</th><th className="text-right">Count</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {(["SUBMITTED","UNDER_REVIEW","APPROVED","REJECTED","PAID"] as const).map((s) => (
                <tr key={s}><td>{CLAIM_LABELS[s]}</td><td className="text-right">{COUNT(data.claims[s].count)}</td><td className="text-right">{formatZAR(data.claims[s].value)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>

        <details className="border rounded p-3">
          <summary className="cursor-pointer font-medium text-sm">Complaints breakdown</summary>
          <div className="grid grid-cols-2 gap-6 mt-3 text-sm">
            <div>
              <h4 className="text-xs text-gray-500 mb-1">By status</h4>
              {Object.entries(data.complaints.byStatus).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span>{COMPLAINT_STATUS_LABELS[k] ?? k}</span><span>{COUNT(v)}</span></div>
              ))}
            </div>
            <div>
              <h4 className="text-xs text-gray-500 mb-1">By outcome</h4>
              {Object.entries(data.complaints.byOutcome).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span>{COMPLAINT_OUTCOME_LABELS[k] ?? k}</span><span>{COUNT(v)}</span></div>
              ))}
            </div>
          </div>
        </details>

        <details className="border rounded p-3">
          <summary className="cursor-pointer font-medium text-sm">New business by product type</summary>
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-gray-500 text-xs"><th className="text-left">Type</th><th className="text-right">Count</th></tr></thead>
            <tbody>
              {Object.entries(data.newBusiness.byType).map(([k, v]) => (
                <tr key={k}><td>{POLICY_TYPE_LABELS[k] ?? k}</td><td className="text-right">{COUNT(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="flex items-center justify-end gap-2 pt-2 border-t">
        <a
          href={`/api/reports/export?type=fsca-quarterly&quarter=${data.quarter}`}
          download
          className="px-3 py-1.5 rounded text-sm border hover:bg-gray-50"
        >
          Download quarterly (.xlsx)
        </a>
        <a
          href="/api/reports/export?type=fsca-annual"
          download
          className="px-3 py-1.5 rounded text-sm border hover:bg-gray-50"
        >
          Download annual (.xlsx)
        </a>
        {canSubmit && !submittedAt && (
          <button
            type="button"
            onClick={onMarkSubmitted}
            disabled={submitting}
            className="px-3 py-1.5 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Mark as submitted"}
          </button>
        )}
        {submittedAt && (
          <span className="text-sm text-gray-500">
            Submitted {submittedAt.toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}
            {submittedByName ? ` by ${submittedByName}` : ""}
          </span>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </section>
    </div>
  )
}

function StatCard({
  label,
  primary,
  secondary,
  tone = "neutral",
}: {
  label: string
  primary: string
  secondary: string
  tone?: "danger" | "warning" | "success" | "neutral"
}) {
  const toneClass =
    tone === "danger"
      ? "text-red-600"
      : tone === "warning"
        ? "text-amber-600"
        : tone === "success"
          ? "text-emerald-600"
          : ""
  return (
    <div className="border rounded p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`whitespace-nowrap text-xl font-semibold mt-1 ${toneClass}`}>{primary}</div>
      <div className="text-xs text-gray-500 mt-0.5">{secondary}</div>
    </div>
  )
}
