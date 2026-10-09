"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { AlertTriangle, Download } from "lucide-react"
import { formatDate, formatDateTime } from "@/lib/utils"
import { ADVERSE_LABELS, holdReasonLabel } from "@/lib/bureau-submission/labels"
import type { AwaitingAdverse, HeldRecord, SubmissionRow } from "@/lib/bureau-submission/staff-view.server"

type Setup = { mode: "TEST" | "LIVE"; supplierNumber: string | null; tradingName: string | null; reportingStartDay: string | null }

const TH = "px-5 py-3 text-left"
const HEAD = "bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400"
const CARD = "overflow-hidden rounded-2xl bg-white shadow-sm"
const BUTTON = "rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white hover:bg-[#4338CA] disabled:opacity-50"
const INPUT = "rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-[#4F46E5] focus:outline-none"

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { ok: response.ok, data: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

const OUTCOME_MESSAGES: Record<string, string> = {
  NOT_CONFIGURED: "Not generated: the supplier number, trading name or reporting start date is not set.",
  DISABLED: "Not generated: bureau submission is switched off.",
  BEFORE_REPORTING_START: "Not generated: that period is before the reporting start date.",
  NOTHING_TO_SEND: "Nothing to send for that day, so no file was generated.",
}

export function BureauSubmissionsClient({
  setup, submissions, held, awaiting, defaultPeriod,
}: {
  setup: Setup
  submissions: SubmissionRow[]
  held: HeldRecord[]
  awaiting: AwaitingAdverse[]
  defaultPeriod: string
}) {
  const router = useRouter()
  const [kind, setKind] = useState<"MONTHLY" | "DAILY">("MONTHLY")
  const [period, setPeriod] = useState(defaultPeriod)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [noticeDates, setNoticeDates] = useState<Record<string, string>>({})
  const configured = Boolean(setup.supplierNumber && setup.tradingName && setup.reportingStartDay)

  async function generate() {
    setBusy(true)
    setMessage(null)
    const { ok, data } = await post("/api/compliance/bureau-submissions", { kind, period })
    setBusy(false)
    if (!ok) return setMessage({ tone: "error", text: String(data.error ?? "Generation failed") })
    if (data.outcome !== "GENERATED") {
      return setMessage({ tone: "error", text: OUTCOME_MESSAGES[String(data.outcome)] ?? "No file was generated." })
    }
    setMessage({ tone: "ok", text: `Generated ${String(data.fileName)}: ${String(data.recordCount)} record(s) in the file, ${String(data.heldCount)} held back.` })
    router.refresh()
  }

  async function confirm(row: AwaitingAdverse) {
    const noticeDate = noticeDates[row.loanId] ?? ""
    if (!noticeDate) return setMessage({ tone: "error", text: "Enter the date the consumer was given notice." })
    setBusy(true)
    setMessage(null)
    const { ok, data } = await post("/api/compliance/bureau-submissions/adverse-confirmations", {
      loanId: row.loanId, statusCode: row.statusCode, noticeDate,
    })
    setBusy(false)
    if (!ok) return setMessage({ tone: "error", text: String(data.error ?? "Could not record the confirmation") })
    setMessage({ tone: "ok", text: `Confirmed. ${row.reference} will be listed as "${ADVERSE_LABELS[row.statusCode]}" in the next monthly file.` })
    router.refresh()
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-[#1b1d24]">Bureau submissions</h1>
        <p className="mt-1 text-sm text-gray-500">
          Loan data reported to Experian in the SACRRA Layout 700v2 format. Files are generated here;
          nothing is sent to Experian automatically yet.
        </p>
      </div>

      <dl className={`${CARD} mb-5 grid gap-4 px-5 py-4 text-sm sm:grid-cols-4`}>
        <div><dt className="text-xs font-semibold text-gray-500">Scheduled mode</dt><dd data-testid="bureau-mode" className="font-mono">{setup.mode}</dd></div>
        <div><dt className="text-xs font-semibold text-gray-500">Supplier number</dt><dd className="font-mono">{setup.supplierNumber ?? "Not set"}</dd></div>
        <div><dt className="text-xs font-semibold text-gray-500">Trading name</dt><dd>{setup.tradingName ?? "Not set"}</dd></div>
        <div><dt className="text-xs font-semibold text-gray-500">Reporting from</dt><dd>{setup.reportingStartDay ? formatDate(setup.reportingStartDay) : "Not set"}</dd></div>
      </dl>

      {!configured && (
        <p className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No file can be generated until the supplier number, trading name and reporting start date are set.</span>
        </p>
      )}

      <div className={`${CARD} mb-5 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end`}>
        <div>
          <label htmlFor="bureau-kind" className="mb-1 block text-xs font-semibold text-gray-500">File</label>
          <select id="bureau-kind" value={kind} onChange={(e) => setKind(e.target.value as "MONTHLY" | "DAILY")} disabled={busy} className={INPUT}>
            <option value="MONTHLY">Monthly</option>
            <option value="DAILY">Daily</option>
          </select>
        </div>
        <div>
          <label htmlFor="bureau-period" className="mb-1 block text-xs font-semibold text-gray-500">
            {kind === "MONTHLY" ? "Month end" : "Transaction date"}
          </label>
          <input id="bureau-period" type="date" value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy} className={INPUT} />
        </div>
        <button onClick={generate} disabled={busy || !configured} className={BUTTON}>
          {busy ? "Working…" : "Generate test file"}
        </button>
        <p className="text-xs text-gray-400 sm:ml-2 sm:max-w-sm">
          A test file is for review. It is never counted as sent, so it can be generated again; the newest one replaces the last.
        </p>
      </div>

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error"
            ? "mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
            : "mb-5 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800"}
        >
          {message.text}
        </p>
      )}

      <section className={`${CARD} mb-5`} aria-labelledby="bureau-awaiting">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 id="bureau-awaiting" className="font-semibold text-[#1b1d24]">Adverse listings awaiting confirmation</h2>
          <p className="mt-0.5 text-xs text-gray-400">
            A written-off or handed-over status is not sent until you confirm the consumer was given notice.
            Until then the loan reports its arrears with no status.
          </p>
        </div>
        {awaiting.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-500">None.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={HEAD}><th className={TH}>Loan</th><th className={TH}>Listing</th><th className={TH}>Date</th><th className={TH}>Notice given on</th><th className={TH} /></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {awaiting.map((row) => (
                  <tr key={`${row.loanId}-${row.statusCode}`} data-testid="bureau-awaiting-row">
                    <td className="px-5 py-3"><Link href={`/loans/${row.loanId}`} className="font-mono text-[#4F46E5] hover:underline">{row.reference}</Link></td>
                    <td className="px-5 py-3">{ADVERSE_LABELS[row.statusCode]}</td>
                    <td className="px-5 py-3">{row.eventDay ? formatDate(row.eventDay) : "No date recorded"}</td>
                    <td className="px-5 py-3">
                      <input
                        type="date"
                        aria-label={`Date notice was given for ${row.reference}`}
                        value={noticeDates[row.loanId] ?? ""}
                        onChange={(e) => setNoticeDates((current) => ({ ...current, [row.loanId]: e.target.value }))}
                        disabled={busy}
                        className={INPUT}
                      />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => confirm(row)} disabled={busy} className={BUTTON}>Confirm adverse listing</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${CARD} mb-5`} aria-labelledby="bureau-held">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 id="bureau-held" className="font-semibold text-[#1b1d24]">Held records</h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Left out of the file because they failed validation. They are not reported until the data is fixed.
          </p>
        </div>
        {held.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-500">None.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={HEAD}><th className={TH}>Loan</th><th className={TH}>File</th><th className={TH}>Why it was held</th><th className={TH}>Fix</th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {held.map((row) => (
                  <tr key={`${row.loanId}-${row.kind}-${row.mode}-${row.dataFlag}`} data-testid="bureau-held-row">
                    <td className="px-5 py-3 font-mono">{row.reference}</td>
                    <td className="px-5 py-3 text-gray-600">{row.kind === "MONTHLY" ? "Monthly" : "Daily"} {formatDate(row.periodDay)} ({row.mode})</td>
                    <td className="px-5 py-3">
                      <ul className="space-y-1">{row.reasons.map((reason) => <li key={reason}>{holdReasonLabel(reason)}</li>)}</ul>
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/loans/${row.loanId}`} className="text-[#4F46E5] hover:underline">Loan</Link>
                      {" · "}
                      <Link href={`/clients/${row.clientId}`} className="text-[#4F46E5] hover:underline">Client</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={CARD} aria-labelledby="bureau-history">
        <div className="border-b border-gray-100 px-5 py-4">
          <h2 id="bureau-history" className="font-semibold text-[#1b1d24]">Files generated</h2>
        </div>
        {submissions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-500">No file has been generated yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={HEAD}>
                  <th className={TH}>File</th><th className={TH}>Period</th><th className={TH}>Mode</th>
                  <th className="px-5 py-3 text-right">Records</th><th className="px-5 py-3 text-right">Held</th>
                  <th className={TH}>Status</th><th className={TH}>Generated</th><th className={TH} />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {submissions.map((row) => (
                  <tr key={row.id} data-testid="bureau-submission-row" className="hover:bg-gray-50">
                    <td className="px-5 py-3">
                      <span className="font-mono text-xs">{row.fileName}</span>
                      <span className="block font-mono text-[10px] text-gray-400" data-testid="bureau-sha256" title="SHA-256 of the file">{row.sha256}</span>
                    </td>
                    <td className="px-5 py-3">{row.kind === "MONTHLY" ? "Monthly" : "Daily"} {formatDate(row.periodDay)}</td>
                    <td className="px-5 py-3">{row.mode}</td>
                    <td className="px-5 py-3 text-right">{row.recordCount}</td>
                    <td className="px-5 py-3 text-right">{row.heldCount}</td>
                    <td className="px-5 py-3">{row.superseded ? "Replaced by a newer test file" : row.status === "GENERATED" ? "Generated, not sent" : row.status}</td>
                    <td className="px-5 py-3 text-gray-600">{formatDateTime(row.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {!row.superseded && (
                        <a
                          href={`/api/compliance/bureau-submissions/${row.id}/download`}
                          className="inline-flex items-center gap-1 rounded-lg border border-[#4F46E5] px-3 py-1.5 text-xs font-medium text-[#4F46E5] hover:bg-amber-50"
                        >
                          <Download className="h-3.5 w-3.5" /> Download
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
