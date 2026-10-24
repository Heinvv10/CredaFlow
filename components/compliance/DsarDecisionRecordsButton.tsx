"use client"

import { useState } from "react"
import { Download } from "lucide-react"

// Downloads the JSON of every decision record about the request's client
// (GET /api/dsar/[id]/decision-records). A client with none downloads an empty list.
export function DsarDecisionRecordsButton({ dsarId, reference }: { dsarId: string; reference: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/dsar/${dsarId}/decision-records`)
      if (!res.ok) throw new Error("Could not export the decision records")
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement("a")
      link.href = url
      link.download = `decision-records-${reference}.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] disabled:opacity-60 transition-colors"
      >
        <Download className="h-3 w-3" /> {busy ? "Exporting..." : "Download decision records"}
      </button>
      {error && <p role="alert" className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
