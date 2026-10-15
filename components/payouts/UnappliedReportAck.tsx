"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { postAction } from "./post-action"

/** Acknowledge a provider report not applied, with a note (lib/payouts/unapplied-reports.ts). */
export function UnappliedReportAck({ id }: { id: string }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function acknowledge() {
    setBusy(true)
    const out = await postAction(`/api/payouts/reports/${id}`, { note })
    setMessage(out.message)
    if (out.ok) router.refresh()
    setBusy(false)
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Input placeholder="What you checked (required)" aria-label="What you checked" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 w-72" />
      <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={acknowledge}>Acknowledge</Button>
      {message && <span className="text-xs text-[var(--cf-text-secondary)]" role="status">{message}</span>}
    </div>
  )
}
