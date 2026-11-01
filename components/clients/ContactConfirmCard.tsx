"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

interface Pending { channel: "EMAIL" | "WHATSAPP"; display: string }

/**
 * Staff changed a borrower's email or WhatsApp number: no signing code goes there until someone else says it is theirs
 * (lib/contact/identity-confirmation.ts). In the portal the borrower says so; on the client record a different staff member does, with a note.
 */
export function ContactConfirmCard({ pending, endpoint, staff }: { pending: Pending[]; endpoint: string; staff: boolean }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  if (pending.length === 0) return null

  async function confirm(channel: Pending["channel"]) {
    setBusy(channel)
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, ...(staff ? { note } : {}) }) })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        toast.error?.("Could not confirm", data.error ?? "Try again")
        return
      }
      setNote("")
      router.refresh()
    } catch {
      toast.networkError?.()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-[var(--cf-warning)] p-4 text-sm" data-testid="contact-confirm-card">
      <p className="font-semibold">{staff ? "Contact details awaiting confirmation" : "Please confirm your contact details"}</p>
      <p className="mt-1 text-[var(--cf-text-muted)]">
        {staff ? "Staff changed these. No signing code goes to them until someone other than that staff member confirms them, or the borrower does in the portal." : "We changed these on your record. Signing codes go to them only once you confirm they are yours."}
      </p>
      {staff && (
        <label className="mt-3 block">
          How do you know these are the borrower&rsquo;s?
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1 w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-2" />
        </label>
      )}
      <ul className="mt-3 space-y-2">
        {pending.map((p) => (
          <li key={p.channel} className="flex flex-wrap items-center justify-between gap-2">
            <span>{p.channel === "EMAIL" ? "Email" : "WhatsApp"}: {p.display}</span>
            <Button size="sm" variant="outline" disabled={busy !== null || (staff && note.trim().length < 10)} onClick={() => confirm(p.channel)}>
              {staff ? "Confirm" : "This is mine"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
