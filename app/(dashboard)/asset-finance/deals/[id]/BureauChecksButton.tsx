"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"

interface BureauResult {
  outcome?: unknown
}

function busyCount(body: unknown): number {
  if (typeof body !== "object" || body === null || !("results" in body)) return 0
  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results)) return 0
  return results.filter((result): result is BureauResult => (
    typeof result === "object" && result !== null && (result as BureauResult).outcome === "busy"
  )).length
}

export function BureauChecksButton({ dealId }: { dealId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await sendJson(`/api/asset-finance/deals/${dealId}/bureau-checks`, "POST", {})
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const count = busyCount(result.body)
    if (count > 0) setNotice(`${count} bureau check${count === 1 ? " is" : "s are"} still busy. Run the checks again after the other request finishes.`)
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={run} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {busy ? "Checking…" : "Run bureau checks"}
      </Button>
      {notice && <p role="status" className="text-xs text-[var(--cf-warning)]">{notice}</p>}
      <FormError message={error} />
    </div>
  )
}
