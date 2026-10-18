"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { formatMoney } from "@/lib/asset-finance/format"
import { postLeaseAction } from "./lease-action"

/** Records evidence of an already paid external refund; it never sends a payment. */
export function TotalLossRefundForm({ url, dealId, amountCents, today }: { url: string; dealId: string; amountCents: number; today: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const upload = new FormData()
      upload.set("file", form.get("file")!)
      upload.set("docType", "OTHER")
      const response = await fetch(`/api/asset-finance/deals/${dealId}/documents`, { method: "POST", body: upload })
      const document = await response.json()
      if (!response.ok || !document.id) throw new Error(document.error ?? "The refund proof could not be retained")
      const result = await postLeaseAction(url, { refund: { amountCents, paidOn: form.get("paidOn"), reference: form.get("reference"), documentId: document.id } })
      if (!result.ok) throw new Error(result.error)
      router.refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The refund evidence could not be recorded")
    } finally { setBusy(false) }
  }
  const field = "block w-full rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2 text-sm"
  return <form onSubmit={submit} className="space-y-3">
    <p className="text-sm">The maintenance fund owes the lessee {formatMoney(amountCents)}. Record proof after the refund has actually been paid outside CredaFlow, then settle this total loss.</p>
    <label className="block text-sm">Actual refund date<input className={field} type="date" name="paidOn" max={today} required /></label>
    <label className="block text-sm">Bank transaction reference<input className={field} name="reference" maxLength={120} required /></label>
    <label className="block text-sm">Retained proof of the exact refund<input className={field} type="file" name="file" accept="application/pdf,image/jpeg,image/png" required /></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" required />I confirm the lessee has already received this exact maintenance-fund refund.</label>
    {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
    <Button type="submit" size="sm" disabled={busy}>{busy ? "Recording…" : "Record actual refund and settle total loss"}</Button>
  </form>
}
