"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

interface Props {
  clientId: string
  blacklisted: boolean
  deceased: boolean
}

type Pending = "deceased" | "blacklisted" | null

/**
 * Records the two ASSERTED client statuses.
 *
 * ACTIVE and PAID_UP are absent on purpose — they are derived from the client's
 * loans and cannot be set by hand. This control only offers the two facts
 * somebody actually decides.
 *
 * Gated to LOAN_ADMIN+ by the caller, matching the API guard. The API is the
 * real gate; hiding the button is only so junior staff are not shown an action
 * that would 403.
 */
export function ClientStatusButton({ clientId, blacklisted, deceased }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState<Pending>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!pending || !reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          pending === "deceased"
            ? { deceased: !deceased, reason: reason.trim() }
            : { blacklisted: !blacklisted, reason: reason.trim() },
        ),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? "Could not update the client's status")
        return
      }
      setPending(null)
      setReason("")
      router.refresh()
    } catch {
      setError("Could not reach the server. The status was not changed.")
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    const undoing = pending === "deceased" ? deceased : blacklisted
    return (
      <div className="flex flex-col gap-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
        <label htmlFor="status-reason" className="text-sm font-medium">
          {pending === "deceased"
            ? undoing ? "Why is this record being reversed?" : "Record this client as deceased"
            : undoing ? "Why is the blacklisting being lifted?" : "Blacklist this client"}
        </label>
        <input
          id="status-reason"
          className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason — recorded in the audit trail"
          autoComplete="off"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? "Saving…" : "Confirm"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setPending(null); setReason(""); setError(null) }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setPending("deceased")}>
        {deceased ? "Reverse deceased record" : "Record as deceased"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => setPending("blacklisted")}>
        {blacklisted ? "Remove from blacklist" : "Blacklist"}
      </Button>
    </div>
  )
}
