"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

type Match = { listName?: string; matchedName?: string; score?: number | null; detail?: string | null }

export type QueueItem = {
  checkId: string
  clientId: string | null
  entityId: string | null
  partyName: string
  partyReference: string
  type: string
  result: string
  matches: unknown
  simulated: boolean
  createdAt: string
  triggeredById: string | null
}

export const partyHref = (p: { clientId: string | null; entityId: string | null }) =>
  p.clientId ? `/clients/${p.clientId}?tab=compliance` : `/asset-finance/entities/${p.entityId}`

const TYPE_LABEL: Record<string, string> = { PEP: "PEP", SANCTIONS: "Sanctions", ADVERSE_MEDIA: "Adverse media" }

function ReviewForm({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const [decision, setDecision] = useState("FALSE_POSITIVE")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/screening/checks/${item.checkId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? "The decision was not recorded.")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision was not recorded.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <select
        aria-label="Decision"
        className="h-9 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] px-2 text-sm text-[var(--cf-text)]"
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
      >
        <option value="FALSE_POSITIVE">False positive — not this client</option>
        {item.type !== "SANCTIONS" && <option value="ACCEPTED">Accept — this client, enhanced due diligence</option>}
        <option value="REJECTED">Reject — the match stands, block approval</option>
      </select>
      <Textarea
        aria-label="Reason"
        placeholder="Why (at least 15 characters): what you checked and what it showed."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
      <Button size="sm" onClick={submit} disabled={busy || reason.trim().length < 15}>
        {busy ? "Recording…" : "Record decision"}
      </Button>
    </div>
  )
}

export function ScreeningReviewQueue({ items, total, page, pageSize, canReview, viewerId }: {
  items: QueueItem[]
  total: number
  page: number
  pageSize: number
  canReview: boolean
  viewerId: string | null
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const router = useRouter()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review queue ({total})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No matches are waiting for a decision.</p>}
        {!canReview && items.length > 0 && (
          <p className="text-sm text-[var(--cf-warning)]">Your role is below this lender&apos;s minimum for deciding matches.</p>
        )}
        {items.map((item) => (
          <div key={item.checkId} className="rounded-md border border-[var(--cf-border-subtle)] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={partyHref(item)} className="font-medium text-[var(--cf-brand-soft)] hover:underline">
                {item.partyName}
              </Link>
              <span className="text-xs text-[var(--cf-text-muted)]">{item.entityId ? "Entity · " : ""}{item.partyReference}</span>
              <Badge variant="warning">
                {TYPE_LABEL[item.type] ?? item.type} · {item.result === "CONFIRMED_MATCH" ? "match" : "possible match"}
              </Badge>
              {item.simulated && <Badge variant="neutral">Simulated</Badge>}
            </div>
            <ul className="mt-2 space-y-1 text-sm text-[var(--cf-text-secondary)]">
              {(Array.isArray(item.matches) ? (item.matches as Match[]) : []).map((m, i) => (
                <li key={i}>
                  {m.matchedName ?? "—"} on {m.listName ?? "—"}
                  {typeof m.score === "number" ? ` (score ${m.score})` : ""}
                  {m.detail ? ` — ${m.detail}` : ""}
                </li>
              ))}
            </ul>
            {viewerId !== null && item.triggeredById === viewerId ? (
              <p className="mt-3 text-sm text-[var(--cf-text-muted)]">You started this screening run; another reviewer decides it.</p>
            ) : canReview ? (
              <ReviewForm item={item} onDone={() => router.refresh()} />
            ) : null}
          </div>
        ))}
        {pages > 1 && (
          <div className="flex items-center gap-3 text-sm text-[var(--cf-text-secondary)]">
            {page > 1 && <Link className="text-[var(--cf-brand-soft)] hover:underline" href={`?page=${page - 1}`}>Previous</Link>}
            <span>Page {page} of {pages}</span>
            {page < pages && <Link className="text-[var(--cf-brand-soft)] hover:underline" href={`?page=${page + 1}`}>Next</Link>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
