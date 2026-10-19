"use client"

import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/**
 * The lender's opt-in for automated WhatsApp reminders. Off by default; the
 * route enforces ADMIN and audits every change.
 */
export function AutomatedWhatsAppToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/settings/automation-whatsapp", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setEnabled(d.enabled === true))
      .catch(() => setError("Could not load the setting."))
  }, [])

  async function handleChange(next: boolean) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/automation-whatsapp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) setEnabled(next)
      else setError(data.error ?? "Failed to save the setting.")
    } catch {
      setError("Failed to save the setting.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 mb-4 flex items-center justify-between gap-4">
      <div>
        <Label htmlFor="automatedWhatsAppReminders">Automated WhatsApp reminders</Label>
        <p className="text-sm text-muted-foreground">
          When off, no automation rule sends a WhatsApp message to your clients (payment due, overdue,
          paid in full). Turn on only when you want borrowers messaged automatically. Admins only;
          every change is recorded in the audit log.
        </p>
        {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
      </div>
      <span className="text-sm font-medium" data-testid="awa-state">{enabled === null ? "…" : enabled ? "On" : "Off"}</span>
      <Switch
        id="automatedWhatsAppReminders"
        checked={enabled === true}
        disabled={enabled === null || saving}
        onCheckedChange={handleChange}
      />
    </div>
  )
}
