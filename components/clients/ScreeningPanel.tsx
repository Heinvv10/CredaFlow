"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/utils"

type Check = { id: string; type: string; result: string; decision: string | null; simulated: boolean }
type Screening = { state: { state: string }; message: string; runAt: string | null; checks: Check[] }

const STATE_VARIANT: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  CLEAR: "success", REFER: "warning", BLOCKED: "danger", INCOMPLETE: "warning", NOT_SCREENED: "neutral", NOT_CONFIGURED: "neutral",
}
const TYPE_LABEL: Record<string, string> = { PEP: "PEP", SANCTIONS: "Sanctions", ADVERSE_MEDIA: "Adverse media" }

type ScreeningResult = { data: Screening; error: null } | { data: null; error: string }

async function fetchScreening(endpoint: string): Promise<ScreeningResult> {
  const res = await fetch(endpoint)
  if (res.status === 403) return { data: null, error: "Your role cannot view screening results." }
  if (!res.ok) return { data: null, error: "Screening results could not be loaded." }
  return { data: (await res.json()) as Screening, error: null }
}

/**
 * PEP / sanctions screening of one party: a client (Compliance tab) or a
 * business entity (entity page). `endpoint` is its screening route. Credit
 * officer and up.
 */
export function ScreeningPanel({ endpoint }: { endpoint: string }) {
  const [data, setData] = useState<Screening | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function applyResult(result: ScreeningResult) {
    if (result.error !== null) setError(result.error)
    else setData(result.data)
  }

  // A stale response (the endpoint changed while it was in flight) is ignored.
  useEffect(() => {
    let ignore = false
    void fetchScreening(endpoint).then((result) => { if (!ignore) applyResult(result) })
    return () => { ignore = true }
  }, [endpoint])

  async function screenNow() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(endpoint, { method: "POST" })
      const body = (await res.json().catch(() => ({}))) as { error?: string; providerError?: string }
      if (!res.ok) setError(body.providerError ?? body.error ?? "Screening failed.")
      applyResult(await fetchScreening(endpoint))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-3 rounded border border-[var(--cf-border-subtle)] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[var(--cf-text-muted)]">PEP &amp; sanctions screening</p>
        {data && <Badge variant={STATE_VARIANT[data.state.state] ?? "neutral"}>{data.state.state.replaceAll("_", " ")}</Badge>}
        {data?.runAt && <span className="text-xs text-[var(--cf-text-muted)]">{formatDateTime(data.runAt)}</span>}
      </div>
      {data && <p className="text-sm text-[var(--cf-text-secondary)]">{data.message}</p>}
      {data && data.checks.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {data.checks.map((c) => (
            <li key={c.id}>
              <Badge variant={c.result === "CLEAR" ? "outline" : c.decision === "FALSE_POSITIVE" || c.decision === "ACCEPTED" ? "info" : "warning"}>
                {TYPE_LABEL[c.type] ?? c.type}: {c.result.replaceAll("_", " ").toLowerCase()}
                {c.decision ? ` · ${c.decision.replaceAll("_", " ").toLowerCase()}` : ""}
                {c.simulated ? " · simulated" : ""}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
      {data && data.state.state !== "NOT_CONFIGURED" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={screenNow} disabled={busy}>{busy ? "Screening…" : "Screen now"}</Button>
          {data.state.state === "REFER" && (
            <Button asChild size="sm" variant="ghost"><Link href="/compliance/screening">Open review queue</Link></Button>
          )}
        </div>
      )}
    </div>
  )
}
