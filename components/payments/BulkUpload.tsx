"use client"

import { useState, useRef } from "react"
import { Upload, CheckCircle, XCircle, AlertCircle, Download } from "lucide-react"
import { formatZAR } from "@/lib/utils"

interface UploadResult {
  processed: number
  skipped: number
  errors: { row: number; reference: string; reason: string }[]
  payments: { id: string; loanRef: string; amount: number }[]
  /** rows the charges replay refused: money held for reconciliation */
  held?: { id: string; row: number; loanRef: string; amount: number; reason: string }[]
  /** money beyond what settles a loan: recorded refund-due */
  refundDue?: { id: string; row: number; loanRef: string; amount: number }[]
}

/** Money the upload recorded without allocating it: staff act on it in Needs Reconciliation. */
export function BulkUploadRecorded({ held, refundDue }: {
  held: NonNullable<UploadResult["held"]>
  refundDue: NonNullable<UploadResult["refundDue"]>
}) {
  if (held.length === 0 && refundDue.length === 0) return null
  return (
    <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 space-y-1">
      {held.length > 0 && (
        <p className="text-xs font-semibold text-amber-800">{held.length} held for reconciliation</p>
      )}
      {held.map((h) => (
        <p key={h.id} className="text-xs text-amber-700">Row {h.row} — {h.loanRef}: {formatZAR(h.amount)} ({h.reason})</p>
      ))}
      {refundDue.length > 0 && (
        <p className="text-xs font-semibold text-amber-800">{refundDue.length} recorded as refund due</p>
      )}
      {refundDue.map((r) => (
        <p key={r.id} className="text-xs text-amber-700">Row {r.row} — {r.loanRef}: {formatZAR(r.amount)}</p>
      ))}
    </div>
  )
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n").filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""))
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/"/g, ""))
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? "" })
    return row
  })
}

const TEMPLATE_CSV = `reference,amount,method,paymentRef,notes
LN-20260224-0001,1500,EFT,TRN240104001,April installment
LN-20260224-0002,800,CASH,,Cash payment at office
`

export function BulkUpload({ onComplete }: { onComplete?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [filename, setFilename] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    setResult(null)
    setError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const parsed = parseCSV(text)
      setRows(parsed)
    }
    reader.readAsText(file)
  }

  async function submit() {
    if (rows.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const payload = rows.map(r => ({
        reference: r.reference ?? r.loan_reference ?? r["loan reference"] ?? "",
        amount: parseFloat(r.amount ?? r.Amount ?? "0"),
        method: r.method ?? r.Method ?? "EFT",
        paymentRef: r.paymentref ?? r.payment_ref ?? r.reference_no ?? r.paymentRef ?? "",
        notes: r.notes ?? r.Notes ?? "",
      }))

      const res = await fetch("/api/payments/bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      })
      const data = await res.json() as UploadResult | { error: string }
      if ("error" in data) { setError(data.error); return }
      setResult(data as UploadResult)
      onComplete?.()
    } catch {
      setError("Upload failed — check your connection")
    } finally {
      setLoading(false)
    }
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a"); a.href = url; a.download = "lms-payment-template.csv"; a.click()
  }

  return (
    <div className="space-y-4">
      {/* Template download */}
      <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-100 rounded-lg">
        <div>
          <p className="text-sm font-semibold text-blue-800">CSV Format</p>
          <p className="text-xs text-blue-600">Columns: reference, amount, method, paymentRef, notes</p>
        </div>
        <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline">
          <Download className="h-3.5 w-3.5" />
          Download Template
        </button>
      </div>

      {/* Upload zone */}
      <div
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center cursor-pointer hover:border-green-300 hover:bg-green-50 transition-colors"
      >
        <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-600">{filename || "Click to upload CSV"}</p>
        <p className="text-xs text-gray-400 mt-1">Max 500 rows per upload</p>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
      </div>

      {/* Preview */}
      {rows.length > 0 && !result && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">{rows.length} rows parsed</p>
            <button
              onClick={submit}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: "#10B981" }}
            >
              {loading ? "Uploading…" : `Upload ${rows.length} payments`}
            </button>
          </div>
          <div className="overflow-x-auto rounded border border-gray-100">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {Object.keys(rows[0]).map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-gray-400 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((row, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="px-3 py-2 text-gray-700">{v}</td>
                    ))}
                  </tr>
                ))}
                {rows.length > 5 && (
                  <tr><td colSpan={Object.keys(rows[0]).length} className="px-3 py-2 text-gray-400 text-center">+{rows.length - 5} more rows…</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded px-3 py-2">
          <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-3 bg-green-50 border border-green-100 rounded-lg px-4 py-3">
              <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0" />
              <div>
                <p className="text-lg font-bold text-green-700">{result.processed}</p>
                <p className="text-xs text-green-600">payments processed</p>
                <p className="text-xs font-semibold text-green-700"><span className="whitespace-nowrap">{formatZAR(result.payments.reduce((s, p) => s + p.amount, 0))}</span> total</p>
              </div>
            </div>
            {result.skipped > 0 && (
              <div className="flex items-center gap-3 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                <div>
                  <p className="text-lg font-bold text-red-600">{result.skipped}</p>
                  <p className="text-xs text-red-500">rows skipped</p>
                </div>
              </div>
            )}
          </div>
          <BulkUploadRecorded held={result.held ?? []} refundDue={result.refundDue ?? []} />
          {result.errors.length > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
              <p className="text-xs font-semibold text-amber-800 mb-2">Skipped rows:</p>
              <div className="space-y-1">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-amber-700">Row {e.row} — {e.reference || "?"}: {e.reason}</p>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => { setRows([]); setResult(null); setFilename(""); if (fileRef.current) fileRef.current.value = "" }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Upload another file
          </button>
        </div>
      )}
    </div>
  )
}
