"use client"

import { useState } from "react"
import Link from "next/link"

type BulkResult = {
  reference: string
  outcome: "SENT" | "SKIPPED" | "FAILED" | "RECOVERY_REQUIRED" | "RECONCILIATION_REQUIRED"
  issuanceId?: string
  error?: string
}

type BulkResponse = {
  ok: boolean
  sent: number
  failed: number
  skipped: number
  reconciliationRequired?: number
  recoveryRequired?: number
  error?: string
  results?: BulkResult[]
}

export function BulkSection129Button({ count90Plus }: { count90Plus: number }) {
  const [state, setState] = useState<"idle" | "confirm" | "sending" | "done" | "warning" | "unknown" | "error">("idle")
  const [result, setResult] = useState<BulkResponse | null>(null)
  const [error, setError] = useState("")

  async function send() {
    setState("sending")
    try {
      const res = await fetch("/api/loans/section129/bulk", { method: "POST" })
      const data = await res.json() as BulkResponse
      setResult(data)
      setState(data.ok ? "done" : data.results ? "warning" : "error")
      if (!data.ok) setError(data.error ?? "Failed")
    } catch (e) {
      setState("unknown")
      setError(e instanceof Error ? e.message : "Failed")
    }
  }

  if (state === "done" && result) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm">
        <span className="text-green-600 font-semibold">✓ Bulk S.129 sent</span>
        <span className="text-gray-500">· {result.sent} sent, {result.skipped} skipped or blocked, {result.failed} failed</span>
        <button onClick={() => setState("idle")} className="text-gray-400 hover:text-gray-600 ml-2">×</button>
      </div>
    )
  }

  if (state === "warning" && result) {
    const uncertain = result.results?.filter((item) => item.outcome === "RECONCILIATION_REQUIRED") ?? []
    const recovery = result.results?.filter((item) => item.outcome === "RECOVERY_REQUIRED") ?? []
    return (
      <div className="max-w-2xl rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
        <p className="font-semibold text-amber-900">Bulk run completed with exceptions</p>
        <p className="mt-1 text-xs text-amber-800">
          {result.sent} sent, {result.skipped} skipped, {result.failed} failed, {uncertain.length} require reconciliation, {recovery.length} require timed-out recovery.
        </p>
        {uncertain.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-bold text-red-700">Do not retry uncertain notices.</p>
            {uncertain.map((item) => (
              <p key={`${item.reference}-${item.issuanceId}`} className="mt-1 break-all font-mono text-[10px] text-amber-900">
                {item.reference}: {item.issuanceId ?? "missing issuance id"}
              </p>
            ))}
            <Link href="/compliance" className="mt-2 inline-block text-xs font-semibold text-amber-900 underline">
              Open compliance reconciliation queue
            </Link>
          </div>
        )}
        {recovery.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-bold text-red-700">Do not retry records awaiting artifact recovery.</p>
            {recovery.map((item) => (
              <p key={`${item.reference}-${item.issuanceId}`} className="mt-1 break-all font-mono text-[10px] text-amber-900">
                {item.reference}: {item.issuanceId ?? "missing issuance id"}
              </p>
            ))}
            <Link href="/compliance" className="mt-2 inline-block text-xs font-semibold text-amber-900 underline">
              Open compliance recovery queue
            </Link>
          </div>
        )}
        {uncertain.length === 0 && recovery.length === 0 && (
          <button onClick={() => setState("idle")} className="mt-2 text-xs font-semibold text-amber-900 underline">
            Close and review known failures
          </button>
        )}
      </div>
    )
  }

  if (state === "unknown") {
    return (
      <div className="max-w-2xl rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
        <p className="font-semibold text-amber-900">Bulk request outcome unknown — do not rerun</p>
        <p className="mt-1 text-xs text-amber-800">{error}. Refresh the collections and compliance queues before any further action.</p>
        <Link href="/compliance" className="mt-2 inline-block text-xs font-semibold text-amber-900 underline">
          Open compliance queue
        </Link>
      </div>
    )
  }

  if (state === "confirm") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm">
        <span className="text-red-700 font-semibold">Send S.129 to all {count90Plus} accounts 90+ DPD?</span>
        <button onClick={send} className="px-3 py-1 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700">Send All</button>
        <button onClick={() => setState("idle")} className="px-3 py-1 border border-gray-300 text-xs rounded hover:bg-gray-50">Cancel</button>
      </div>
    )
  }

  if (state === "sending") {
    return <div className="px-4 py-2 bg-gray-50 rounded-lg text-sm text-gray-500">Sending notices…</div>
  }

  if (state === "error") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm">
        <span className="text-red-600">{error}</span>
        <button onClick={() => setState("idle")} className="text-gray-400 hover:text-gray-600 ml-2">×</button>
      </div>
    )
  }

  if (count90Plus === 0) return null

  return (
    <button onClick={() => setState("confirm")}
      className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700">
      ⚖️ Bulk S.129 ({count90Plus})
    </button>
  )
}
