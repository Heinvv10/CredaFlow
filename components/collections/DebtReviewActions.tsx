"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Staff actions on a loan's debt-review notice (NCA s.86): record it, or clear
 * it with a reason. Affordances only: the route enforces the role, 2FA, the date
 * and the reason (app/api/loans/[id]/debt-review/route.ts).
 */
export function DebtReviewActions({ loanId, recorded, today }: {
  loanId: string
  recorded: boolean
  /** The SAST calendar day, yyyy-mm-dd: the latest notice date the route accepts. */
  today: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [noticeDate, setNoticeDate] = useState("")
  const [reference, setReference] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = recorded ? reason.trim().length > 0 : noticeDate.length > 0

  function close() {
    setOpen(false)
    setError(null)
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/loans/${loanId}/debt-review`, {
        method: recorded ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recorded ? { reason } : { noticeDate, reference }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({})) as { error?: string }
        setError(json.error ?? `Request failed (${response.status})`)
        return
      }
      setOpen(false)
      setNoticeDate("")
      setReference("")
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
      {!open && (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {recorded ? "Clear debt-review notice" : "Record debt-review notice"}
        </Button>
      )}
      {open && (
        <div className="space-y-3">
          {recorded ? (
            <div className="space-y-2">
              <label htmlFor={`debt-review-reason-${loanId}`} className="block text-xs font-medium text-[var(--cf-text-muted)]">
                Reason (required, recorded in the audit trail). Automated reminders resume once cleared.
              </label>
              <textarea
                id={`debt-review-reason-${loanId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={2}
                className="w-full rounded border border-[var(--cf-border-subtle)] bg-transparent p-2 text-sm"
              />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`debt-review-date-${loanId}`} className="block text-xs font-medium text-[var(--cf-text-muted)]">
                  Date the notice was received
                </label>
                <Input
                  id={`debt-review-date-${loanId}`}
                  type="date"
                  max={today}
                  value={noticeDate}
                  onChange={(event) => setNoticeDate(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={`debt-review-ref-${loanId}`} className="block text-xs font-medium text-[var(--cf-text-muted)]">
                  Debt counsellor reference (optional)
                </label>
                <Input
                  id={`debt-review-ref-${loanId}`}
                  value={reference}
                  maxLength={100}
                  onChange={(event) => setReference(event.target.value)}
                />
              </div>
            </div>
          )}
          {error && <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !ready} onClick={submit}>
              {recorded ? "Confirm clear" : "Confirm notice"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
