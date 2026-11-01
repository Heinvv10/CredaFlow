"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

interface Pending { id: string; channel: "EMAIL" | "WHATSAPP"; display: string }

/**
 * Staff set a borrower's email or WhatsApp number: no signing code or login recovery goes there until a second staff member
 * confirms the address they reviewed, with a note (lib/contact/identity-confirmation.ts).
 */
export function ContactConfirmCard({ pending, endpoint }: { pending: Pending[]; endpoint: string }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  if (pending.length === 0) return null

  async function confirm(identityId: string) {
    setBusy(identityId)
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identityId, note }) })
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
      <p className="font-semibold">Contact details awaiting confirmation</p>
      <p className="mt-1 text-[var(--cf-text-muted)]">
        Staff set these. No signing code or portal login recovery goes to them until someone other than that staff member confirms them.
      </p>
      <label className="mt-3 block">
        How do you know these are the borrower&rsquo;s?
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1 w-full rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-2" />
      </label>
      <ul className="mt-3 space-y-2">
        {pending.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>{p.channel === "EMAIL" ? "Email" : "WhatsApp"}: {p.display}</span>
            <Button size="sm" variant="outline" disabled={busy !== null || note.trim().length < 10} onClick={() => confirm(p.id)}>
              Confirm
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
