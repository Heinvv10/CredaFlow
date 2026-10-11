"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { formatZAR, formatDate, formatDateTime } from "@/lib/utils"
import { Download, CheckCircle, AlertTriangle } from "lucide-react"
import type { NcrReturnData, NcrReturnLine } from "@/lib/compliance/ncr-return"
import { quarterLabel } from "@/lib/compliance/quarters"
import { buildNcrCsv } from "@/lib/compliance/ncr-csv"

function money(value: number | null): string {
  return value === null ? "—" : formatZAR(value)
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-ZA")
}

function LineTable({ lines, caption }: { lines: NcrReturnLine[]; caption: string }) {
  if (lines.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            <th className="px-5 py-3 text-left">Description</th>
            <th className="px-5 py-3 text-right">Count</th>
            <th className="px-5 py-3 text-right">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {lines.map((l) => (
            <tr key={l.key} className="hover:bg-gray-50">
              <td className="px-5 py-3 text-[#1b1d24]">
                {l.label}
                {l.percentOfBook !== undefined && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                    {l.percentOfBook.toFixed(1)}% of book
                  </span>
                )}
                {l.note && <p className="mt-0.5 text-xs text-gray-400">{l.note}</p>}
              </td>
              <td className="px-5 py-3 text-right font-mono text-gray-600">{count(l.count)}</td>
              <td className="px-5 py-3 text-right font-semibold">{money(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function NcrReturnClient({
  data,
  selectableQuarters,
  canSubmit,
}: {
  data: NcrReturnData
  selectableQuarters: string[]
  canSubmit: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [submitting, setSubmitting] = useState(false)
  const [submittedAt, setSubmittedAt] = useState<Date | null>(data.submittedAt)
  const [error, setError] = useState<string | null>(null)

  // A submitted quarter shows the figures AS FILED, not the live book. The
  // frozen snapshot is the return; `data.lines` has since moved with every
  // payment and every day of arrears ageing.
  const shown = data.filed?.lines ?? data.lines
  const asFiled = data.filed !== null
  const periodLines = shown.filter((l) => l.basis === "PERIOD")
  const positionLines = shown.filter((l) => l.basis === "POSITION")
  const label = quarterLabel(data.quarter)

  const onQuarterChange = (q: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("quarter", q)
    router.push(`?${params.toString()}`)
  }

  const onMarkSubmitted = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/compliance/ncr-return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quarter: data.quarter }),
      })
      // A failed request must never leave a green "Submitted" badge behind —
      // that is a false compliance claim on a regulated surface.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // `completedAt` is nullable and the already-submitted branch returns it
      // verbatim, so an unguarded `new Date(null)` renders "01 Jan 1970" on a
      // statutory surface.
      const body = (await res.json()) as { submittedAt: string | null }
      const at = body.submittedAt ? new Date(body.submittedAt) : null
      setSubmittedAt(at && Number.isFinite(at.getTime()) ? at : new Date())
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed")
    } finally {
      setSubmitting(false)
    }
  }

  const handleExport = () => {
    const csv = buildNcrCsv({
      data,
      quarterLabel: label,
      generatedAt: new Date(),
      formatDate,
      formatDateTime,
    })
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `NCR-Return-${data.quarter}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">NCR Quarterly Return</h1>
          <p className="mt-1 text-sm text-gray-500">
            NCR Registration: <span className="font-mono font-semibold">{data.ncrNumber}</span>
          </p>
        </div>
        <Link href="/compliance" className="text-sm text-gray-500 hover:text-gray-700">
          ← Compliance
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-4 rounded-2xl bg-white p-5 shadow-sm">
        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-500" htmlFor="ncr-quarter">
            Quarter
          </label>
          <select
            id="ncr-quarter"
            value={data.quarter}
            onChange={(e) => onQuarterChange(e.target.value)}
            disabled={submitting}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-[#4F46E5] focus:outline-none"
          >
            {selectableQuarters.map((q) => (
              <option key={q} value={q}>
                {quarterLabel(q)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-500">Period</p>
          <p className="text-sm text-gray-700">
            {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 rounded-lg border border-[#4F46E5] px-4 py-2 text-sm font-medium text-[#4F46E5] hover:bg-amber-50"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
          <a
            href={`/api/reports/export?type=ncr-quarterly&quarter=${data.quarter}`}
            download
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Download .xlsx
          </a>
          {submittedAt ? (
            <div className="flex items-center gap-2 rounded-lg bg-green-100 px-4 py-2 text-sm font-medium text-green-800">
              <CheckCircle className="h-4 w-4" /> Submitted {formatDate(submittedAt)}
            </div>
          ) : canSubmit ? (
            <button
              onClick={onMarkSubmitted}
              disabled={submitting}
              className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white hover:bg-[#4338CA] disabled:opacity-50"
            >
              {submitting ? "Recording…" : "Mark as Submitted"}
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-amber-100 px-4 py-2 text-sm font-medium text-amber-800">
              Not submitted
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {submittedAt && data.submittedByName && (
        <p className="mb-4 text-xs text-gray-500">
          Recorded as submitted by {data.submittedByName} on {formatDateTime(submittedAt)}.
        </p>
      )}

      {asFiled && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Showing {label} <strong>as filed</strong>
            {submittedAt ? ` on ${formatDate(submittedAt)}` : ""}. These are the figures the
            return was submitted with, read back from the submission record — the live book has
            moved since.
          </span>
        </p>
      )}

      {data.quarterOpen && !asFiled && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {label} has not closed yet. These figures will keep moving until{" "}
            {formatDate(data.periodEnd)}.
          </span>
        </p>
      )}

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="font-semibold text-[#1b1d24]">{label} — activity in the quarter</h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Driven by dates inside the period, so these reproduce for any past quarter.
          </p>
        </div>
        <LineTable lines={periodLines} caption={`${label} in-quarter activity`} />
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 className="font-semibold text-[#1b1d24]">Portfolio position</h2>
          <p className="mt-0.5 text-xs text-gray-400">
            {asFiled
              ? `As filed. Arrears, ageing and status carry no history, so these are the values frozen at submission — not the book today.`
              : `Arrears, ageing and status are current-state fields with no history, so these read as at ${formatDate(new Date())}.`}
          </p>
        </div>
        {data.filedSnapshotUnreadable && (
          <p className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {label} <strong>was submitted</strong>, but the figures filed with it could not be
              read back from the submission record. What the return said is not recoverable
              here. The figures below are today&apos;s book, not what was filed.
            </span>
          </p>
        )}

        {data.positionIsStale && !data.filedSnapshotUnreadable && (
          <p className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {label} has closed and no return was filed for it. The figures below are
              today&apos;s book, not the book as it stood on {formatDate(data.periodEnd)} — the
              system keeps no history of arrears ageing. Filing now records what you see here.
            </span>
          </p>
        )}
        <LineTable lines={positionLines} caption="Portfolio position" />
        <div className="flex justify-between border-t border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-5 py-4 text-xs text-[var(--cf-text-secondary)]">
          <span>
            NCR Registration: <span className="font-mono font-bold">{data.ncrNumber}</span>
          </span>
          <span>{label}</span>
        </div>
      </div>
    </div>
  )
}
