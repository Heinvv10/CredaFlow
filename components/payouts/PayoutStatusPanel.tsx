"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { PAYOUT_STATUS_LABELS, type PayoutStatus } from "@/lib/payouts/state"
import { formatZAR } from "@/lib/utils"

export interface PayoutView {
  id: string
  status: PayoutStatus
  provider: string
  amountCents: number
  bankName: string
  accountTail: string
  simulated: boolean
  providerReference: string | null
  failureReason: string | null
  submittedAt: string | null
  resolvedAt: string | null
  resolutionNote: string | null
}

const TONE: Record<PayoutStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  PENDING: "warning", SUBMITTING: "info", SUBMITTED: "info", PROCESSING: "info",
  PAID: "success", FAILED: "danger", RETURNED: "danger", NEEDS_REVIEW: "danger",
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : "—")

export function PayoutStatusPanel({ payout, canAct }: { payout: PayoutView; canAct: boolean }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [reference, setReference] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const confirmable = payout.status === "NEEDS_REVIEW" || payout.status === "SUBMITTED" || payout.status === "PROCESSING"

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/payouts/${payout.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as { error?: string; status?: string }
      setMessage(res.ok ? `Payout is now: ${PAYOUT_STATUS_LABELS[json.status as PayoutStatus] ?? json.status}` : json.error ?? `Failed (${res.status})`)
      if (res.ok) router.refresh()
    } catch {
      setMessage("Network error: nothing was changed by this page. Refresh to see the payout's state.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DataPanel
      title="Payout"
      description={`Provider: ${payout.provider}`}
      actions={<StatusPill tone={TONE[payout.status]}>{PAYOUT_STATUS_LABELS[payout.status]}</StatusPill>}
    >
      {payout.simulated && (
        <InfoStrip variant="warning" className="mb-4">Simulated — no money moved. Not a valid payout record.</InfoStrip>
      )}
      {payout.status === "NEEDS_REVIEW" && (
        <InfoStrip variant="warning" className="mb-4">
          The provider&apos;s answer is unknown. It will not be sent again. Check the provider&apos;s report, then confirm it paid or failed.
        </InfoStrip>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-[var(--cf-text-muted)]">Amount</dt><dd className="text-right font-medium tabular-nums text-[var(--cf-text)]">{formatZAR(payout.amountCents)}</dd>
        <dt className="text-[var(--cf-text-muted)]">To</dt><dd className="text-right text-[var(--cf-text)]">{payout.bankName} ••••{payout.accountTail}</dd>
        <dt className="text-[var(--cf-text-muted)]">Sent</dt><dd className="text-right text-[var(--cf-text)]">{fmt(payout.submittedAt)}</dd>
        <dt className="text-[var(--cf-text-muted)]">Provider reference</dt><dd className="truncate text-right text-[var(--cf-text)]">{payout.providerReference ?? "—"}</dd>
        {payout.failureReason && (<><dt className="text-[var(--cf-text-muted)]">Reason</dt><dd className="text-right text-[var(--cf-danger)]">{payout.failureReason}</dd></>)}
        {payout.resolvedAt && (<><dt className="text-[var(--cf-text-muted)]">Settled</dt><dd className="text-right text-[var(--cf-text)]">{fmt(payout.resolvedAt)}</dd></>)}
        {payout.resolutionNote && (<><dt className="text-[var(--cf-text-muted)]">Staff note</dt><dd className="text-right text-[var(--cf-text)]">{payout.resolutionNote}</dd></>)}
      </dl>
      {canAct && (
        <div className="mt-4 space-y-3 border-t border-[var(--cf-border-subtle)] pt-4">
          <div className="flex flex-wrap gap-2">
            {payout.status === "PENDING" && <Button size="sm" disabled={busy} onClick={() => act({ action: "send" })}>Send payout</Button>}
            {(payout.status === "SUBMITTING" || payout.status === "SUBMITTED" || payout.status === "PROCESSING") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "check" })}>Check status</Button>
            )}
          </div>
          {confirmable && (
            <div className="space-y-2">
              <Textarea placeholder="What you checked (required to confirm)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              <Input placeholder="Provider or bank reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || note.trim().length < 5} onClick={() => act({ action: "confirm_paid", note, providerReference: reference })}>Confirm paid</Button>
                <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => act({ action: "confirm_failed", note })}>Confirm not paid</Button>
              </div>
            </div>
          )}
          {message && <p className="text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
        </div>
      )}
    </DataPanel>
  )
}
