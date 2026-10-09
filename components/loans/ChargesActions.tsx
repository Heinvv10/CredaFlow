"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { formatZAR } from "@/lib/utils"

type Action = "exemption" | "waiver"

/**
 * Staff actions on a loan's default charges. Both require a written reason;
 * the APIs enforce the role, the reason and (for the waiver) the 1–100 cent
 * bound — these controls are affordances only.
 */
export function ChargesActions({ loanId, chargesLive, exempt, waivable, settlementAmount }: {
  loanId: string
  chargesLive: boolean
  exempt: boolean
  waivable: boolean
  settlementAmount: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState<Action | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    const request = open === "waiver"
      ? { url: `/api/loans/${loanId}/small-balance-waiver`, method: "POST", body: { reason } }
      : { url: `/api/loans/${loanId}/default-charges-exemption`, method: "PATCH", body: { exempt: !exempt, reason } }
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({})) as { error?: string }
        setError(json.error ?? `Request failed (${response.status})`)
        return
      }
      setOpen(null)
      setReason("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-[var(--cf-border-subtle)] pt-4">
      <div className="flex flex-wrap gap-2">
        {chargesLive && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen("exemption")}>
            {exempt ? "Remove exemption" : "Exempt this loan"}
          </Button>
        )}
        {waivable && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen("waiver")}>
            Waive balance of {formatZAR(settlementAmount)}
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-2">
          <label htmlFor={`charges-reason-${loanId}`} className="block text-xs font-medium text-[var(--cf-text-muted)]">
            Reason (required, recorded in the audit trail)
          </label>
          <textarea
            id={`charges-reason-${loanId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={2}
            className="w-full rounded border border-[var(--cf-border-subtle)] bg-transparent p-2 text-sm"
          />
          {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || reason.trim().length === 0} onClick={submit}>
              {open === "waiver" ? "Confirm waiver" : exempt ? "Confirm removal" : "Confirm exemption"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(null); setError(null) }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
