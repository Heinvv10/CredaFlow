"use client"

import { useState } from "react"
import { Loader2, Route } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"
import { formatDateTime } from "@/lib/utils"
import { SimulatedChip } from "./SimulatedChip"

type Point = { latitude: number; longitude: number; accuracyM: number | null; occurredAt: string; simulated: boolean }

/** The points as an inline SVG polyline, scaled to their own bounds: no tiles, no external call. */
function TrailPlot({ points }: { points: Point[] }) {
  const W = 320
  const H = 200
  const lats = points.map((p) => p.latitude)
  const lngs = points.map((p) => p.longitude)
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)]
  const x = (lng: number) => 10 + ((lng - minLng) / (maxLng - minLng || 1)) * (W - 20)
  const y = (lat: number) => H - 10 - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 20)
  const path = points.map((p) => `${x(p.longitude).toFixed(1)},${y(p.latitude).toFixed(1)}`).join(" ")
  const last = points[points.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trail of the asset's positions, oldest to newest"
      className="w-full max-w-sm rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]">
      <polyline points={path} fill="none" stroke="var(--cf-brand)" strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={x(p.longitude)} cy={y(p.latitude)} r="2.5" fill="var(--cf-text-muted)" />)}
      <circle cx={x(last.longitude)} cy={y(last.latitude)} r="5" fill="var(--cf-danger)" />
    </svg>
  )
}

/**
 * "Show trail" (SLICE5-FOLLOWUPS.md part T): the positions of this loan's
 * tenure within retention, for THEFT, RECOVERY or LEGAL_MATTER only. Pressing
 * the button asks the server, which logs the view first; the page never
 * carries a coordinate. `refusal` (lib/telematics/position-purpose.ts) is
 * shown instead of the button when the server would refuse.
 */
export function PositionTrail({ loanId, context, refusal = null }: { loanId: string; context: "THEFT" | "RECOVERY" | "LEGAL_MATTER"; refusal?: string | null }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trail, setTrail] = useState<{ points: Point[]; truncated: boolean } | null>(null)

  const reveal = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/loans/${loanId}/telematics/trail`, "POST", { context })
    setBusy(false)
    if (!result.ok) return setError(result.error)
    setTrail(result.body as { points: Point[]; truncated: boolean })
  }

  if (refusal) return <p className="text-xs text-[var(--cf-text-muted)]" data-testid="position-trail-refused">{`Trail: ${refusal}.`}</p>
  return (
    <div className="space-y-2" data-testid="position-trail">
      <Button size="sm" variant="outline" onClick={reveal} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Route className="mr-1.5 h-4 w-4" />}
        Show trail
      </Button>
      <FormError message={error} />
      {trail && (trail.points.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-secondary)]">No positions from this loan&apos;s tenure within the retention period.</p>
      ) : (
        <div className="space-y-2">
          <TrailPlot points={trail.points} />
          {trail.truncated && <p className="text-xs text-[var(--cf-text-muted)]">The latest 500 positions.</p>}
          <ol className="max-h-56 space-y-0.5 overflow-y-auto text-xs">
            {trail.points.map((p, i) => (
              <li key={i} className="flex flex-wrap gap-2">
                <span className="text-[var(--cf-text-secondary)]">{formatDateTime(p.occurredAt)}</span>
                <span className="font-mono text-[var(--cf-text)]">{`${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`}</span>
                {p.accuracyM !== null && <span className="text-[var(--cf-text-muted)]">{`± ${p.accuracyM} m`}</span>}
                {p.simulated && <SimulatedChip />}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}
