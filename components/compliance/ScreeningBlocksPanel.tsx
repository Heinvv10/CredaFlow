"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { formatDate } from "@/lib/utils"
import { partyHref } from "./ScreeningReviewQueue"

export type BlockRow = {
  id: string
  clientId: string | null
  entityId: string | null
  partyName: string
  partyReference: string
  reason: "SANCTIONS_MATCH" | "REJECTED"
  createdAt: string
}

function LiftForm({ block, onDone }: { block: BlockRow; onDone: () => void }) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function lift() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/screening/blocks/${block.id}/lift`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? "The block was not lifted.")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "The block was not lifted.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        aria-label="Reason for lifting"
        placeholder="Why the block no longer applies (at least 15 characters), e.g. the list entry was removed and a new run is clear."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
      <Button size="sm" variant="destructive" onClick={lift} disabled={busy || reason.trim().length < 15}>
        {busy ? "Lifting…" : "Lift block"}
      </Button>
    </div>
  )
}

/**
 * Sticky screening blocks. Only a SUPER_ADMIN (with 2FA) lifts one; lifting
 * ends the stickiness, not the latest run's own result.
 */
export function ScreeningBlocksPanel({ blocks, canLift }: { blocks: BlockRow[]; canLift: boolean }) {
  const router = useRouter()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sticky blocks ({blocks.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {blocks.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No party is blocked.</p>}
        {blocks.map((b) => (
          <div key={b.id} className="rounded-md border border-[var(--cf-border-subtle)] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={partyHref(b)} className="font-medium text-[var(--cf-brand-soft)] hover:underline">{b.partyName}</Link>
              <span className="text-xs text-[var(--cf-text-muted)]">{b.entityId ? "Entity · " : ""}{b.partyReference}</span>
              <Badge variant="danger">{b.reason === "SANCTIONS_MATCH" ? "Sanctions match" : "Rejected match"}</Badge>
              <span className="text-xs text-[var(--cf-text-muted)]">since {formatDate(b.createdAt)}</span>
            </div>
            {canLift && <LiftForm block={b} onDone={() => router.refresh()} />}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
