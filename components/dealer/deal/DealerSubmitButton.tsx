"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

/** Hands the draft to the lender (POST …/submit); the lender's refusal reason is shown as given. */
export function DealerSubmitButton({ dealId }: { dealId: string }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/dealer/deals/${dealId}/submit`, { method: "POST" })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) return setError(body.error ?? `The deal could not be submitted (${res.status})`)
      router.refresh()
    } catch {
      setError("Network error. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={submit} disabled={saving}>{saving ? "Submitting…" : "Submit to the lender"}</Button>
      {error ? <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p> : null}
    </div>
  )
}
