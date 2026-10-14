"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

type Provider = { id: string; label: string; simulated: boolean }

const selectClass =
  "h-9 w-full max-w-sm rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] px-2 text-sm text-[var(--cf-text)]"

export function ScreeningSettingsForm({
  providers,
  initial,
}: {
  providers: Provider[]
  initial: { provider: string | null; reviewMinRole: "BRANCH_MANAGER" | "ADMIN" }
}) {
  const router = useRouter()
  const [provider, setProvider] = useState(initial.provider ?? "")
  const [reviewMinRole, setReviewMinRole] = useState(initial.reviewMinRole)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/screening", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider || null, reviewMinRole }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? "Settings were not saved.")
      setMessage({ ok: true, text: "Saved." })
      router.refresh()
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Settings were not saved." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Screening settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="screening-provider" className="block">Provider</Label>
          <select id="screening-provider" className={selectClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Not configured (no screening, no approval gate)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="screening-role" className="block">Who decides matches</Label>
          <select
            id="screening-role"
            className={selectClass}
            value={reviewMinRole}
            onChange={(e) => setReviewMinRole(e.target.value as "BRANCH_MANAGER" | "ADMIN")}
          >
            <option value="ADMIN">Admin and above</option>
            <option value="BRANCH_MANAGER">Branch manager and above</option>
          </select>
        </div>
        {message && (
          <p className={`text-sm ${message.ok ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>{message.text}</p>
        )}
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save screening settings"}</Button>
      </CardContent>
    </Card>
  )
}
