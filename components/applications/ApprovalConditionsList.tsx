"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ApprovalProgress } from "@/lib/approval/progress"

interface Props {
  applicationId: string
  progress: Pick<ApprovalProgress, "conditions" | "viewer">
}

/** The committee's conditions on an approved application: what still holds up the signature and the payout, and the place to clear each. */
export function ApprovalConditionsList({ applicationId, progress }: Props) {
  const router = useRouter()
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (progress.conditions.length === 0) return null
  const open = progress.conditions.filter((c) => c.cleared === null).length

  async function clear(index: number) {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/applications/${applicationId}/committee/conditions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index, note: notes[index] ?? "" }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    setBusy(false)
    if (!res.ok) return setError(body.error ?? "Could not clear the condition.")
    router.refresh()
  }

  return (
    <div className="space-y-2" aria-label="Conditions of approval">
      <h4 className="text-xs font-semibold uppercase text-[var(--cf-text-muted)]">Conditions of approval</h4>
      <p className="text-xs text-[var(--cf-text-secondary)]">
        {open === 0 ? "Every condition is met." : `${open} of ${progress.conditions.length} not yet met: the agreement cannot be signed and the loan cannot be paid out until each is cleared.`}
      </p>
      <ul className="space-y-2 text-xs">
        {progress.conditions.map((c) => (
          <li key={c.index} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={c.cleared ? "success" : "warning"}>{c.cleared ? "Met" : "Open"}</Badge>
              <span>{c.text ?? `Condition ${c.index + 1}`}</span>
            </div>
            {c.cleared && <p className="text-[var(--cf-text-muted)]">Cleared by {c.cleared.by} on {c.cleared.at.slice(0, 10)}{c.cleared.note ? `: ${c.cleared.note}` : ""}</p>}
            {!c.cleared && progress.viewer.canClearConditions && (
              <div className="flex flex-wrap items-center gap-2">
                <Input className="w-80" aria-label={`What shows condition ${c.index + 1} is met`} placeholder="What shows it is met" value={notes[c.index] ?? ""} onChange={(e) => setNotes({ ...notes, [c.index]: e.target.value })} />
                <Button size="sm" variant="outline" disabled={busy} onClick={() => clear(c.index)}>Clear</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}
