"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { sendJson } from "@/components/asset-finance/register-form-controls"

/** One POST, then a refresh; a refusal shows inline. */
function useAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (url: string, body: unknown) => {
    setBusy(true)
    setError(null)
    const result = await sendJson(url, "POST", body)
    setBusy(false)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }
  return { busy, error, run }
}

function NoteAndButtons(props: { noteLabel: string; busy: boolean; error: string | null; buttons: { label: string; onClick: (note: string) => void; requiresNote: boolean }[] }) {
  const [note, setNote] = useState("")
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={props.noteLabel} placeholder={props.noteLabel} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
        className="h-8 min-w-[12rem] rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface)] px-2 text-sm text-[var(--cf-text)]" />
      {props.buttons.map((b) => (
        <Button key={b.label} size="sm" variant="outline" disabled={props.busy || (b.requiresNote && note.trim().length < 3)} onClick={() => b.onClick(note)}>{b.label}</Button>
      ))}
      {props.error && <span role="alert" className="text-xs text-[var(--cf-danger)]">{props.error}</span>}
    </div>
  )
}

/** Acknowledge an OPEN alert; resolve an open or acknowledged one with a note (work_telematics_alerts). */
export function AlertActions({ alertId, status }: { alertId: string; status: string }) {
  const { busy, error, run } = useAction()
  const base = `/api/asset-finance/telematics/alerts/${alertId}`
  return (
    <NoteAndButtons noteLabel="How it was resolved" busy={busy} error={error} buttons={[
      ...(status === "OPEN" ? [{ label: "Acknowledge", requiresNote: false, onClick: () => run(`${base}/acknowledge`, {}) }] : []),
      { label: "Resolve", requiresNote: true, onClick: (note: string) => run(`${base}/resolve`, { note }) },
    ]} />
  )
}

/** Accept a held reading (you vouch for it) or reject it, each with a note (manage_asset_finance). */
export function HeldReadingActions({ heldId }: { heldId: string }) {
  const { busy, error, run } = useAction()
  const base = `/api/asset-finance/telematics/held-readings/${heldId}`
  return (
    <NoteAndButtons noteLabel="Note (what it rests on, or why not)" busy={busy} error={error} buttons={[
      { label: "Accept", requiresNote: true, onClick: (note: string) => run(`${base}/accept`, { note }) },
      { label: "Reject", requiresNote: true, onClick: (note: string) => run(`${base}/reject`, { note }) },
    ]} />
  )
}

/** Record that a real device's meter was compared with the asset's own, with a note (manage_asset_finance; once). */
export function VerifyMeterAction({ deviceId }: { deviceId: string }) {
  const { busy, error, run } = useAction()
  return (
    <NoteAndButtons noteLabel="How the meters were compared" busy={busy} error={error} buttons={[
      { label: "Verify meter", requiresNote: true, onClick: (note: string) => run(`/api/asset-finance/tracker-devices/${deviceId}/verify-meter`, { note }) },
    ]} />
  )
}
